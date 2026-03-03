// MediaStreamHandler.js (production-ready)
const WebSocket = require("ws");
const TwilioService = require("../services/TwilioService");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

// ---------------- helpers ----------------
function sanitizeForTTS(text) {
  return (text || "")
    .replace(/\(short pause\)/gi, "")
    .replace(/\(pause\)/gi, "")
    .replace(/\[.*?\]/g, "")
    .replace(/={3,}/g, "")
    .replace(/^\s*(SYS|SYSTEM|SECTION).*$/gim, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripQCBlocks(text) {
  return (text || "").replace(/<QC>[\s\S]*?<\/QC>/gi, "");
}

function safeTTS(text, maxChars = 520) {
  const t = sanitizeForTTS(text);
  if (!t) return "";
  return t.length > maxChars ? t.slice(0, maxChars).trim() : t;
}

function renderTemplate(str, vars = {}) {
  return (str || "").replace(/\$\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wordCount(s) {
  const t = (s || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------- backchannel / interruption logic ----------------
const FILLER_WORDS = [
  "okay",
  "ok",
  "k",
  "kk",
  "kay",
  "mm hmm",
  "mmhmm",
  "mhm",
  "mhmm",
  "uh huh",
  "uh-huh",
  "uhhuh",
  "yeah",
  "yep",
  "yup",
  "yes",
  "right",
  "sure",
  "alright",
  "all right",
  "got it",
  "go ahead",
  "i see",
  "understood",
  "of course",
  "fine",
  "good",
  "great",
  "perfect",
  "awesome",
  "sounds good",
  "works",
  "hmm",
  "hm",
  "mmm",
  "mm",
  "oh",
  "ah",
];

function isFillerOnly(transcriptRaw) {
  const t = norm(transcriptRaw);
  if (!t) return true;
  const tokens = t.split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  if (FILLER_WORDS.includes(t)) return true;

  if (tokens.length <= 4) {
    const reconstructedPairs = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      reconstructedPairs.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    const allOk = tokens.every((w) => FILLER_WORDS.includes(w)) ||
      tokens.every((w) => ["ok", "okay", "yeah", "yep", "yes", "right", "sure", "alright", "k", "mhm", "hm", "hmm", "mm"].includes(w)) ||
      reconstructedPairs.some((p) => FILLER_WORDS.includes(p));

    if (allOk) return true;
  } const hasFiller = FILLER_WORDS.some((f) => t === f || t.includes(f));
  if (hasFiller && tokens.length <= 3) return true;

  return false;
}
const STRONG_INTERRUPT_PHRASES = [
  "stop",
  "wait",
  "hold on",
  "hang on",
  "one sec",
  "one second",
  "pause",
  "cancel",
  "shut up",
  "quiet",
  "listen",
  "excuse me",
  "what company",
  "who is this",
  "why are you calling",
  "not interested",
  "remove me",
  "do not call",
  "dont call",
  "dnc",
  "call back",
  "im busy",
  "i am busy",
];

function isStrongInterrupt(textRaw) {
  const t = norm(textRaw);
  if (!t) return false;
  return STRONG_INTERRUPT_PHRASES.some((p) => t.includes(p));
}
const SHORT_ANSWER_REGEX =
  /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo)\.?\s*$/i;

function isShortButValidUtterance(u) {
  const t = (u || "").trim();
  if (!t) return false;
  if (SHORT_ANSWER_REGEX.test(t)) return true;
  if (/^\d{1,6}\.?\s*$/.test(t)) return true;
  return false;
}

// ---------------- simple disposition inference ----------------
function inferDispositionFromText(text) {
  const s = (text || "").toLowerCase();
  if (/\b(do not call|don't call|dnc|remove me|stop calling)\b/.test(s)) return "DNC";
  if (/\b(not interested|no thanks|stop|leave me alone)\b/.test(s)) return "NOT_INTERESTED";
  if (/\b(wrong number|misdial|wrong person)\b/.test(s)) return "MISDIALED";
  if (/\b(no english|english problem|spanish only|language)\b/.test(s)) return "LANGUAGE_BARRIER";
  if (/\b(voicemail|leave (a )?message|beep)\b/.test(s)) return "VOICEMAIL";
  return null;
}

// ---------------- opening parts ----------------
function splitOpeningInto3Parts(openingLineRaw) {
  const s = sanitizeForTTS(openingLineRaw);
  if (!s) return [];
  if (s.includes("|||")) {
    const parts = s.split("|||").map((p) => safeTTS(p)).filter(Boolean);
    return parts.slice(0, 3);
  }

  // Next: double newlines
  if (s.includes("\n\n")) {
    const parts = s.split(/\n\n+/).map((p) => safeTTS(p)).filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 3);
  }

  const sentences = s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  if (sentences.length <= 2) return [safeTTS(s)];
  const n = sentences.length;
  const a = Math.max(1, Math.floor(n / 3));
  const b = Math.max(1, Math.floor((n - a) / 2));
  const p1 = sentences.slice(0, a).join(" ");
  const p2 = sentences.slice(a, a + b).join(" ");
  const p3 = sentences.slice(a + b).join(" ");

  const parts = [safeTTS(p1), safeTTS(p2), safeTTS(p3)].filter(Boolean);
  return parts.length ? parts : [safeTTS(s)];
}

// ---------------- tuning constants ----------------
const HISTORY_LIMIT = 12;
const HISTORY_FOR_MODEL = 7;
const MIN_UTTERANCE_CHARS = 6;
const MIN_UTTERANCE_WORDS = 2;

const ECHO_GUARD_MS = 320;
const MIN_INTERRUPT_DURATION_MS = 800;
const BARGEIN_MIN_CHARS = 5;
const MID_SILENCE_CHECK_MS = 11000;
const MID_SILENCE_HANGUP_MS = 7000;
const CANT_HEAR_COOLDOWN_MS = 9000;
const CANT_HEAR_MAX_RETRIES = 2;
const HARD_FINAL_FALLBACK_MS = 2200; 

// ---------------- question detection / lock ----------------
function detectQuestionIdFromAssistantText(text) {
  const t = norm(text);
  if (/\bhow old\b|\bage\b|\byears old\b/.test(t)) return "Q1_AGE";
  if (/\bhousehold\b.*\bincome\b|\bincome\b/.test(t)) return "Q2_INCOME";
  if (/\bmedicare\b|\bmedicaid\b|\bgovernment\b.*\bcoverage\b/.test(t)) return "Q3_GOV_COVERAGE";
  if (/\bzip\b|\bpostal\b|\bzip code\b/.test(t)) return "Q_ZIP";
  if (/\bfull name\b|\byour name\b/.test(t)) return "Q_NAME";
  if (/\btransfer\b|\bconnect\b|\bline\b/.test(t)) return "Q_TRANSFER_CONFIRM";
  return null;
}

function assistantAskedAQuestion(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return /\b(can you|could you|do you|are you|what|when|where|which|how)\b/.test(norm(t));
}

class MediaStreamHandler {
  constructor(wss) {
    this.wss = wss;
    this.sessions = new Map();

    this.deepgramService = new DeepgramService();
    this.openaiService = new OpenAIService();
    this.elevenlabsService = new ElevenLabsService();
    this.campaignService = new CampaignService();

    this.twilioService = new TwilioService({
      getActiveSessionCount: () => this.sessions.size,
    });

    logger.info("MediaStreamHandler initialized");
    this.setupWebSocket();
    setInterval(() => this.cleanupInactiveSessions(), 30000);
  }

  // ----------------------- websocket -----------------------
  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const sessionId = req.url.split("/").pop();
      logger.info(`[${sessionId}] WEBSOCKET CONNECTED`);

      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));

      this.initializeSession(sessionId, ws).catch((err) =>
        logger.error(`[${sessionId}] Immediate Session Init failed: ${err.message}`)
      );

      ws.on("message", async (msg) => {
        let data;
        try {
          data = JSON.parse(msg.toString());
        } catch (e) {
          logger.error(`[${sessionId}] Message parsing error: ${e.message}`);
          return;
        }

        switch (data.event) {
          case "start": {
            const session = this.sessions.get(sessionId);
            if (!session) return;

            session.streamSid = data.start?.streamSid || session.streamSid;
            session.isTwilioReady = true;
            session.twilioStartAt = Date.now();
            session.lastActivity = Date.now();

            logger.info(`[${sessionId}] Twilio START: streamSid=${session.streamSid}`);

            this.armStartSilence(sessionId);
            this.maybePlayInitialGreeting(sessionId).catch(() => { });
            break;
          }

          case "media": {
            const session = this.sessions.get(sessionId);
            if (!session) return;

            session.lastActivity = Date.now();
            const audio = Buffer.from(data.media.payload, "base64");
            if (audio.length > 0) this.deepgramService.sendAudio(sessionId, audio);
            break;
          }

          case "stop":
            logger.info(`[${sessionId}] Twilio STOP event`);
            await this.cleanupSession(sessionId, { endedBy: "twilio_stop" });
            break;
        }
      });

      ws.on("close", () => {
        logger.info(`[${sessionId}] WebSocket closed`);
        this.cleanupSession(sessionId, { endedBy: "ws_close" });
      });

      ws.on("error", (err) => {
        logger.error(`[${sessionId}] WebSocket error: ${err.message}`);
        this.cleanupSession(sessionId, { endedBy: "ws_error" });
      });
    });
  }

  // ----------------------- session -----------------------
  createEmptySession(sessionId, ws) {
    return {
      id: sessionId,
      ws,

      callLog: null,
      campaign: null,
      systemPrompt: null,
      openingLine: null,
      agentName: "Anna",
      direction: "",

      conversationHistory: [],
      lastActivity: Date.now(),

      isTwilioReady: false,
      streamSid: null,

      dgOpenAt: 0,
      twilioStartAt: 0,

      // speaking / abort controls
      isSpeaking: false,
      ttsAbort: null,
      llmAbort: null,

      // queues
      ttsQueue: [], // items: { text, meta }
      ttsQueueRunning: false,

      // lifecycle
      isClosing: false,
      isCleaning: false,
      isProcessingUtterance: false,

      // markers
      lastSpeechAt: Date.now(),
      lastAiSpokeAt: 0,
      startTime: Date.now(),
      hasUserSpoken: false,
      initialGreetingSent: false,
      lastClearAt: 0,

      // turn ordering
      activeTurnId: 0,
      lastProcessedAt: 0,

      // echo guard anchor
      lastAiAudioSentAt: 0,

      // timers
      timers: {
        startSpeak: null,
        startHangup: null,
        midCheck: null,
        midHangup: null,
      },
      startSilenceFlowArmed: false,
      callState: {
        stage: "opening", 
        openingPartsComplete: { part1: false, part2: false, part3: false },
        awaitingAnswerFor: null,
        currentQuestion: null,
        questionsAnswered: {},
      },
      state: {
        qualified: false,
        zip: "",
        fullName: "",
        retriesCantHear: 0,
        lastCantHearAt: 0,
      },
      transcriptChunks: [],
      aiChunks: [],
      userSpeech: {
        utteranceId: 0,
        isSpeaking: false,
        bufferInterim: "",
        bufferFinal: "",
        lastInterimTime: 0,
        lastFinalTime: 0,
        startedAt: 0,

        pendingBargeIn: false,
        bargeInDecided: false,
        hardFinalFallbackTimer: null,
      },

      openingParts: [],
    };
  }

  async initializeSession(sessionId, ws) {
    logger.info(`Initializing session: ${sessionId}`);

    const callLog = await CallLog.findById(sessionId).populate("campaign");
    if (!callLog) {
      logger.error(`CallLog not found for ${sessionId}`);
      return;
    }

    const data = await this.campaignService.getCampaignWithPrompt(callLog.campaign._id);
    if (!data) return;

    const { campaign, systemPrompt, openingLine, agentName } = data;

    const existing = this.sessions.get(sessionId);
    const session = existing || this.createEmptySession(sessionId, ws);

    session.ws = ws;
    session.callLog = callLog;
    session.campaign = campaign;
    session.systemPrompt = systemPrompt;
    session.openingLine = openingLine;
    session.agentName = agentName || "Anna";
    session.direction = String(callLog.direction || callLog.Direction || "").toLowerCase().trim();
    session.openingParts = splitOpeningInto3Parts(
      renderTemplate(session.openingLine, { agentname: session.agentName })
    );

    this.sessions.set(sessionId, session);

    await this.deepgramService.createTranscriptionStream(sessionId, {
      onOpen: () => {
        const s = this.sessions.get(sessionId);
        if (s) s.dgOpenAt = Date.now();
      },
      onSpeechStarted: () => this.onUserSpeechStarted(sessionId),
      onTranscript: ({ text, isFinal, speechFinal }) =>
        this.onDeepgramTranscript(sessionId, text, isFinal, speechFinal),
    });

    logger.info(`Session initialized: ${sessionId}`);
    this.maybePlayInitialGreeting(sessionId).catch(() => { });
  }

  // ----------------------- timers -----------------------
  _clearTimer(session, key) {
    if (!session?.timers) return;
    if (session.timers[key]) {
      clearTimeout(session.timers[key]);
      session.timers[key] = null;
    }
  }

  _clearAllTimers(session) {
    if (!session?.timers) return;
    for (const k of Object.keys(session.timers)) this._clearTimer(session, k);
  }

  _setTimer(sessionId, key, ms, fn) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._clearTimer(session, key);
    session.timers[key] = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (s.isClosing || s.isCleaning) return;
      fn();
    }, ms);
  }

  _markUserActivity(session) {
    session.lastSpeechAt = Date.now();
    session.hasUserSpoken = true;

    this._clearTimer(session, "startSpeak");
    this._clearTimer(session, "startHangup");
    session.startSilenceFlowArmed = true;

    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");
  }

  // ----------------------- greeting / opening -----------------------
  async maybePlayInitialGreeting(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.initialGreetingSent) return;
    if (!session.campaign || !session.openingLine) return;

    if (!session.isTwilioReady || !session.streamSid) {
      logger.info(`[${sessionId}] Opening ready, waiting for Twilio streamSid...`);
      return;
    }

    const parts = Array.isArray(session.openingParts) && session.openingParts.length
      ? session.openingParts
      : [
        safeTTS(
          renderTemplate(session.openingLine, { agentname: session.agentName })
        ),
      ].filter(Boolean);

    if (!parts.length) return;

    session.initialGreetingSent = true;
    session.callState.stage = "opening";
    session.callState.openingPartsComplete = { part1: false, part2: false, part3: false };

    // Add to history/log as assistant said it
    parts.forEach((p) => {
      if (p) {
        session.conversationHistory.push({ role: "assistant", content: p });
        session.aiChunks.push(p);
      }
    });
    session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

    // Queue opening parts with metadata
    if (parts[0]) this.enqueueTTS(sessionId, parts[0], { flush: true, meta: { kind: "opening", part: "part1" } });
    if (parts[1]) this.enqueueTTS(sessionId, parts[1], { meta: { kind: "opening", part: "part2" } });
    if (parts[2]) this.enqueueTTS(sessionId, parts[2], { meta: { kind: "opening", part: "part3" } });

    logger.info(`[${sessionId}] Opening queued parts=${parts.length}`);

    this.armMidCallSilence(sessionId);
  }

  _onTTSItemComplete(sessionId, meta) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (meta?.kind === "opening") {
      if (meta.part && session.callState?.openingPartsComplete?.[meta.part] === false) {
        session.callState.openingPartsComplete[meta.part] = true;
      }

      const done =
        session.callState.openingPartsComplete.part1 &&
        session.callState.openingPartsComplete.part2 &&
        session.callState.openingPartsComplete.part3;

      if (done && session.callState.stage === "opening") {
        session.callState.stage = "qualification";
      }
    }

    // If assistant asked a question in this TTS item, lock which question we're awaiting
    if (meta?.assistantText) {
      const txt = meta.assistantText;
      if (assistantAskedAQuestion(txt)) {
        const qid = detectQuestionIdFromAssistantText(txt) || session.callState.currentQuestion || null;
        if (qid) {
          session.callState.currentQuestion = qid;
          session.callState.awaitingAnswerFor = qid;
        }
      }
    }
  }

  _openingDone(session) {
    const o = session.callState?.openingPartsComplete;
    return !!(o?.part1 && o?.part2 && o?.part3);
  }

  // ----------------------- START-SILENCE -----------------------
  armStartSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.startSilenceFlowArmed) return;
    session.startSilenceFlowArmed = true;

    this._setTimer(sessionId, "startSpeak", 2000, async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;

      if (s.hasUserSpoken) return;
      if (s.initialGreetingSent) return;
      if (s.isSpeaking || s.isProcessingUtterance) return;

      const fallbackParts = splitOpeningInto3Parts(
        safeTTS(
          renderTemplate(s.openingLine, { agentname: s.agentName })
        ) ||
        "Hi, this is Matt with healthcare benefits. We’re calling to offer a no-obligation quote. I just need to ask a few quick questions."
      );

      s.initialGreetingSent = true;
      s.callState.stage = "opening";
      s.callState.openingPartsComplete = { part1: false, part2: false, part3: false };

      if (fallbackParts[0]) this.enqueueTTS(sessionId, fallbackParts[0], { flush: true, meta: { kind: "opening", part: "part1" } });
      if (fallbackParts[1]) this.enqueueTTS(sessionId, fallbackParts[1], { meta: { kind: "opening", part: "part2" } });
      if (fallbackParts[2]) this.enqueueTTS(sessionId, fallbackParts[2], { meta: { kind: "opening", part: "part3" } });

      this._setTimer(sessionId, "startHangup", 12000, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        if (ss.hasUserSpoken) return;

        const dgAge = ss.dgOpenAt ? Date.now() - ss.dgOpenAt : 0;
        if (!ss.dgOpenAt || dgAge < 1500) {
          logger.info(`[${sessionId}] START-SILENCE: Deepgram not ready (${dgAge}ms) → extend`);
          this._setTimer(sessionId, "startHangup", 5000, async () => {
            const sss = this.sessions.get(sessionId);
            if (!sss) return;
            if (sss.hasUserSpoken) return;

            logger.info(`[${sessionId}] START-SILENCE: still silent → hangup`);
            sss.callLog && (sss.callLog.disposition = sss.callLog.disposition || "UNRESPONSIVE");
            await this.politeHangup(sessionId, {
              finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
            });
          });
          return;
        }

        logger.info(`[${sessionId}] START-SILENCE: still silent → hangup`);
        ss.callLog && (ss.callLog.disposition = ss.callLog.disposition || "UNRESPONSIVE");
        await this.politeHangup(sessionId, {
          finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
        });
      });
    });
  }

  // ----------------------- Deepgram events -----------------------
  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._markUserActivity(session);

    const us = session.userSpeech;
    us.utteranceId += 1;
    us.isSpeaking = true;
    us.bufferInterim = "";
    us.bufferFinal = "";
    us.lastInterimTime = Date.now();
    us.startedAt = Date.now();
    us.pendingBargeIn = session.isSpeaking; // only relevant if AI is speaking
    us.bargeInDecided = false;

    if (us.hardFinalFallbackTimer) {
      clearTimeout(us.hardFinalFallbackTimer);
      us.hardFinalFallbackTimer = null;
    }
    us.hardFinalFallbackTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      const uu = s.userSpeech;
      if (!uu) return;
      if (!uu.isSpeaking) return;
      const quietFor = Date.now() - (uu.lastInterimTime || 0);
      if (quietFor < 650) return;
      const maybe = (uu.bufferFinal || uu.bufferInterim || "").trim();
      if (!maybe) return;

      logger.info(`[${sessionId}] HARD_FINAL_FALLBACK: forcing finalize "${maybe}"`);
      // treat as final for pipeline safety
      this._finalizeUtterance(sessionId, { reason: "hard_final_fallback", utteranceId: uu.utteranceId, finalText: maybe });
    }, HARD_FINAL_FALLBACK_MS);
  }

 onDeepgramTranscript(sessionId, text, isFinal, speechFinal) {
  const session = this.sessions.get(sessionId);
  if (!session) return;

  const trimmed = (text || "").trim();
  if (!trimmed) return;

  this._markUserActivity(session);

  const us = session.userSpeech;
  us.lastInterimTime = Date.now();
  us.bufferInterim = trimmed;

  // Keep final buffer for finalize path
  if (isFinal || speechFinal) {
    us.bufferFinal = trimmed;
    us.lastFinalTime = Date.now();
  }

  // While AI is speaking, decide whether this should barge-in
  if (session.isSpeaking && us.pendingBargeIn && !us.bargeInDecided) {
    const sinceAiAudio = Date.now() - (session.lastAiAudioSentAt || 0);
    if (sinceAiAudio >= ECHO_GUARD_MS) {
      const spokenFor = Date.now() - (us.startedAt || Date.now());
      const strong = isStrongInterrupt(trimmed);
      const fillerOnly = isFillerOnly(trimmed);

      const canBarge =
        strong ||
        (spokenFor >= MIN_INTERRUPT_DURATION_MS &&
          !fillerOnly &&
          (trimmed.length >= BARGEIN_MIN_CHARS || wordCount(trimmed) >= 2));

      if (canBarge) {
        us.bargeInDecided = true;
        us.pendingBargeIn = false;

        logger.info(
          `[${sessionId}] BARGE-IN → stop TTS (strong=${strong}, spokenFor=${spokenFor}ms, text="${trimmed}")`
        );
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
      }
    }
  }
  if (speechFinal || isFinal) {
    this._finalizeUtterance(sessionId, {
      reason: speechFinal ? "speech_final" : "is_final",
      utteranceId: us.utteranceId,
      finalText: trimmed,
    });
  }
}

  _finalizeUtterance(sessionId, { reason, utteranceId, finalText }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const us = session.userSpeech;
    if (!us || utteranceId !== us.utteranceId) return;

    if (us.hardFinalFallbackTimer) {
      clearTimeout(us.hardFinalFallbackTimer);
      us.hardFinalFallbackTimer = null;
    }

    const utterance = (finalText || us.bufferFinal || "").trim();
    const interim = (us.bufferInterim || "").trim();

    us.isSpeaking = false;
    us.pendingBargeIn = false;

    if (!utterance) {
      logger.info(`[${sessionId}] Finalize(${reason}) ignored (no final text). interim="${interim}"`);
      return;
    }

    const shortValid = isShortButValidUtterance(utterance);

    if (!shortValid) {
      if (utterance.length < MIN_UTTERANCE_CHARS && wordCount(utterance) < MIN_UTTERANCE_WORDS) {
        logger.info(`[${sessionId}] Drop tiny final utterance (${reason}): "${utterance}"`);
        return;
      }
      if (/^(?:a|h)\.?$/i.test(utterance)) {
        logger.info(`[${sessionId}] Drop noise utterance (${reason}): "${utterance}"`);
        return;
      }
    }

    logger.info(`[${sessionId}] Finalized utterance (${reason}): "${utterance}"`);
    session.lastProcessedAt = Date.now();

    session.transcriptChunks.push(utterance);
    if (session.transcriptChunks.length > 100) session.transcriptChunks.shift();

    if (session.callState?.stage === "opening" && !this._openingDone(session)) {
      if (isStrongInterrupt(utterance)) {        return this.handleUserUtterance(sessionId, utterance).catch((e) => {
          if (e?.name !== "AbortError") logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
        });
      }

      if (isFillerOnly(utterance) || isShortButValidUtterance(utterance) || wordCount(utterance) <= 5) {
        logger.info(`[${sessionId}] Opening-stage customer speech ignored: "${utterance}"`);
        this._resumeOpeningIfNeeded(sessionId);
        return;
      }

      // Longer but non-objection speech during opening: still do NOT trigger LLM (prevents stage skipping).
      logger.info(`[${sessionId}] Opening-stage non-objection ignored (no LLM): "${utterance}"`);
      this._resumeOpeningIfNeeded(sessionId);
      return;
    }

    // Normal flow
    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
      }
    });
  }

  _resumeOpeningIfNeeded(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;
    if (session.callState?.stage !== "opening") return;

    // If opening audio was cleared/stopped, ensure remaining parts are queued.
    const parts = session.openingParts || [];
    const oc = session.callState.openingPartsComplete || {};

    const needs1 = parts[0] && !oc.part1;
    const needs2 = parts[1] && !oc.part2;
    const needs3 = parts[2] && !oc.part3;

    if (!needs1 && !needs2 && !needs3) return;

    // Do not duplicate if queue already contains opening items
    const hasOpeningQueued = session.ttsQueue.some((it) => it?.meta?.kind === "opening");
    if (hasOpeningQueued || session.isSpeaking) return;

    if (needs1) this.enqueueTTS(sessionId, parts[0], { flush: false, meta: { kind: "opening", part: "part1" } });
    if (needs2) this.enqueueTTS(sessionId, parts[1], { flush: false, meta: { kind: "opening", part: "part2" } });
    if (needs3) this.enqueueTTS(sessionId, parts[2], { flush: false, meta: { kind: "opening", part: "part3" } });

    logger.info(`[${sessionId}] Resumed remaining opening parts`);
  }

  // ----------------------- TTS pipeline -----------------------
  enqueueTTS(sessionId, text, { flush = false, meta = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const t = safeTTS(text);
    if (!t) return;

    if (flush) session.ttsQueue.length = 0;
    session.ttsQueue.push({ text: t, meta: meta || {} });

    session.aiChunks.push(t);
    if (session.aiChunks.length > 140) session.aiChunks.shift();

    this.runTTSQueue(sessionId).catch((e) => {
      if (e?.name !== "AbortError") logger.error(`[${sessionId}] runTTSQueue error: ${e.message}`);
    });
  }

  async runTTSQueue(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttsQueueRunning) return;

    session.ttsQueueRunning = true;

    try {
      while (session.ttsQueue.length > 0) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        if (s.isClosing || s.isCleaning) return;

        const item = s.ttsQueue.shift();
        const textToSpeak = item?.text;
        const meta = item?.meta || {};

        if (!textToSpeak) continue;

        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          await sleep(35);
          s.ttsQueue.unshift(item);
          continue;
        }

        const audioStream = await this.getAudioStream(sessionId, textToSpeak);
        if (!audioStream) continue;

        // store assistantText in meta for question lock updates
        meta.assistantText = textToSpeak;

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

        // mark completion hooks
        this._onTTSItemComplete(sessionId, meta);

        this.armMidCallSilence(sessionId);
      }
    } finally {
      const s = this.sessions.get(sessionId);
      if (s) s.ttsQueueRunning = false;
    }
  }

  async getAudioStream(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session?.campaign) return null;

    const finalText = safeTTS(text);
    if (!finalText) return null;

    const t0 = Date.now();
    try {
      const stream = await this.elevenlabsService.streamTextToSpeechFast(
        finalText,
        session.campaign.voiceId,
        session.campaign.voiceSettings
      );
      logger.info(`[${sessionId}] TTS_STREAM_RECEIVED latency=${Date.now() - t0}ms`);
      return stream;
    } catch (e) {
      logger.error(`[${sessionId}] ElevenLabs Request Failed: ${e.message}`);
      if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      return null;
    }
  }

  async streamDirectULawToTwilioWithBargeIn(sessionId, audioStream) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    const ac = new AbortController();
    session.ttsAbort = ac;
    session.isSpeaking = true;
    session.lastAiSpokeAt = Date.now();

    const FRAME_BYTES = 160; // 20ms mulaw @ 8khz
    const FRAME_MS = 20;

    let buffer = Buffer.alloc(0);
    let ended = false;
    let frameCount = 0;

    const onData = (chunk) => {
      if (!chunk || !chunk.length) return;
      buffer = Buffer.concat([buffer, chunk]);
    };
    const onEnd = () => {
      ended = true;
    };
    const onError = () => {
      ended = true;
    };

    audioStream.on("data", onData);
    audioStream.on("end", onEnd);
    audioStream.on("error", onError);

    try {
      while (!ac.signal.aborted) {
        if (buffer.length >= FRAME_BYTES) {
          const frame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);

          session.ws.send(
            JSON.stringify({
              event: "media",
              streamSid: session.streamSid,
              media: { payload: frame.toString("base64") },
            })
          );

          session.lastAiAudioSentAt = Date.now();
          frameCount++;
          await sleep(FRAME_MS);
          continue;
        }

        if (ended) break;
        await sleep(5);
      }
    } finally {
      try {
        audioStream.off("data", onData);
        audioStream.off("end", onEnd);
        audioStream.off("error", onError);
      } catch { }

      try {
        audioStream.destroy();
      } catch { }

      session.isSpeaking = false;
      session.ttsAbort = null;

      logger.info(`[${sessionId}] Paced audio done. frames=${frameCount}`);
    }
  }

  // ----------------------- LLM (fast + ordered) -----------------------
  _buildSystemPrompt(session, { answerFor = null } = {}) {
    let systemPrompt =
      session.systemPrompt ||
      "You are a natural phone agent. Reply briefly and ask one short question.";

    const cs = session.callState || {};
    const openingDone = this._openingDone(session);

    const injectedState =
      `\n\n[CURRENT CALL STATE - DO NOT READ ALOUD]\n` +
      `Stage: ${cs.stage}\n` +
      `Opening Part 1 Complete: ${!!cs.openingPartsComplete?.part1}\n` +
      `Opening Part 2 Complete: ${!!cs.openingPartsComplete?.part2}\n` +
      `Opening Part 3 Complete: ${!!cs.openingPartsComplete?.part3}\n` +
      `Opening Done: ${openingDone}\n` +
      `Currently waiting for answer to: ${cs.awaitingAnswerFor || "none"}\n` +
      `Questions answered: ${JSON.stringify(cs.questionsAnswered || {})}\n`;

    // Question lock (if provided)
    let lockRules = "";
    const lockId = answerFor || cs.awaitingAnswerFor;
    if (lockId) {
      lockRules =
        `\n[QUESTION LOCK]\n` +
        `The customer's next response is ONLY an answer to ${lockId}.\n` +
        `Do NOT interpret it as an answer to any other question.\n` +
        `Ask ONLY ONE next question.\n`;
    }

    // Stage rules
    let stageRules = "";
    if (!openingDone) {
      stageRules =
        `\n[OPENING RULE]\n` +
        `You MUST NOT jump to qualification questions until all 3 opening parts are complete.\n` +
        `If the customer asks "who is this/what company/stop/not interested/do not call", respond to that.\n` +
        `Otherwise continue the opening flow.\n`;
    }

    const st = session.state || {};
    const stateLine =
      `\n[INTERNAL VARIABLES]\n` +
      `qualified=${!!st.qualified}; zip=${st.zip || ""}; fullName=${st.fullName || ""}\n`;

    return `${injectedState}${lockRules}${stageRules}${stateLine}\n\n${systemPrompt}`;
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    // Latest user input wins
    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    if (session.llmAbort) {
      try {
        session.llmAbort.abort();
      } catch { }
    }
    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;

    session.activeTurnId += 1;
    const myTurnId = session.activeTurnId;

    const t0 = Date.now();

    try {
      const answerFor = session.callState?.awaitingAnswerFor || null;
      const systemPrompt = this._buildSystemPrompt(session, { answerFor });
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(`[${sessionId}] LLM_START turn=${myTurnId} answerFor=${answerFor || "none"} input="${userText}"`);

      let fullText = "";
      let firstTokenAt = 0;

      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        if (s.activeTurnId !== myTurnId) return;
        if (llmController.signal.aborted) return;

        const sanitized = safeTTS(sentence);
        if (!sanitized) return;

        // avoid ultra-short fragments
        if (sanitized.length < 10 && !/[.!?]$/.test(sanitized)) return;

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}: "${sanitized}"`);
        this.enqueueTTS(sessionId, sanitized);
      });

      chunker.minChunkLength = 18;
      chunker.maxChunkLength = 140;

      for await (const delta of this.openaiService.streamResponse(
        userText,
        systemPrompt,
        historyForModel,
        llmController.signal
      )) {
        const s = this.sessions.get(sessionId);
        if (!s) break;
        if (s.activeTurnId !== myTurnId) break;
        if (llmController.signal.aborted) break;

        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          logger.info(`[${sessionId}] LATENCY turn=${myTurnId}: first_token=${firstTokenAt - t0}ms`);
        }

        const cleanDelta = stripQCBlocks(delta);
        fullText += delta;
        chunker.add(cleanDelta);
      }

      chunker.end();

      const total = Date.now() - t0;
      logger.info(`[${sessionId}] LLM_COMPLETE turn=${myTurnId} total=${total}ms`);

      const aiText = sanitizeForTTS(fullText);

      // Save history
      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
      }

      // ✅ BUG 3: Update question lock safely (answer applies ONLY to one question)
      if (answerFor) {
        session.callState.questionsAnswered[answerFor] = userText;
        session.callState.awaitingAnswerFor = null; // clear lock after we processed one answer
      }

      // Detect next question asked by assistant; set new lock (prevents contamination)
      if (aiText && assistantAskedAQuestion(aiText)) {
        const nextQ = detectQuestionIdFromAssistantText(aiText);
        if (nextQ) {
          session.callState.currentQuestion = nextQ;
          session.callState.awaitingAnswerFor = nextQ;
        }
      }

      // reset cant-hear retries
      session.state.retriesCantHear = 0;
    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance error: ${e.message}`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      }
    } finally {
      const s = this.sessions.get(sessionId);
      if (s && s.activeTurnId === myTurnId) {
        s.isProcessingUtterance = false;
        s.llmAbort = null;
      } else if (s) {
        s.isProcessingUtterance = false;
      }
    }
  }

  // ----------------------- mid-call silence -----------------------
  armMidCallSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");

    this._setTimer(sessionId, "midCheck", MID_SILENCE_CHECK_MS, async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (s.isClosing || s.isCleaning) return;

      const sinceSpeech = Date.now() - (s.lastSpeechAt || 0);
      if (s.isSpeaking || s.isProcessingUtterance) return;

      const us = s.userSpeech;
      const sinceInterim = us?.lastInterimTime ? Date.now() - us.lastInterimTime : 999999;
      if (sinceInterim < 2500) return;
      if (sinceSpeech < 3500) return;

      await this._maybeCantHearOrPrompt(sessionId);
    });
  }

  async _maybeCantHearOrPrompt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const now = Date.now();
    const st = session.state;

    if (st.lastCantHearAt && now - st.lastCantHearAt < CANT_HEAR_COOLDOWN_MS) {
      this.enqueueTTS(sessionId, "Are you still there?", { flush: true });
    } else {
      const sinceSpeech = now - (session.lastSpeechAt || 0);
      const sinceInterim = session.userSpeech?.lastInterimTime
        ? now - session.userSpeech.lastInterimTime
        : 999999;

      if (sinceSpeech > 8000 && sinceInterim > 8000) {
        st.retriesCantHear = (st.retriesCantHear || 0) + 1;
        st.lastCantHearAt = now;

        if (st.retriesCantHear <= CANT_HEAR_MAX_RETRIES) {
          this.enqueueTTS(sessionId, "Sorry, I can't hear you. Can you speak up?", { flush: true });
        } else {
          if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "UNRESPONSIVE";
          await this.politeHangup(sessionId, { finalMessage: "Sorry, I still can't hear you. Goodbye." });
          return;
        }
      } else {
        this.enqueueTTS(sessionId, "Are you still there?", { flush: true });
      }
    }

    this._setTimer(sessionId, "midHangup", MID_SILENCE_HANGUP_MS, async () => {
      const ss = this.sessions.get(sessionId);
      if (!ss) return;
      if (ss.isClosing || ss.isCleaning) return;

      const now2 = Date.now();
      const sinceSpeech2 = now2 - (ss.lastSpeechAt || 0);
      const sinceInterim2 = ss.userSpeech?.lastInterimTime
        ? now2 - ss.userSpeech.lastInterimTime
        : 999999;

      if (sinceSpeech2 < 3500 || sinceInterim2 < 3500) return;
      if (ss.isSpeaking || ss.isProcessingUtterance) return;

      logger.info(`[${sessionId}] MID-SILENCE: still silent → hangup`);
      if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "UNRESPONSIVE";
      await this.politeHangup(sessionId, { finalMessage: "Okay, I'll let you go. Goodbye." });
    });
  }

  // ----------------------- stop + clear -----------------------
  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.ttsAbort) {
      try {
        session.ttsAbort.abort();
      } catch { }
      session.ttsAbort = null;
    }
    session.isSpeaking = false;

    if (session.llmAbort) {
      try {
        session.llmAbort.abort();
      } catch { }
      session.llmAbort = null;
    }

    session.ttsQueue.length = 0;
  }

  sendClearToTwilio(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.ws || !session.streamSid) return;

    const now = Date.now();
    if (now - (session.lastClearAt || 0) < 250) return;
    session.lastClearAt = now;

    try {
      session.ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
      logger.info(`[${sessionId}] Sent clear to Twilio`);
    } catch (e) {
      logger.error(`[${sessionId}] clear send failed: ${e.message}`);
    }
  }

  async _waitForTTSIdle(sessionId, timeoutMs = 9000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (!s.isSpeaking && !s.ttsQueueRunning && s.ttsQueue.length === 0) return;
      await sleep(50);
    }
  }

  // ----------------------- hangup + cleanup -----------------------
  async endTwilioCall(sessionId) {
    const session = this.sessions.get(sessionId);
    const callSid = session?.callLog?.callSid;
    if (!callSid) return;
    await this.twilioService.endCallHard(callSid);
  }

  async politeHangup(sessionId, { finalMessage } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing) return;

    session.isClosing = true;
    this._clearAllTimers(session);

    try {
      if (finalMessage) {
        this.enqueueTTS(sessionId, finalMessage, { flush: true });
        await this._waitForTTSIdle(sessionId, 9000);
      }
    } catch { }

    await this.endTwilioCall(sessionId);
    await this.cleanupSession(sessionId, { endedBy: "polite_hangup" });
  }

  _buildTranscriptForLog(session) {
    return (session.transcriptChunks || []).join(" | ").trim();
  }

  async cleanupSession(sessionId, { endedBy } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isCleaning) return;

    session.isCleaning = true;
    logger.info(`Cleaning session: ${sessionId}`);

    try {
      this._clearAllTimers(session);
      this.stopTTS(sessionId);
    } catch { }

    try {
      this.deepgramService.closeTranscriptionStream(sessionId);
    } catch { }

    // Persist call log
    try {
      if (session.callLog) {
        const now = Date.now();
        const durationApprox = Math.floor((now - session.startTime) / 1000);

        if (!session.callLog.duration || session.callLog.duration === 0) {
          session.callLog.duration = durationApprox;
        }

        session.callLog.endTime = session.callLog.endTime || new Date(now);

        const transcript = this._buildTranscriptForLog(session);
        if (transcript) session.callLog.transcript = transcript;

        if (Array.isArray(session.aiChunks) && session.aiChunks.length) {
          session.callLog.aiResponses = session.aiChunks.slice(-50);
        }

        if (!session.callLog.disposition) {
          const inferred = inferDispositionFromText(
            `${transcript} ${session.aiChunks.slice(-25).join(" ")}`
          );
          if (inferred) session.callLog.disposition = inferred;
        }

        if (!session.callLog.disposition) {
          if (endedBy === "twilio_stop" || endedBy === "ws_close") {
            session.callLog.disposition = "TARGET_HUNG_UP";
          } else if (endedBy === "ws_error") {
            session.callLog.disposition = "TECH_ISSUES";
          } else {
            session.callLog.disposition = "TECH_ISSUES";
          }
        }

        await session.callLog.save();
      }
    } catch (e) {
      logger.error(`[${sessionId}] callLog save failed: ${e.message}`);
    }

    try {
      if (session.ws?.readyState === WebSocket.OPEN) session.ws.close();
    } catch { }

    this.sessions.delete(sessionId);
    logger.info(`Session cleaned: ${sessionId}`);
  }

  cleanupInactiveSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > 300000) {
        logger.warn(`Cleaning inactive session: ${sessionId}`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "UNRESPONSIVE";
        this.cleanupSession(sessionId, { endedBy: "inactive_cleanup" });
      }
    }
  }
}

module.exports = MediaStreamHandler;