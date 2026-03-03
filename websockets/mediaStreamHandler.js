// MediaStreamHandler.js — production v4

const WebSocket = require("ws");
const TwilioService = require("../services/TwilioService");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

// ─────────────────────────── helpers ──────────────────────────────────────
function sanitizeForTTS(text) {
  return (text || "")
    .replace(/\(short pause\)/gi, "")
    .replace(/\(pause\)/gi, "")
    // Only strip uppercase/system bracket tags — NOT ElevenLabs laughter tags
    .replace(/\[(SYSTEM|SYS|STAGE|QC|SECTION|NOTE|INTERNAL)[^\]]*\]/gi, "")
    .replace(/={3,}/g, "")
    .replace(/^\s*(SYS|SYSTEM|SECTION).*$/gim, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripQCBlocks(text) {
  return (text || "").replace(/<QC>[\s\S]*?<\/QC>/gi, "");
}

// safeTTS: pass through laughter tags, only hard-limit length
function safeTTS(text, maxChars = 500) {
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
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

// ─── A) FILLER / BACKCHANNEL ───────────────────────────────────────────────
const FILLER_REGEX =
  /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo|hmm|hm|mmm|mm|mhm|mhmm|uh huh|uh-huh|uhhuh|uh|um|erm|go ahead|please|continue|and|so|well|but|okay go ahead|sure go ahead|go on|keep going|i'm here|im here|still here|i hear you|i got you|gotcha)\.?\s*$/i;

function isFiller(text) { return FILLER_REGEX.test((text || "").trim()); }

function isShortButValidUtterance(u) {
  const t = (u || "").trim();
  if (!t) return false;
  if (FILLER_REGEX.test(t)) return true;
  if (/^\d{1,6}\.?\s*$/.test(t)) return true;
  return false;
}

const INTERRUPT_COMMAND_REGEX =
  /^(?:stop|wait|hold on|hang on|one sec|one second|listen|excuse me|shut up|pause|cancel|quiet|i have a question|can i ask|let me ask|actually|wait wait)\b/i;
const BARGEIN_MIN_WORDS_REAL = 3;
const BARGEIN_MIN_CHARS_REAL = 15;

function isStrongInterrupt(text) {
  const t = (text || "").trim();
  if (INTERRUPT_COMMAND_REGEX.test(t)) return true;
  if (wordCount(t) >= BARGEIN_MIN_WORDS_REAL && !isFiller(t)) return true;
  return false;
}

// ─── F) DISPOSITION ────────────────────────────────────────────────────────
function inferDispositionFromText(text) {
  const s = (text || "").toLowerCase();
  if (/\b(do not call|don't call|dnc|remove me|stop calling)\b/.test(s)) return "DNC";
  if (/\b(not interested|no thanks|stop|leave me alone)\b/.test(s)) return "NOT_INTERESTED";
  if (/\b(wrong number|misdial|wrong person)\b/.test(s)) return "MISDIALED";
  if (/\b(no english|english problem|spanish only|language)\b/.test(s)) return "LANGUAGE_BARRIER";
  if (/\b(voicemail|leave (a )?message|beep)\b/.test(s)) return "VOICEMAIL";
  return null;
}

function buildDispositionObject(session, endedBy) {
  const st = session.state || {};
  const transcript = (session.transcriptChunks || []).join(" | ").trim();
  let status = session.callLog?.disposition || null;
  if (!status) {
    const inferred = inferDispositionFromText(`${transcript} ${(session.aiChunks || []).slice(-25).join(" ")}`);
    status = inferred || (endedBy === "ws_error" ? "TECH_ISSUES" : "TARGET_HUNG_UP");
  }
  return {
    status,
    stage: session.currentStage || "unknown",
    qualified: !!st.qualified,
    zip: st.zip || "",
    fullName: st.fullName || "",
    capturedAnswers: st.capturedAnswers || {},
    endedBy: endedBy || "unknown",
    durationMs: Date.now() - (session.startTime || Date.now()),
    transcriptSummary: transcript.slice(0, 400),
  };
}

// ─────────────────────────── tuning constants ──────────────────────────────
const UTTERANCE_DEBOUNCE_MS = 600;
const UTTERANCE_HARD_MAX_MS = 1800;
const MIN_UTTERANCE_CHARS = 6;
const MIN_UTTERANCE_WORDS = 2;
const ECHO_GUARD_MS = 300;
const BARGEIN_CONFIRM_MS = 180;
const MID_SILENCE_CHECK_MS = 11000;
const MID_SILENCE_HANGUP_MS = 7000;
const CANT_HEAR_COOLDOWN_MS = 9000;
const CANT_HEAR_MAX_RETRIES = 2;
const HISTORY_LIMIT = 10;
const HISTORY_FOR_MODEL = 6;

// ───────────────────────────────────────────────────────────────────────────
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

  // ─── WEBSOCKET ────────────────────────────────────────────────────────────
  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const sessionId = req.url.split("/").pop();
      logger.info(`[${sessionId}] WEBSOCKET CONNECTED`);
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));

      this.initializeSession(sessionId, ws).catch((err) =>
        logger.error(`[${sessionId}] Session Init failed: ${err.message}`)
      );

      ws.on("message", async (msg) => {
        let data;
        try { data = JSON.parse(msg.toString()); } catch (e) {
          logger.error(`[${sessionId}] Message parse error: ${e.message}`); return;
        }
        switch (data.event) {
          case "start": {
            const session = this.sessions.get(sessionId);
            if (!session) return;
            session.streamSid = data.start?.streamSid || session.streamSid;
            session.isTwilioReady = true;
            session.twilioStartAt = Date.now();
            session.lastActivity = Date.now();
            logger.info(`[${sessionId}] Twilio START streamSid=${session.streamSid}`);
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
            logger.info(`[${sessionId}] Twilio STOP`);
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

  // ─── SESSION ──────────────────────────────────────────────────────────────
  createEmptySession(sessionId, ws) {
    return {
      id: sessionId,
      ws,
      callLog: null,
      campaign: null,
      systemPrompt: null,
      openingLine: null,
      agentName: "Matt",
      direction: "",
      conversationHistory: [],
      lastActivity: Date.now(),
      isTwilioReady: false,
      streamSid: null,
      dgOpenAt: 0,
      twilioStartAt: 0,
      isSpeaking: false,
      ttsAbort: null,
      llmAbort: null,
      ttsQueue: [],
      ttsQueueRunning: false,
      isClosing: false,
      isCleaning: false,
      isProcessingUtterance: false,
      lastSpeechAt: Date.now(),
      lastAiSpokeAt: 0,
      startTime: Date.now(),
      hasUserSpoken: false,
      initialGreetingSent: false,
      lastClearAt: 0,
      activeTurnId: 0,
      lastProcessedAt: 0,
      lastAiAudioSentAt: 0,
      timers: { startSpeak: null, startHangup: null, midCheck: null, midHangup: null },
      startSilenceFlowArmed: false,
      currentStage: "greeting",
      openingComplete: false,
      awaitingAnswerFor: null,
      questionsAnswered: {},
      // Track which Q number we're on so the LLM never goes backwards
      currentQuestionNum: 0,
      state: {
        qualified: false,
        zip: "",
        fullName: "",
        email: "",
        retriesCantHear: 0,
        lastCantHearAt: 0,
        capturedAnswers: {},
        // Qualification flags — set as each Q is answered
        ageQualified: null,        // true/false/null
        incomeQualified: null,
        govCoverageQualified: null,
        employerCoverageQualified: null,
        bankAccountQualified: null,
        subsidyCheckQualified: null,
      },
      transcriptChunks: [],
      aiChunks: [],
      userSpeech: {
        utteranceId: 0,
        isSpeaking: false,
        buffer: "",
        lastInterimTime: 0,
        startedAt: 0,
        finalizeTimer: null,
        hardMaxTimer: null,
        pendingBargeIn: false,
        bargeInConfirmTimer: null,
      },
    };
  }

  async initializeSession(sessionId, ws) {
    logger.info(`Initializing session: ${sessionId}`);
    const callLog = await CallLog.findById(sessionId).populate("campaign");
    if (!callLog) { logger.error(`CallLog not found for ${sessionId}`); return; }

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
    session.agentName = agentName || "Matt";
    session.direction = String(callLog.direction || callLog.Direction || "").toLowerCase().trim();
    this.sessions.set(sessionId, session);

    await this.deepgramService.createTranscriptionStream(sessionId, {
      onOpen: () => { const s = this.sessions.get(sessionId); if (s) s.dgOpenAt = Date.now(); },
      onSpeechStarted: () => this.onUserSpeechStarted(sessionId),
      onTranscript: ({ text, isFinal, speechFinal }) =>
        this.onDeepgramTranscript(sessionId, text, isFinal, speechFinal),
    });

    logger.info(`Session initialized: ${sessionId}`);
    this.maybePlayInitialGreeting(sessionId).catch(() => { });
  }

  // ─── TIMERS ───────────────────────────────────────────────────────────────
  _clearTimer(session, key) {
    if (!session?.timers) return;
    if (session.timers[key]) { clearTimeout(session.timers[key]); session.timers[key] = null; }
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
      if (!s || s.isClosing || s.isCleaning) return;
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

  // ─── GREETING ────────────────────────────────────────────────────────────
  async maybePlayInitialGreeting(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.initialGreetingSent) return;
    if (!session.campaign || !session.openingLine) return;
    if (!session.isTwilioReady || !session.streamSid) {
      logger.info(`[${sessionId}] Greeting ready — waiting for streamSid`);
      return;
    }

    const greetingText = safeTTS(renderTemplate(session.openingLine, { agentname: session.agentName }));
    if (!greetingText) return;

    session.initialGreetingSent = true;
    session.currentStage = "greeting";
    session.openingComplete = false;

    session.conversationHistory.push({ role: "assistant", content: greetingText });
    session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
    session.aiChunks.push(greetingText);

    logger.info(`[${sessionId}] Playing greeting: "${greetingText}"`);

    this.enqueueTTS(sessionId, greetingText, {
      flush: true,
      onComplete: () => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.openingComplete = true;
        s.currentStage = "qualification";
        s.currentQuestionNum = 1; // Ready for Q1
        logger.info(`[${sessionId}] Opening done → qualification (Q1 next)`);
        this.armMidCallSilence(sessionId);
      },
    });
  }

  // ─── START-SILENCE ────────────────────────────────────────────────────────
  armStartSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.startSilenceFlowArmed) return;
    session.startSilenceFlowArmed = true;

    this._setTimer(sessionId, "startSpeak", 1800, async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.hasUserSpoken || s.initialGreetingSent || s.isSpeaking) return;

      const fallback =
        safeTTS(renderTemplate(s.openingLine, { agentname: s.agentName })) ||
        "Hi, thank you for taking the call. This is Matt with healthcare benefits. How are you doing today?";

      s.initialGreetingSent = true;
      s.currentStage = "greeting";
      s.openingComplete = false;
      s.aiChunks.push(fallback);

      this.enqueueTTS(sessionId, fallback, {
        flush: true,
        onComplete: () => {
          const ss = this.sessions.get(sessionId);
          if (!ss) return;
          ss.openingComplete = true;
          ss.currentStage = "qualification";
          ss.currentQuestionNum = 1;
          logger.info(`[${sessionId}] Fallback greeting done → qualification (Q1 next)`);
          this.armMidCallSilence(sessionId);
        },
      });

      this._setTimer(sessionId, "startHangup", 12000, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss || ss.hasUserSpoken) return;
        const dgAge = ss.dgOpenAt ? Date.now() - ss.dgOpenAt : 0;
        if (!ss.dgOpenAt || dgAge < 1500) {
          this._setTimer(sessionId, "startHangup", 5000, async () => {
            const sss = this.sessions.get(sessionId);
            if (!sss || sss.hasUserSpoken) return;
            if (sss.callLog && !sss.callLog.disposition) sss.callLog.disposition = "UNRESPONSIVE";
            await this.politeHangup(sessionId, { finalMessage: "Sorry, I can not hear you. Goodbye." });
          });
          return;
        }
        if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "UNRESPONSIVE";
        await this.politeHangup(sessionId, { finalMessage: "Sorry, I can not hear you. Goodbye." });
      });
    });
  }

  // ─── DEEPGRAM ─────────────────────────────────────────────────────────────
  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._markUserActivity(session);

    const us = session.userSpeech;
    us.utteranceId += 1;
    us.isSpeaking = true;
    us.buffer = "";
    us.lastInterimTime = Date.now();
    us.startedAt = Date.now();

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us.hardMaxTimer) { clearTimeout(us.hardMaxTimer); us.hardMaxTimer = null; }

    us.hardMaxTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, { reason: "hard_max", utteranceId: us.utteranceId });
    }, UTTERANCE_HARD_MAX_MS);

    if (session.isSpeaking) {
      const sinceAiAudio = Date.now() - (session.lastAiAudioSentAt || 0);
      if (sinceAiAudio < ECHO_GUARD_MS) return;

      us.pendingBargeIn = true;
      if (us.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }

      us.bargeInConfirmTimer = setTimeout(() => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        const uus = ss.userSpeech;
        if (uus.pendingBargeIn && (uus.buffer || "").trim().length < BARGEIN_MIN_CHARS_REAL) {
          uus.pendingBargeIn = false;
          logger.info(`[${sessionId}] Barge-in cancelled (too short)`);
        }
      }, BARGEIN_CONFIRM_MS);
    }
  }

  onDeepgramTranscript(sessionId, text, isFinal, speechFinal) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const trimmed = (text || "").trim();
    if (!trimmed) return;

    this._markUserActivity(session);
    const us = session.userSpeech;
    us.lastInterimTime = Date.now();
    us.buffer = trimmed;

    if (session.isSpeaking && us.pendingBargeIn) {
      if (isFiller(trimmed)) {
        us.pendingBargeIn = false;
        logger.info(`[${sessionId}] Barge-in suppressed (filler): "${trimmed}"`);
      } else if (isStrongInterrupt(trimmed)) {
        logger.info(`[${sessionId}] BARGE-IN: strong interrupt`);
        us.pendingBargeIn = false;
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
      }
    }

    // Only FINAL triggers a turn
    if (!isFinal && !speechFinal) {
      if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
      return;
    }

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    this._finalizeUtterance(sessionId, {
      reason: speechFinal ? "speech_final" : "is_final",
      utteranceId: us.utteranceId,
    });
  }

  _finalizeUtterance(sessionId, { reason, utteranceId }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    const us = session.userSpeech;
    if (utteranceId !== us.utteranceId) return;

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us.hardMaxTimer) { clearTimeout(us.hardMaxTimer); us.hardMaxTimer = null; }
    if (us.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }
    us.pendingBargeIn = false;

    const utterance = (us.buffer || "").trim();
    us.isSpeaking = false;
    us.buffer = "";
    if (!utterance) return;

    const shortValid = isShortButValidUtterance(utterance);
    if (!shortValid) {
      if (utterance.length < MIN_UTTERANCE_CHARS && wordCount(utterance) < MIN_UTTERANCE_WORDS) {
        logger.info(`[${sessionId}] Drop tiny (${reason}): "${utterance}"`);
        return;
      }
      if (/^(?:a|h)\.?$/i.test(utterance)) {
        logger.info(`[${sessionId}] Drop noise (${reason}): "${utterance}"`);
        return;
      }
    }

    logger.info(`[${sessionId}] Finalized (${reason}): "${utterance}"`);
    session.lastProcessedAt = Date.now();
    session.transcriptChunks.push(utterance);
    if (session.transcriptChunks.length > 80) session.transcriptChunks.shift();

    if (!session.openingComplete) {
      if (isStrongInterrupt(utterance) && !isFiller(utterance)) {
        logger.info(`[${sessionId}] Opening not done — strong interrupt, processing anyway`);
      } else {
        logger.info(`[${sessionId}] Opening not complete — buffering: "${utterance}"`);
        return;
      }
    }

    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError")
        logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
    });
  }

  // ─── TTS PIPELINE ─────────────────────────────────────────────────────────
  enqueueTTS(sessionId, text, { flush = false, onComplete = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) {
      if (onComplete) onComplete();
      return;
    }
    const t = safeTTS(text);
    if (!t) { if (onComplete) onComplete(); return; }

    if (flush) session.ttsQueue.length = 0;
    session.ttsQueue.push({ text: t, onComplete });

    session.aiChunks.push(t);
    if (session.aiChunks.length > 120) session.aiChunks.shift();

    this.runTTSQueue(sessionId).catch((e) => {
      if (e?.name !== "AbortError") logger.error(`[${sessionId}] runTTSQueue error: ${e.message}`);
    });
  }

  async runTTSQueue(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.ttsQueueRunning) return;
    session.ttsQueueRunning = true;

    try {
      while (session.ttsQueue.length > 0) {
        const s = this.sessions.get(sessionId);
        if (!s || s.isClosing || s.isCleaning) return;

        const item = s.ttsQueue.shift();
        if (!item) continue;

        const textToSpeak = typeof item === "string" ? item : item.text;
        const onComplete = typeof item === "string" ? null : item.onComplete;
        const preloadedStream = item._preloadedStream || null;

        if (!textToSpeak) { if (onComplete) onComplete(); continue; }

        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          await sleep(35);
          s.ttsQueue.unshift(item);
          continue;
        }

        const audioStream = preloadedStream || await this.getAudioStream(sessionId, textToSpeak);
        if (!audioStream) { if (onComplete) onComplete(); continue; }

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

        if (onComplete) { try { onComplete(); } catch { } }
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
        finalText, session.campaign.voiceId, session.campaign.voiceSettings
      );
      logger.info(`[${sessionId}] TTS_STREAM latency=${Date.now() - t0}ms`);
      return stream;
    } catch (e) {
      logger.error(`[${sessionId}] ElevenLabs failed: ${e.message}`);
      if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      return null;
    }
  }

  async streamDirectULawToTwilioWithBargeIn(sessionId, audioStream) {
    const session = this.sessions.get(sessionId);
    if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) return;

    const ac = new AbortController();
    session.ttsAbort = ac;
    session.isSpeaking = true;
    session.lastAiSpokeAt = Date.now();

    const FRAME_BYTES = 160;
    const FRAME_MS = 20;
    let buffer = Buffer.alloc(0);
    let ended = false;
    let frameCount = 0;

    const onData = (chunk) => { if (chunk?.length) buffer = Buffer.concat([buffer, chunk]); };
    const onEnd = () => { ended = true; };
    const onError = () => { ended = true; };

    audioStream.on("data", onData);
    audioStream.on("end", onEnd);
    audioStream.on("error", onError);

    try {
      while (!ac.signal.aborted) {
        if (buffer.length >= FRAME_BYTES) {
          const frame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);
          try {
            session.ws.send(JSON.stringify({
              event: "media",
              streamSid: session.streamSid,
              media: { payload: frame.toString("base64") },
            }));
          } catch { }
          session.lastAiAudioSentAt = Date.now();
          frameCount++;
          await sleep(FRAME_MS);
          continue;
        }
        if (ended) break;
        await sleep(5);
      }
    } finally {
      try { audioStream.off("data", onData); audioStream.off("end", onEnd); audioStream.off("error", onError); } catch { }
      try { audioStream.destroy(); } catch { }
      session.isSpeaking = false;
      session.ttsAbort = null;
      logger.info(`[${sessionId}] TTS done frames=${frameCount}`);
    }
  }

  // ─── LLM ──────────────────────────────────────────────────────────────────
  _buildSystemPrompt(session) {
    const base = session.systemPrompt ||
      "You are Matt, a friendly ACA qualification voice agent. Follow your script exactly.";

    const st = session.state || {};
    const answeredQs = [];
    if (st.ageQualified !== null) answeredQs.push(`Q1(age):${st.ageQualified ? "pass" : "fail"}`);
    if (st.incomeQualified !== null) answeredQs.push(`Q2(income):${st.incomeQualified ? "pass" : "fail"}`);
    if (st.govCoverageQualified !== null) answeredQs.push(`Q3(govCoverage):${st.govCoverageQualified ? "pass" : "fail"}`);
    if (st.employerCoverageQualified !== null) answeredQs.push(`Q4(employerCoverage):${st.employerCoverageQualified ? "pass" : "fail"}`);
    if (st.bankAccountQualified !== null) answeredQs.push(`Q5(bankAccount):${st.bankAccountQualified ? "pass" : "fail"}`);
    if (st.email) answeredQs.push(`Q6(email):${st.email}`);
    if (st.subsidyCheckQualified !== null) answeredQs.push(`Q7(subsidy):${st.subsidyCheckQualified ? "pass" : "fail"}`);

    const awaitLabel = session.awaitingAnswerFor ? `;collecting=${session.awaitingAnswerFor}` : "";

    const stateBlock = [
      `\n\n---`,
      `## CURRENT CALL STATE (internal — do not read aloud)`,
      `stage: ${session.currentStage}`,
      `nextQuestion: Q${session.currentQuestionNum}`,
      `questionsAnswered: [${answeredQs.join(", ") || "none yet"}]`,
      `zip: ${st.zip || "not collected"}`,
      `fullName: ${st.fullName || "not collected"}`,
      `email: ${st.email || "not collected"}`,
      `qualified: ${!!st.qualified}${awaitLabel}`,
      `INSTRUCTION: You are on stage "${session.currentStage}". Next question to ask: Q${session.currentQuestionNum}. Do NOT re-ask already answered questions. Do NOT skip questions. Follow the script in order.`,
      `---`,
    ].join("\n");

    return base + stateBlock;
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    if (session.llmAbort) { try { session.llmAbort.abort(); } catch { } }
    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;
    session.activeTurnId += 1;
    const myTurnId = session.activeTurnId;

    const questionBeingAnswered = session.awaitingAnswerFor;

    const t0 = Date.now();
    try {
      const systemPrompt = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(`[${sessionId}] LLM_START turn=${myTurnId} stage=${session.currentStage} Q=${session.currentQuestionNum} input="${userText}"`);

      let fullText = "";
      let firstTokenAt = 0;
      let firstChunkSent = false;
      let firstTTSPromise = null;
      let firstTTSText = null;

      // FIX 3: minChunkLength tuned — don't fire on [laughs softly] alone (too short)
      // Laughter tags are part of the sentence, not standalone chunks
      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || llmController.signal.aborted) return;

        const sanitized = safeTTS(sentence);
        // Don't send a chunk that is ONLY a laughter tag with nothing else (too short to play)
        if (!sanitized) return;
        // Allow very short chunks only if they have real spoken content beyond just a tag
        const textWithoutTags = sanitized.replace(/\[[^\]]+\]/g, "").trim();
        if (textWithoutTags.length < 3 && sanitized.length < 20) return;

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}: "${sanitized}"`);

        if (!firstChunkSent) {
          firstChunkSent = true;
          firstTTSText = sanitized;
          // Pre-fetch ElevenLabs in parallel with rest of LLM streaming
          firstTTSPromise = this.getAudioStream(sessionId, sanitized).catch(() => null);
        } else {
          this.enqueueTTS(sessionId, sanitized);
        }
      });

      chunker.minChunkLength = 12;
      chunker.maxChunkLength = 130;

      for await (const delta of this.openaiService.streamResponse(
        userText, systemPrompt, historyForModel, llmController.signal
      )) {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || llmController.signal.aborted) break;
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          logger.info(`[${sessionId}] TTFT turn=${myTurnId}: ${firstTokenAt - t0}ms`);
        }
        fullText += delta;
        chunker.add(stripQCBlocks(delta));
      }
      chunker.end();

      logger.info(`[${sessionId}] LLM_COMPLETE turn=${myTurnId} total=${Date.now() - t0}ms`);

      // Inject pre-fetched first stream at front of queue
      if (firstTTSPromise && firstTTSText && session.activeTurnId === myTurnId) {
        const resolvedStream = await firstTTSPromise;
        if (resolvedStream) {
          const s = this.sessions.get(sessionId);
          if (s && !s.isClosing && !s.isCleaning) {
            s.ttsQueue.unshift({ text: firstTTSText, _preloadedStream: resolvedStream, onComplete: null });
            this.runTTSQueue(sessionId).catch(() => { });
          }
        }
      }

      const aiText = sanitizeForTTS(fullText);

      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

        // Store collected answer if a question was active
        if (questionBeingAnswered) {
          session.state.capturedAnswers[questionBeingAnswered] = userText;
          session.questionsAnswered[questionBeingAnswered] = userText;
          if (questionBeingAnswered === "zip") session.state.zip = userText.trim();
          if (questionBeingAnswered === "fullName") session.state.fullName = userText.trim();
          if (questionBeingAnswered === "email") session.state.email = userText.trim();
          if (session.awaitingAnswerFor === questionBeingAnswered) session.awaitingAnswerFor = null;
          logger.info(`[${sessionId}] Answer stored: ${questionBeingAnswered}="${userText}"`);
        }

        // Parse LLM response to update qualification state and advance question tracker
        this._parseAndUpdateQualificationState(session, userText, aiText);
        this._detectAndSetQuestionLock(session, aiText);
        this._maybeAdvanceStage(session, aiText);
      }

      session.state.retriesCantHear = 0;
    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance error: ${e.message}`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      }
    } finally {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        if (s.activeTurnId === myTurnId) s.llmAbort = null;
      }
    }
  }

  // Parse the LLM's response + customer input to update qualification flags
  // and advance the question counter so the state block stays accurate
  _parseAndUpdateQualificationState(session, userText, aiText) {
    const st = session.state;
    const aiLower = (aiText || "").toLowerCase();
    const userLower = (userText || "").toLowerCase();
    const q = session.currentQuestionNum;

    // Q1 — Age: LLM asked age, customer answered
    if (q === 1 && st.ageQualified === null) {
      const ageMatch = userText.match(/\b(\d{1,3})\b/);
      if (ageMatch) {
        const age = parseInt(ageMatch[1], 10);
        if (age >= 1 && age <= 64) {
          st.ageQualified = true;
          session.currentQuestionNum = 2;
          logger.info(`[${session.id}] Q1 passed: age=${age} → Q2`);
        } else if (age >= 65) {
          st.ageQualified = false;
          session.callLog && (session.callLog.disposition = "NOT_QUALIFIED");
          logger.info(`[${session.id}] Q1 FAIL: age=${age} → disqualify`);
        }
      }
      // If LLM moved past Q1 based on context, advance anyway
      if (/household income|twenty thousand|income.*year/i.test(aiLower) && q === 1) {
        session.currentQuestionNum = 2;
      }
    }

    // Q2 — Income: advance when LLM asks Q3 topic
    if (q === 2 && st.incomeQualified === null) {
      const isYes = /\byes\b|\byeah\b|\byep\b|\bsure\b|\bdo\b|\bi do\b|\bmore\b/i.test(userLower);
      const isNo = /\bno\b|\bnope\b|\bnot\b|\bless\b/i.test(userLower);
      if (isYes) { st.incomeQualified = true; session.currentQuestionNum = 3; logger.info(`[${session.id}] Q2 passed → Q3`); }
      else if (isNo) { st.incomeQualified = false; session.callLog && (session.callLog.disposition = "NOT_QUALIFIED"); }
      if (/medicare|medicaid|tricare|va coverage/i.test(aiLower) && q === 2) session.currentQuestionNum = 3;
    }

    // Q3 — Gov Coverage: advance when LLM asks Q4 topic
    if (q === 3 && st.govCoverageQualified === null) {
      const isNo = /\bno\b|\bnope\b|\bnot\b|\bi do not\b|\bdo not have\b/i.test(userLower);
      if (isNo) { st.govCoverageQualified = true; session.currentQuestionNum = 4; logger.info(`[${session.id}] Q3 passed → Q4`); }
      else if (/\byes\b|\byeah\b|\bi am\b|\bi do\b/i.test(userLower)) {
        st.govCoverageQualified = false;
        session.callLog && (session.callLog.disposition = "NOT_QUALIFIED");
      }
      if (/employer|through.*job|through.*work|health.*insurance.*work/i.test(aiLower) && q === 3) session.currentQuestionNum = 4;
    }

    // Q4 — Employer Coverage: advance when LLM asks Q5 topic
    if (q === 4 && st.employerCoverageQualified === null) {
      const isNo = /\bno\b|\bnope\b|\bnot\b|\bi do not\b|\bdo not have\b/i.test(userLower);
      if (isNo) { st.employerCoverageQualified = true; session.currentQuestionNum = 5; logger.info(`[${session.id}] Q4 passed → Q5`); }
      else if (/\byes\b|\byeah\b|\bi do\b|\bi am\b/i.test(userLower)) {
        st.employerCoverageQualified = false;
        session.callLog && (session.callLog.disposition = "NOT_QUALIFIED");
      }
      if (/bank account|active bank/i.test(aiLower) && q === 4) session.currentQuestionNum = 5;
    }

    // Q5 — Bank Account: advance when LLM asks Q6 topic
    if (q === 5 && st.bankAccountQualified === null) {
      const isYes = /\byes\b|\byeah\b|\byep\b|\bsure\b|\bi do\b|\bi have\b/i.test(userLower);
      if (isYes) { st.bankAccountQualified = true; session.currentQuestionNum = 6; logger.info(`[${session.id}] Q5 passed → Q6`); }
      else if (/\bno\b|\bnope\b|\bnot\b/i.test(userLower)) {
        st.bankAccountQualified = false;
        session.callLog && (session.callLog.disposition = "NOT_QUALIFIED");
      }
      if (/email|email address/i.test(aiLower) && q === 5) session.currentQuestionNum = 6;
    }

    // Q6 — Email (optional): advance when LLM asks Q7 topic
    if (q === 6) {
      if (/subsidy card|benefits card|free money/i.test(aiLower)) {
        session.currentQuestionNum = 7;
        logger.info(`[${session.id}] Q6 done → Q7`);
      }
    }

    // Q7 — Subsidy check: advance to Stage 3 when passed
    if (q === 7 && st.subsidyCheckQualified === null) {
      const isNo = /\bno\b|\bnope\b|\bnot\b|\bi am not\b|\bdo not\b/i.test(userLower);
      if (isNo) {
        st.subsidyCheckQualified = true;
        st.qualified = true;
        session.currentQuestionNum = 8; // All Qs done
        logger.info(`[${session.id}] Q7 passed → QUALIFIED → Stage 3`);
      } else if (/\byes\b|\byeah\b|\bi am\b|\bi do\b/i.test(userLower)) {
        st.subsidyCheckQualified = false;
        session.callLog && (session.callLog.disposition = "NOT_QUALIFIED");
      }
    }

    // If LLM response contains the mandatory Stage 3 opening sentence, mark qualified
    if (/it looks like.*qualify.*affordable care act/i.test(aiLower)) {
      st.qualified = true;
      session.currentStage = "preTransfer";
      logger.info(`[${session.id}] Stage 3 opening detected → preTransfer`);
    }
  }

  _detectAndSetQuestionLock(session, aiText) {
    if (session.awaitingAnswerFor) return;
    const lower = (aiText || "").toLowerCase();
    if (/\bzip\b|\bzip code\b|\barea code\b|\bconfirm your zip\b/.test(lower)) {
      session.awaitingAnswerFor = "zip";
      logger.info(`[${session.id}] Question lock → zip`);
    } else if (/\bfull name\b|\byour name\b|\bfirst.*last\b|\bname please\b/.test(lower)) {
      session.awaitingAnswerFor = "fullName";
      logger.info(`[${session.id}] Question lock → fullName`);
    } else if (/\bemail\b|\bemail address\b/.test(lower)) {
      session.awaitingAnswerFor = "email";
      logger.info(`[${session.id}] Question lock → email`);
    }
  }

  _maybeAdvanceStage(session, aiText) {
    const lower = (aiText || "").toLowerCase();
    if (session.currentStage === "qualification") {
      // LLM delivered the mandatory Stage 3 opening sentence
      if (/it looks like.*qualify|affordable care act.*good news/i.test(lower)) {
        session.currentStage = "preTransfer";
        logger.info(`[${session.id}] Stage → preTransfer`);
      }
    } else if (session.currentStage === "preTransfer") {
      if (/disclaimer/i.test(lower)) {
        session.currentStage = "disclaimer";
        logger.info(`[${session.id}] Stage → disclaimer`);
      }
    } else if (session.currentStage === "disclaimer") {
      if (/connecting|connect you|five seconds|licensed expert/i.test(lower)) {
        session.currentStage = "wrapup";
        logger.info(`[${session.id}] Stage → wrapup`);
      }
    }
  }

  // ─── MID-CALL SILENCE ─────────────────────────────────────────────────────
  armMidCallSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;
    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");
    this._setTimer(sessionId, "midCheck", MID_SILENCE_CHECK_MS, async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.isClosing || s.isCleaning || s.isSpeaking || s.isProcessingUtterance) return;
      const sinceSpeech = Date.now() - (s.lastSpeechAt || 0);
      const sinceInterim = s.userSpeech?.lastInterimTime ? Date.now() - s.userSpeech.lastInterimTime : 999999;
      if (sinceInterim < 2500 || sinceSpeech < 3500) return;
      await this._maybeCantHearOrPrompt(sessionId);
    });
  }

  async _maybeCantHearOrPrompt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;
    const now = Date.now();
    const st = session.state;
    const sinceSpeech = now - (session.lastSpeechAt || 0);
    const sinceInterim = session.userSpeech?.lastInterimTime ? now - session.userSpeech.lastInterimTime : 999999;

    if (sinceSpeech > 8000 && sinceInterim > 8000) {
      if (st.lastCantHearAt && now - st.lastCantHearAt < CANT_HEAR_COOLDOWN_MS) {
        this.enqueueTTS(sessionId, "hey, are you still with me?", { flush: true });
      } else {
        st.retriesCantHear = (st.retriesCantHear || 0) + 1;
        st.lastCantHearAt = now;
        if (st.retriesCantHear <= CANT_HEAR_MAX_RETRIES) {
          // Rotate through the script's prescribed silence check phrases
          const silenceChecks = [
            "hey, are you still with me?",
            "hey, can you hear me okay?",
            "hey, I am not able to hear you - are you still there?",
            "hey, am I audible on your end?",
          ];
          const phrase = silenceChecks[(st.retriesCantHear - 1) % silenceChecks.length];
          this.enqueueTTS(sessionId, phrase, { flush: true });
        } else {
          if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "UNRESPONSIVE";
          await this.politeHangup(sessionId, {
            finalMessage: "I am not able to hear you. I will try calling back another time. Have a great day.",
          });
          return;
        }
      }
    } else {
      this.enqueueTTS(sessionId, "hey, are you still with me?", { flush: true });
    }

    this._setTimer(sessionId, "midHangup", MID_SILENCE_HANGUP_MS, async () => {
      const ss = this.sessions.get(sessionId);
      if (!ss || ss.isClosing || ss.isCleaning) return;
      const now2 = Date.now();
      const sinceSpeech2 = now2 - (ss.lastSpeechAt || 0);
      const sinceInterim2 = ss.userSpeech?.lastInterimTime ? now2 - ss.userSpeech.lastInterimTime : 999999;
      if (sinceSpeech2 < 3500 || sinceInterim2 < 3500 || ss.isSpeaking || ss.isProcessingUtterance) return;
      if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "UNRESPONSIVE";
      await this.politeHangup(sessionId, {
        finalMessage: "I am not able to hear you. I will try calling back another time. Have a great day.",
      });
    });
  }

  // ─── STOP + CLEAR ─────────────────────────────────────────────────────────
  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttsAbort) { try { session.ttsAbort.abort(); } catch { } session.ttsAbort = null; }
    session.isSpeaking = false;
    if (session.llmAbort) { try { session.llmAbort.abort(); } catch { } session.llmAbort = null; }
    session.ttsQueue.length = 0;
    const us = session.userSpeech;
    if (us?.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us?.hardMaxTimer) { clearTimeout(us.hardMaxTimer); us.hardMaxTimer = null; }
    if (us?.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }
    if (us) us.pendingBargeIn = false;
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

  // ─── HANGUP + CLEANUP ─────────────────────────────────────────────────────
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
    session.currentStage = "wrapup";
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
    if (!session || session.isCleaning) return;
    session.isCleaning = true;
    logger.info(`Cleaning session: ${sessionId} endedBy=${endedBy}`);

    try { this._clearAllTimers(session); this.stopTTS(sessionId); } catch { }
    try { this.deepgramService.closeTranscriptionStream(sessionId); } catch { }

    try {
      if (session.callLog) {
        const now = Date.now();
        if (!session.callLog.duration || session.callLog.duration === 0)
          session.callLog.duration = Math.floor((now - session.startTime) / 1000);
        session.callLog.endTime = session.callLog.endTime || new Date(now);

        const transcript = this._buildTranscriptForLog(session);
        if (transcript) session.callLog.transcript = transcript;
        if (Array.isArray(session.aiChunks) && session.aiChunks.length)
          session.callLog.aiResponses = session.aiChunks.slice(-50);

        const dispositionObj = buildDispositionObject(session, endedBy);
        session.callLog.disposition = dispositionObj.status;
        session.callLog.dispositionDetail = dispositionObj;

        if (session.state?.capturedAnswers)
          session.callLog.capturedAnswers = session.state.capturedAnswers;

        await session.callLog.save();
        logger.info(`[${sessionId}] CallLog saved disposition=${dispositionObj.status}`);
      }
    } catch (e) {
      logger.error(`[${sessionId}] callLog save failed: ${e.message}`);
    }

    try { if (session.ws?.readyState === WebSocket.OPEN) session.ws.close(); } catch { }
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