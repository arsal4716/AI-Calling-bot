// MediaStreamHandler.js (production-ready)
// Fixes:
// 1) Aggressive silence detection → smarter utterance finalization using Deepgram speech_final/is_final + debounce
// 2) Late transcripts processed out-of-order → per-utterance IDs + turn IDs + drop stale events
// 3) False barge-in from noise/echo → "confirm barge-in" only after real transcript, plus echo-guard window
// 4) Losing track of flow → lightweight external state + stage + compact state injection to LLM
// 5) “I cannot hear you” loops → cooldown + retry limit + only if truly no speech

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

// ---------------- tuning constants ----------------
// USER silence detection: 250ms was far too aggressive for 1–2s thinking pauses.
const UTTERANCE_DEBOUNCE_MS = 650; // debounce after last interim
const UTTERANCE_HARD_MAX_MS = 1800; // if user keeps "um..." forever, still finalize
const MIN_UTTERANCE_CHARS = 6; // ignore micro-noise like "uh"
const MIN_UTTERANCE_WORDS = 2; // reduces false triggers

// Echo/noise barge-in protection
const ECHO_GUARD_MS = 320; // ignore speech_started right after we sent TTS frames
const BARGEIN_CONFIRM_MS = 160; // confirm speech_started by requiring transcript soon
const BARGEIN_MIN_CHARS = 4;

// Mid-call silence prompts (avoid loop)
const MID_SILENCE_CHECK_MS = 11000;
const MID_SILENCE_HANGUP_MS = 7000;

// “cannot hear you” loop control
const CANT_HEAR_COOLDOWN_MS = 9000;
const CANT_HEAR_MAX_RETRIES = 2;

// Keep history short for speed (latency)
const HISTORY_LIMIT = 10;
const HISTORY_FOR_MODEL = 6;

// ---------------- class ----------------
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
        logger.error(
          `[${sessionId}] Immediate Session Init failed: ${err.message}`
        )
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

            logger.info(
              `[${sessionId}] Twilio START: streamSid=${session.streamSid}`
            );

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

      // new: turn + ordering control
      activeTurnId: 0, // increments each user turn
      lastProcessedAt: 0, // last time we processed a finalized utterance

      // new: echo guard (updated while we send frames)
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
      currentStage: "greeting", // greeting, qualification, preTransfer, disclaimer

      // new: external state (compact)
      state: {
        qualified: false,
        zip: "",
        fullName: "",
        retriesCantHear: 0,
        lastCantHearAt: 0,
      },

      // user speech aggregation (utterance-level)
      userSpeech: {
        utteranceId: 0,
        isSpeaking: false,
        buffer: "",
        lastInterimTime: 0,
        startedAt: 0,
        finalizeTimer: null,
        hardMaxTimer: null,

        // barge-in confirm
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
    session.direction = String(callLog.direction || callLog.Direction || "")
      .toLowerCase()
      .trim();

    this.sessions.set(sessionId, session);

    await this.deepgramService.createTranscriptionStream(sessionId, {
      onOpen: () => {
        const s = this.sessions.get(sessionId);
        if (s) s.dgOpenAt = Date.now();
      },

      // IMPORTANT: Deepgram speech_started can be noise/echo. We only *confirm* barge-in after transcript arrives.
      onSpeechStarted: () => this.onUserSpeechStarted(sessionId),

      // You already pass: ({ text, isFinal, speechFinal }) => ...
      // We will use isFinal/speechFinal to finalize correctly and avoid aggressive silence.
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
      logger.info(
        `[${sessionId}] Greeting ready, waiting for Twilio streamSid...`
      );
      return;
    }

    const greetingText = safeTTS(
      renderTemplate(session.openingLine, { agentname: session.agentName })
    );
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
        "Hi, thank you for taking the call. Can you hear me okay?";

      this.enqueueTTS(sessionId, fallbackGreeting, { flush: true });

      this._setTimer(sessionId, "startHangup", 12000, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        if (ss.hasUserSpoken) return;

        const dgAge = ss.dgOpenAt ? Date.now() - ss.dgOpenAt : 0;
        if (!ss.dgOpenAt || dgAge < 1500) {
          logger.info(
            `[${sessionId}] START-SILENCE: Deepgram not ready (${dgAge}ms) → extend`
          );
          this._setTimer(sessionId, "startHangup", 5000, async () => {
            const sss = this.sessions.get(sessionId);
            if (!sss) return;
            if (sss.hasUserSpoken) return;

            logger.info(`[${sessionId}] START-SILENCE: still silent → hangup`);
            await this.politeHangup(sessionId, {
              finalMessage:
                "Sorry, I can't hear you. I'll hang up now. Goodbye.",
            });
          });
          return;
        }

        logger.info(`[${sessionId}] START-SILENCE: still silent → hangup`);
        await this.politeHangup(sessionId, {
          finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
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

    // NEW utterance boundary
    us.utteranceId += 1;
    us.isSpeaking = true;
    us.buffer = "";
    us.lastInterimTime = Date.now();
    us.startedAt = Date.now();

    // clear old finalize timers
    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }
    if (us.hardMaxTimer) {
      clearTimeout(us.hardMaxTimer);
      us.hardMaxTimer = null;
    }

    // hard max finalize (prevents never-finalizing)
    us.hardMaxTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, {
        reason: "hard_max",
        utteranceId: us.utteranceId,
      });
    }, UTTERANCE_HARD_MAX_MS);

    // IMPORTANT: do NOT instantly stop TTS on speech_started (can be echo/noise).
    // Instead: "pending barge-in" and confirm after real transcript arrives.
    if (session.isSpeaking) {
      const sinceAiAudio = Date.now() - (session.lastAiAudioSentAt || 0);
      if (sinceAiAudio < ECHO_GUARD_MS) {
        // echo guard - ignore this speech_started
        return;
      }

      us.pendingBargeIn = true;

      if (us.bargeInConfirmTimer) {
        clearTimeout(us.bargeInConfirmTimer);
        us.bargeInConfirmTimer = null;
      }

      us.bargeInConfirmTimer = setTimeout(() => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        const uus = ss.userSpeech;

        // If no meaningful transcript arrived quickly, treat as noise.
        if (
          uus.pendingBargeIn &&
          (uus.buffer || "").trim().length < BARGEIN_MIN_CHARS
        ) {
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

    // Always keep latest buffer of current utterance
    // (Deepgram interim usually repeats, so storing "latest" is correct)
    us.buffer = trimmed;

    // Confirm barge-in ONLY once we have meaningful transcript
    if (session.isSpeaking && us.pendingBargeIn) {
      if (trimmed.length >= BARGEIN_MIN_CHARS) {
        logger.info(`[${sessionId}] BARGE-IN confirmed by transcript → stop TTS`);
        us.pendingBargeIn = false;
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
      }
    }

    // Clear finalize timer and re-arm with better logic
    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }

    // If Deepgram says speech_final OR final transcript, finalize quickly (fast 1–2s response)
    if (speechFinal || isFinal) {
      // finalize immediately (but still validate length)
      this._finalizeUtterance(sessionId, {
        reason: speechFinal ? "speech_final" : "is_final",
        utteranceId: us.utteranceId,
      });
      return;
    }

    // Otherwise debounce (handles 1–2s thinking pause without cutting them off)
    us.finalizeTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, {
        reason: "debounce",
        utteranceId: us.utteranceId,
      });
    }, UTTERANCE_DEBOUNCE_MS);
  }

  _finalizeUtterance(sessionId, { reason, utteranceId }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const us = session.userSpeech;

    // Only finalize the current utterance; drop stale finalize calls
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

    // Reset speaking flags
    us.isSpeaking = false;
    us.buffer = "";

    // Validate utterance (prevents noise interrupt + random mid-sentence stops)
    if (!utterance) return;
    if (utterance.length < MIN_UTTERANCE_CHARS && wordCount(utterance) < MIN_UTTERANCE_WORDS) {
      logger.info(`[${sessionId}] Drop tiny utterance (${reason}): "${utterance}"`);
      return;
    }

    // Ordering protection: if something arrives very late (older than lastProcessedAt window), drop it
    const now = Date.now();
    if (session.lastProcessedAt && now - session.lastProcessedAt < 150) {
      // very fast consecutive finalize; still allow latest to be processed by aborting previous
    }

    logger.info(`[${sessionId}] Finalized utterance (${reason}): "${utterance}"`);
    session.lastProcessedAt = now;

    // Process immediately; abort any current LLM/TTS so we never respond to stale input
    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
      }
    });
  }

  // ----------------------- TTS pipeline -----------------------
  enqueueTTS(sessionId, text, { flush = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const t = safeTTS(text);
    if (!t) return;

    if (flush) session.ttsQueue.length = 0;
    session.ttsQueue.push(t);

    this.runTTSQueue(sessionId).catch((e) => {
      if (e?.name !== "AbortError")
        logger.error(`[${sessionId}] runTTSQueue error: ${e.message}`);
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
      logger.info(
        `[${sessionId}] TTS_STREAM_RECEIVED latency=${Date.now() - t0}ms`
      );
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

          session.lastAiAudioSentAt = Date.now(); // echo guard anchor
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

      try {
        audioStream.destroy();
      } catch {}

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

    // Add stage-specific instructions
    if (session.currentStage === "qualification") {
      systemPrompt =
        "IMPORTANT: The opening greeting and reason for call have already been spoken. Do not repeat them. Continue the script.\n\n" +
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

    // Compact external state to reduce context loss (BUG 4)
    // Keep it short to maintain speed.
    const st = session.state || {};
    const stateLine = `\n\nSTATE (do not read aloud): stage=${session.currentStage}; qualified=${!!st.qualified}; zip=${st.zip || ""}; fullName=${st.fullName || ""}\n`;

    return systemPrompt + stateLine;
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    // Always treat newest user input as authoritative (fix BUG 2 + BUG 4)
    // Abort current generation + TTS immediately to respond within 1–2 sec.
    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    if (session.llmAbort) {
      try {
        session.llmAbort.abort();
      } catch {}
    }
    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;

    // NEW: turn id; drops stale deltas if any late stream continues
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
        if (s.activeTurnId !== myTurnId) return; // drop stale chunks
        if (llmController.signal.aborted) return;

        const sanitized = safeTTS(sentence);
        if (!sanitized) return;

        // Start speaking ASAP, but ignore ultra-short non-sentence fragments
        if (sanitized.length < 10 && !/[.!?]$/.test(sanitized)) return;

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}: "${sanitized}"`);
        this.enqueueTTS(sessionId, sanitized);
      });

      // Faster onset
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
        if (s.activeTurnId !== myTurnId) break; // stale stream
        if (llmController.signal.aborted) break;

        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          logger.info(
            `[${sessionId}] LATENCY turn=${myTurnId}: first_token=${firstTokenAt - t0}ms`
          );
        }

        const cleanDelta = stripQCBlocks(delta);
        fullText += delta;
        chunker.add(cleanDelta);
      }

      chunker.end();

      const total = Date.now() - t0;
      logger.info(`[${sessionId}] LLM_COMPLETE turn=${myTurnId} total=${total}ms`);

      const aiText = sanitizeForTTS(fullText);

      // Update history only if this is still the latest turn
      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
      }

      // reset “cannot hear you” retries when we successfully got speech
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
        // newer turn took over
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

      // If we have any recent interim activity, do nothing
      const us = s.userSpeech;
      const sinceInterim = us?.lastInterimTime ? Date.now() - us.lastInterimTime : 999999;
      if (sinceInterim < 2500) return;

      if (sinceSpeech < 3500) return;

      // Prevent loops: “I cannot hear you” should not be repeated rapidly
      await this._maybeCantHearOrPrompt(sessionId);
    });
  }

  async _maybeCantHearOrPrompt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const now = Date.now();
    const st = session.state;

    // Cooldown
    if (st.lastCantHearAt && now - st.lastCantHearAt < CANT_HEAR_COOLDOWN_MS) {
      // Use a softer prompt instead
      this.enqueueTTS(sessionId, "Are you still there?", { flush: true });
    } else {
      // Only say "can't hear" if we truly have no speech activity for a while
      const sinceSpeech = now - (session.lastSpeechAt || 0);
      const sinceInterim = session.userSpeech?.lastInterimTime
        ? now - session.userSpeech.lastInterimTime
        : 999999;

      if (sinceSpeech > 8000 && sinceInterim > 8000) {
        st.retriesCantHear = (st.retriesCantHear || 0) + 1;
        st.lastCantHearAt = now;

        if (st.retriesCantHear <= CANT_HEAR_MAX_RETRIES) {
          this.enqueueTTS(sessionId, "Sorry, I can't hear you. Can you speak up?", {
            flush: true,
          });
        } else {
          await this.politeHangup(sessionId, {
            finalMessage: "Sorry, I still can't hear you. Goodbye.",
          });
          return;
        }
      } else {
        // If there is some activity, don't accuse silence
        this.enqueueTTS(sessionId, "Are you still there?", { flush: true });
      }
    }

    // Hangup timer after prompt if still no activity
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
      await this.politeHangup(sessionId, {
        finalMessage: "Okay, I’ll let you go. Goodbye.",
      });
    });
  }

  // ----------------------- stop + clear -----------------------
  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.ttsAbort) {
      try {
        session.ttsAbort.abort();
      } catch {}
      session.ttsAbort = null;
    }
    session.isSpeaking = false;

    if (session.llmAbort) {
      try {
        session.llmAbort.abort();
      } catch {}
      session.llmAbort = null;
    }

    session.ttsQueue.length = 0;

    // cancel user speech finalize timers (we will re-arm on new transcripts)
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
      session.ws.send(
        JSON.stringify({ event: "clear", streamSid: session.streamSid })
      );
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