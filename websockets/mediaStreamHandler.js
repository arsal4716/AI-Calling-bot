// MediaStreamHandler.js (production-ready) — fixes:
// ✅ Accepts 1-word answers (yes/no/yeah/mhmm/okay)
// ✅ No premature “silence” processing
// ✅ Blocks late/out-of-order transcripts via turnId + aborts
// ✅ Reduces false barge-in from echo/noise (confirm barge-in by transcript)
// ✅ Prevents repeated opening greeting from the LLM (hard filter + prompt guard)

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

function safeTTS(text, maxChars = 420) {
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

// --- short-answer allowlist (fixes: yes/no/yeah/mhmm/okay being dropped) ---
const SHORT_ANSWER_REGEX =
  /^(yes|no|yeah|yep|nope|ok|okay|sure|right|correct|exactly|uh huh|uh-huh|mhm|mhmm|mm hmm|mm-hmm|hmm|hello|hi)\.?\s*$/i;

// Also accept short numeric answers (age/zip fragments can come short sometimes)
function isShortButValidUtterance(u) {
  const t = (u || "").trim();
  if (!t) return false;
  if (SHORT_ANSWER_REGEX.test(t)) return true;
  // “35”, “35.”, “72132” etc
  if (/^\d{1,6}\.?\s*$/.test(t)) return true;
  return false;
}

// --- greeting repetition filter (fixes: LLM repeating opening) ---
function stripRepeatedGreetingIfAny(session, text) {
  if (!session?.initialGreetingSent) return text || "";
  const t = (text || "").trim();
  if (!t) return t;

  // hard-match the repeated line you mentioned
  // remove ONLY if it appears at the start (so we do not accidentally remove legit content later)
  const rx = /^\s*hi,\s*thank you for taking the call\.\s*this is\s+\w+\s+with\s+healthcare benefits\.\s*i hope you are doing well\.\s*/i;
  let out = t.replace(rx, "");

  // if campaign openingLine is stored, remove it too (normalized compare)
  const opening = safeTTS(
    renderTemplate(session.openingLine, { agentname: session.agentName })
  );
  if (opening) {
    const nOpen = norm(opening);
    const nOut = norm(out);
    if (nOut.startsWith(nOpen)) {
      // remove by length approximation on normalized string is risky; do a softer approach:
      // remove first 220 chars if it contains the key phrase and we're in qualification+
      if (
        /thank you for taking the call/.test(nOut) &&
        /healthcare benefits/.test(nOut)
      ) {
        out = out.slice(Math.min(out.length, 240)).trimStart();
      }
    }
  }

  return out;
}

function isRepeatedGreetingChunk(session, chunk) {
  if (!session?.initialGreetingSent) return false;
  const n = norm(chunk);
  if (!n) return false;
  return (
    n.startsWith("hi thank you for taking the call") &&
    n.includes("healthcare benefits")
  );
}

// ---------------- tuning constants ----------------
// Debounce: enough to tolerate 1–2s thinking pauses, but still fast responses
const UTTERANCE_DEBOUNCE_MS = 650;
const UTTERANCE_HARD_MAX_MS = 1800;

// Keep stricter noise rejection, BUT allow explicit short answers
const MIN_UTTERANCE_CHARS = 6;
const MIN_UTTERANCE_WORDS = 2;

// Echo/noise barge-in protection
const ECHO_GUARD_MS = 320;
const BARGEIN_CONFIRM_MS = 160;
const BARGEIN_MIN_CHARS = 4;

// Mid-call silence prompts (avoid loop)
const MID_SILENCE_CHECK_MS = 11000;
const MID_SILENCE_HANGUP_MS = 7000;

// “cannot hear you” loop control
const CANT_HEAR_COOLDOWN_MS = 9000;
const CANT_HEAR_MAX_RETRIES = 2;

// History kept short for speed
const HISTORY_LIMIT = 10;
const HISTORY_FOR_MODEL = 6;

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
            this.maybePlayInitialGreeting(sessionId).catch(() => {});
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
            await this.cleanupSession(sessionId);
            break;
        }
      });

      ws.on("close", () => {
        logger.info(`[${sessionId}] WebSocket closed`);
        this.cleanupSession(sessionId);
      });

      ws.on("error", (err) => {
        logger.error(`[${sessionId}] WebSocket error: ${err.message}`);
        this.cleanupSession(sessionId);
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
      ttsQueue: [],
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

      // ordering
      activeTurnId: 0,
      lastProcessedAt: 0,

      // echo guard
      lastAiAudioSentAt: 0,

      // timers
      timers: {
        startSpeak: null,
        startHangup: null,
        midCheck: null,
        midHangup: null,
      },

      startSilenceFlowArmed: false,

      // stage tracking
      currentStage: "greeting",

      // compact external state
      state: {
        qualified: false,
        zip: "",
        fullName: "",
        retriesCantHear: 0,
        lastCantHearAt: 0,
      },

      // user speech aggregation
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
    this.maybePlayInitialGreeting(sessionId).catch(() => {});
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

  // ----------------------- greeting -----------------------
  async maybePlayInitialGreeting(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.initialGreetingSent) return;
    if (!session.campaign || !session.openingLine) return;

    if (!session.isTwilioReady || !session.streamSid) {
      logger.info(`[${sessionId}] Greeting ready, waiting for Twilio streamSid...`);
      return;
    }

    const greetingText = safeTTS(renderTemplate(session.openingLine, { agentname: session.agentName }));
    if (!greetingText) return;

    session.initialGreetingSent = true;
    session.currentStage = "qualification";

    session.conversationHistory.push({ role: "assistant", content: greetingText });
    session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

    logger.info(`[${sessionId}] Playing initial greeting: "${greetingText}"`);
    this.enqueueTTS(sessionId, greetingText, { flush: true });

    this.armMidCallSilence(sessionId);
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

      const fallbackGreeting =
        safeTTS(renderTemplate(s.openingLine, { agentname: s.agentName })) ||
        "Hi, thank you for taking the call. This is Matt with healthcare benefits. I hope you are doing well.";

      s.initialGreetingSent = true;
      s.currentStage = "qualification";

      this.enqueueTTS(sessionId, fallbackGreeting, { flush: true });

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
            await this.politeHangup(sessionId, {
              finalMessage: "Sorry, I can not hear you. I will hang up now. Goodbye.",
            });
          });
          return;
        }

        logger.info(`[${sessionId}] START-SILENCE: still silent → hangup`);
        await this.politeHangup(sessionId, {
          finalMessage: "Sorry, I can not hear you. I will hang up now. Goodbye.",
        });
      });
    });
  }

  // ----------------------- Deepgram + utterance aggregation -----------------------
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

    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }
    if (us.hardMaxTimer) {
      clearTimeout(us.hardMaxTimer);
      us.hardMaxTimer = null;
    }

    us.hardMaxTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, { reason: "hard_max", utteranceId: us.utteranceId });
    }, UTTERANCE_HARD_MAX_MS);

    // DO NOT instantly stop TTS. Confirm by transcript to avoid echo/noise stops.
    if (session.isSpeaking) {
      const sinceAiAudio = Date.now() - (session.lastAiAudioSentAt || 0);
      if (sinceAiAudio < ECHO_GUARD_MS) return;

      us.pendingBargeIn = true;

      if (us.bargeInConfirmTimer) {
        clearTimeout(us.bargeInConfirmTimer);
        us.bargeInConfirmTimer = null;
      }

      us.bargeInConfirmTimer = setTimeout(() => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        const uus = ss.userSpeech;

        if (uus.pendingBargeIn && (uus.buffer || "").trim().length < BARGEIN_MIN_CHARS) {
          uus.pendingBargeIn = false;
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

    // keep latest interim (Deepgram repeats; latest is best)
    us.buffer = trimmed;

    // confirm barge-in only with meaningful transcript
    if (session.isSpeaking && us.pendingBargeIn) {
      if (trimmed.length >= BARGEIN_MIN_CHARS || isShortButValidUtterance(trimmed)) {
        logger.info(`[${sessionId}] BARGE-IN confirmed by transcript → stop TTS`);
        us.pendingBargeIn = false;
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
      }
    }

    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }

    // finalize fast when Deepgram declares it final
    if (speechFinal || isFinal) {
      this._finalizeUtterance(sessionId, {
        reason: speechFinal ? "speech_final" : "is_final",
        utteranceId: us.utteranceId,
      });
      return;
    }

    // debounce finalize: prevents cutting off during a 1–2 sec thinking pause
    us.finalizeTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, { reason: "debounce", utteranceId: us.utteranceId });
    }, UTTERANCE_DEBOUNCE_MS);
  }

  _finalizeUtterance(sessionId, { reason, utteranceId }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const us = session.userSpeech;

    if (utteranceId !== us.utteranceId) return;

    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }
    if (us.hardMaxTimer) {
      clearTimeout(us.hardMaxTimer);
      us.hardMaxTimer = null;
    }
    if (us.bargeInConfirmTimer) {
      clearTimeout(us.bargeInConfirmTimer);
      us.bargeInConfirmTimer = null;
    }
    us.pendingBargeIn = false;

    const utterance = (us.buffer || "").trim();

    us.isSpeaking = false;
    us.buffer = "";

    if (!utterance) return;

    // ✅ Accept short valid answers (YES/NO/MHMM/OK/etc) even if tiny
    const shortValid = isShortButValidUtterance(utterance);

    // Reject noise unless it is short-valid
    if (!shortValid) {
      if (
        utterance.length < MIN_UTTERANCE_CHARS &&
        wordCount(utterance) < MIN_UTTERANCE_WORDS
      ) {
        logger.info(`[${sessionId}] Drop tiny utterance (${reason}): "${utterance}"`);
        return;
      }
      // common micro-noise patterns
      if (/^(h|ha|ah|um|uh)\.?$/i.test(utterance)) {
        logger.info(`[${sessionId}] Drop noise utterance (${reason}): "${utterance}"`);
        return;
      }
    }

    logger.info(`[${sessionId}] Finalized utterance (${reason}): "${utterance}"`);
    session.lastProcessedAt = Date.now();

    // process immediately; newest input wins
    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError") logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
    });
  }

  // ----------------------- TTS pipeline -----------------------
  enqueueTTS(sessionId, text, { flush = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    let t = safeTTS(text);
    if (!t) return;

    // ✅ prevent repeated greeting from being spoken again (even if LLM outputs it)
    if (isRepeatedGreetingChunk(session, t)) return;

    if (flush) session.ttsQueue.length = 0;
    session.ttsQueue.push(t);

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

        const textToSpeak = s.ttsQueue.shift();
        if (!textToSpeak) continue;

        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          await sleep(35);
          s.ttsQueue.unshift(textToSpeak);
          continue;
        }

        const audioStream = await this.getAudioStream(sessionId, textToSpeak);
        if (!audioStream) continue;

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

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

    const FRAME_BYTES = 160;
    const FRAME_MS = 20;

    let buffer = Buffer.alloc(0);
    let ended = false;
    let frameCount = 0;

    const onData = (chunk) => {
      if (!chunk || !chunk.length) return;
      buffer = Buffer.concat([buffer, chunk]);
    };
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

          session.ws.send(JSON.stringify({
            event: "media",
            streamSid: session.streamSid,
            media: { payload: frame.toString("base64") },
          }));

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
      } catch {}

      try { audioStream.destroy(); } catch {}

      session.isSpeaking = false;
      session.ttsAbort = null;

      logger.info(`[${sessionId}] Paced audio done. frames=${frameCount}`);
    }
  }

  // ----------------------- LLM (fast + ordered) -----------------------
  _buildSystemPrompt(session) {
    let systemPrompt =
      session.systemPrompt ||
      "You are a natural phone agent. Reply briefly and ask one short question.";

    // ✅ Hard guard: never repeat the greeting if it already happened
    if (session.initialGreetingSent) {
      systemPrompt =
        "CRITICAL: The opening greeting has already been spoken ONCE at call start. DO NOT repeat it or paraphrase it.\n" +
        "Never say: 'Hi, thank you for taking the call...' again.\n\n" +
        systemPrompt;
    }

    if (session.currentStage === "qualification") {
      systemPrompt =
        "IMPORTANT: Continue from the current point in the script. Do not restart the introduction.\n\n" +
        systemPrompt;
    } else if (session.currentStage === "preTransfer") {
      systemPrompt =
        "The customer is qualified. Collect ZIP code and full name as per the script.\n\n" +
        systemPrompt;
    } else if (session.currentStage === "disclaimer") {
      systemPrompt =
        "Read the disclaimer, confirm understanding, then proceed to transfer.\n\n" +
        systemPrompt;
    }

    const st = session.state || {};
    const stateLine =
      `\n\nSTATE (do not read aloud): stage=${session.currentStage}; ` +
      `greetingDone=${!!session.initialGreetingSent}; ` +
      `qualified=${!!st.qualified}; zip=${st.zip || ""}; fullName=${st.fullName || ""}\n`;

    return systemPrompt + stateLine;
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    // newest input always wins
    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    if (session.llmAbort) {
      try { session.llmAbort.abort(); } catch {}
    }
    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;

    session.activeTurnId += 1;
    const myTurnId = session.activeTurnId;

    const t0 = Date.now();
    try {
      const systemPrompt = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(`[${sessionId}] LLM_START turn=${myTurnId} input="${userText}"`);

      let fullText = "";
      let firstTokenAt = 0;

      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        if (s.activeTurnId !== myTurnId) return;
        if (llmController.signal.aborted) return;

        let sanitized = safeTTS(sentence);
        if (!sanitized) return;

        // ✅ strip repeated greeting if model tries to output it
        sanitized = stripRepeatedGreetingIfAny(s, sanitized);
        if (!sanitized) return;
        if (isRepeatedGreetingChunk(s, sanitized)) return;

        // avoid ultra-short non-sentence fragments
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

      // sanitize and strip repeated greeting from final history
      let aiText = sanitizeForTTS(fullText);
      aiText = stripRepeatedGreetingIfAny(session, aiText);

      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
      }

      session.state.retriesCantHear = 0;
    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance error: ${e.message}`);
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

      if (s.isSpeaking || s.isProcessingUtterance) return;

      const us = s.userSpeech;
      const now = Date.now();
      const sinceInterim = us?.lastInterimTime ? now - us.lastInterimTime : 999999;
      const sinceSpeech = now - (s.lastSpeechAt || 0);

      // if any recent activity, do nothing
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
          this.enqueueTTS(sessionId, "Sorry, I can not hear you. Can you speak up a bit?", { flush: true });
        } else {
          await this.politeHangup(sessionId, { finalMessage: "Sorry, I still can not hear you. Goodbye." });
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
      await this.politeHangup(sessionId, { finalMessage: "Okay, I will let you go. Goodbye." });
    });
  }

  // ----------------------- stop + clear -----------------------
  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.ttsAbort) {
      try { session.ttsAbort.abort(); } catch {}
      session.ttsAbort = null;
    }
    session.isSpeaking = false;

    if (session.llmAbort) {
      try { session.llmAbort.abort(); } catch {}
      session.llmAbort = null;
    }

    session.ttsQueue.length = 0;

    const us = session.userSpeech;
    if (us?.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }
    if (us?.hardMaxTimer) {
      clearTimeout(us.hardMaxTimer);
      us.hardMaxTimer = null;
    }
    if (us?.bargeInConfirmTimer) {
      clearTimeout(us.bargeInConfirmTimer);
      us.bargeInConfirmTimer = null;
    }
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
    } catch {}

    await this.endTwilioCall(sessionId);
    await this.cleanupSession(sessionId);
  }

  async cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isCleaning) return;

    session.isCleaning = true;
    logger.info(`Cleaning session: ${sessionId}`);

    try {
      this._clearAllTimers(session);
      this.stopTTS(sessionId);

      const us = session.userSpeech;
      if (us?.finalizeTimer) {
        clearTimeout(us.finalizeTimer);
        us.finalizeTimer = null;
      }
      if (us?.hardMaxTimer) {
        clearTimeout(us.hardMaxTimer);
        us.hardMaxTimer = null;
      }
      if (us?.bargeInConfirmTimer) {
        clearTimeout(us.bargeInConfirmTimer);
        us.bargeInConfirmTimer = null;
      }
    } catch {}

    try {
      this.deepgramService.closeTranscriptionStream(sessionId);
    } catch {}

    try {
      if (session.callLog) {
        const durationApprox = Math.floor((Date.now() - session.startTime) / 1000);
        if (!session.callLog.duration || session.callLog.duration === 0) {
          session.callLog.duration = durationApprox;
        }
        await session.callLog.save();
      }
    } catch (e) {
      logger.error(`[${sessionId}] callLog save failed: ${e.message}`);
    }

    try {
      if (session.ws?.readyState === WebSocket.OPEN) session.ws.close();
    } catch {}

    this.sessions.delete(sessionId);
    logger.info(`Session cleaned: ${sessionId}`);
  }

  cleanupInactiveSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > 300000) {
        logger.warn(`Cleaning inactive session: ${sessionId}`);
        this.cleanupSession(sessionId);
      }
    }
  }
}

module.exports = MediaStreamHandler;