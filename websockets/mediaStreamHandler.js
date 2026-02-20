const WebSocket = require("ws");
const TwilioService = require("../services/TwilioService");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

// ----------------------- helpers -----------------------
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

// ----------------------- handler -----------------------
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

      // init ASAP
      this.initializeSession(sessionId, ws).catch((err) =>
        logger.error(`[${sessionId}] Immediate Session Init failed: ${err.message}`),
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
            session.lastActivity = Date.now();
            logger.info(`[${sessionId}] Twilio START: streamSid=${session.streamSid}`);

            // start-silence fallback (only if no campaign greeting played)
            this.onTwilioStart(sessionId);

            // play campaign greeting when ready
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

      // speaking + queues
      isSpeaking: false,
      ttsAbort: null,
      llmAbort: null,

      ttsQueue: [],
      ttsQueueRunning: false,

      // gating
      isClosing: false,
      isCleaning: false,
      isProcessingUtterance: false,

      // activity
      lastSpeechAt: Date.now(),
      lastAiSpokeAt: 0,
      startTime: Date.now(),
      hasUserSpoken: false,
      initialGreetingSent: false,

      // timers (ONLY keys that are actually used)
      timers: {
        startSpeak: null,
        startHangup: null,
        midCheck: null,
        midHangup: null,
      },

      // state
      startSilenceFlowArmed: false,
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
    for (const k of Object.keys(session.timers)) {
      this._clearTimer(session, k);
    }
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

    // IMPORTANT: cancel hangups / mid-check timers when user speaks
    this._clearAllTimers(session);
  }

  // ----------------------- greeting + start silence -----------------------
  async maybePlayInitialGreeting(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.initialGreetingSent) return;
    if (!session.campaign || !session.openingLine) return;

    if (!session.isTwilioReady || !session.streamSid) {
      logger.info(`[${sessionId}] Greeting ready, waiting for Twilio streamSid...`);
      return;
    }

    const greetingText = safeTTS(
      renderTemplate(session.openingLine, { agentname: session.agentName }),
    );
    if (!greetingText) return;

    session.initialGreetingSent = true;
    session.conversationHistory.push({ role: "assistant", content: greetingText });
    session.conversationHistory = session.conversationHistory.slice(-16);

    logger.info(`[${sessionId}] Playing initial greeting: "${greetingText}"`);
    this.enqueueTTS(sessionId, greetingText, { flush: true });

    this.armMidCallSilence(sessionId);
  }

  onTwilioStart(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // only arm once
    if (session.startSilenceFlowArmed) return;
    session.startSilenceFlowArmed = true;

    // If campaign greeting exists and will play, we don't need the fallback hello.
    // But in case greeting isn't ready (delays), we do a short "hello can you hear me"
    // and hang up later ONLY if user still silent.
    this._setTimer(sessionId, "startSpeak", 1200, async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;

      // if user already spoke or greeting already sent, do nothing
      if (s.hasUserSpoken) return;
      if (s.initialGreetingSent) return;

      // speak quick
      this.enqueueTTS(sessionId, "Hello, can you hear me?", { flush: true });

      // give human time to respond (NOT 1 second)
      this._setTimer(sessionId, "startHangup", 4500, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        if (ss.hasUserSpoken) return;

        logger.info(`[${sessionId}] START-SILENCE: still silent → hangup`);
        await this.politeHangup(sessionId, {
          finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
        });
      });
    });
  }

  // ----------------------- deepgram events + barge-in -----------------------
  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._markUserActivity(session);

    // barge-in: stop AI audio instantly
    if (session.isSpeaking) {
      logger.info(`[${sessionId}] BARGE-IN (SpeechStarted) stopping TTS`);
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
    }
  }

  onDeepgramTranscript(sessionId, text, isFinal, speechFinal) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const interim = (text || "").trim();
    const looksReal = interim.length >= 2 || /\s/.test(interim);

    if (looksReal) this._markUserActivity(session);

    // barge-in on interim while speaking
    if (!isFinal && session.isSpeaking && looksReal) {
      logger.info(`[${sessionId}] BARGE-IN (interim transcript) stopping TTS`);
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
      return;
    }

    // only handle final end-of-utterance
    if (!isFinal || !speechFinal) return;
    if (!text || !text.trim()) return;

    this.handleUserUtterance(sessionId, text.trim()).catch((e) => {
      if (e?.name !== "AbortError") logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
    });
  }

  // ----------------------- TTS single pipeline -----------------------
  enqueueTTS(sessionId, text, { flush = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    const t = safeTTS(text);
    if (!t) return;

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

        // if Twilio not ready, wait a tiny bit
        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          await sleep(30);
          // put back and retry soon
          s.ttsQueue.unshift(textToSpeak);
          continue;
        }

        const audioStream = await this.getAudioStream(sessionId, textToSpeak);
        if (!audioStream) continue;

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

        // after each spoken chunk, arm mid-call silence logic
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
        session.campaign.voiceSettings,
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

    // IMPORTANT: use ONE abort controller for active TTS
    const ac = new AbortController();
    session.ttsAbort = ac;
    session.isSpeaking = true;
    session.lastAiSpokeAt = Date.now();

    const FRAME_BYTES = 160; // 20ms uLaw @ 8kHz
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
      // Start sending ASAP. If ElevenLabs is slow to begin, buffer will be small,
      // but as soon as we have 160 bytes we output a frame.
      while (!ac.signal.aborted) {
        if (buffer.length >= FRAME_BYTES) {
          const frame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);

          // send to Twilio
          session.ws.send(
            JSON.stringify({
              event: "media",
              streamSid: session.streamSid,
              media: { payload: frame.toString("base64") },
            }),
          );

          frameCount++;
          await sleep(FRAME_MS);
          continue;
        }

        if (ended) break;

        // tiny wait to reduce CPU but keep latency low
        await sleep(5);
      }
    } finally {
      // cleanup
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

  // ----------------------- LLM streaming + faster chunking -----------------------
  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;
    if (session.isProcessingUtterance) return;

    session.isProcessingUtterance = true;

    const t0 = Date.now();
    try {
      // stop any ongoing audio quickly so we can respond faster
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
      this._clearAllTimers(session);

      // abort any previous LLM stream
      if (session.llmAbort) {
        try { session.llmAbort.abort(); } catch {}
      }
      const llmController = new AbortController();
      session.llmAbort = llmController;

      const historyForModel = session.conversationHistory.slice(-12);
      const systemPrompt =
        session.systemPrompt ||
        "You are a natural phone agent. Reply briefly and ask one short question.";

      logger.info(`[${sessionId}] LLM_START input="${userText}"`);

      let fullText = "";
      let firstTokenAt = 0;

      // Tune chunker for speed: shorter minChunkLength = faster first audio
      const chunker = new SentenceChunker((sentence) => {
        const sanitized = safeTTS(sentence);
        if (!sanitized) return;

        // very short fragments create awkward pauses; allow short only if ends with punctuation
        if (sanitized.length < 10 && !/[.!?]$/.test(sanitized)) return;

        logger.info(`[${sessionId}] TTS_CHUNK: "${sanitized}"`);
        // enqueue (single pipeline)
        this.enqueueTTS(sessionId, sanitized);
      });
      // If your SentenceChunker supports these properties, this improves speed:
      // (won't crash if it doesn't)
      try {
        chunker.minChunkLength = 10;
        chunker.maxChunkLength = 80;
      } catch {}

      for await (const delta of this.openaiService.streamResponse(
        userText,
        systemPrompt,
        historyForModel,
        llmController.signal,
      )) {
        if (llmController.signal.aborted) break;

        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          logger.info(`[${sessionId}] LATENCY: first_token=${firstTokenAt - t0}ms`);
        }

        const cleanDelta = stripQCBlocks(delta);
        fullText += delta;
        chunker.add(cleanDelta);
      }

      chunker.end();
      logger.info(`[${sessionId}] LLM_COMPLETE total=${Date.now() - t0}ms`);

      // store convo
      const aiText = sanitizeForTTS(fullText);
      session.conversationHistory.push({ role: "user", content: userText });
      if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
      session.conversationHistory = session.conversationHistory.slice(-16);
    } catch (e) {
      if (e?.name !== "AbortError") logger.error(`[${sessionId}] handleUserUtterance error: ${e.message}`);
    } finally {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        s.llmAbort = null;
      }
    }
  }

  // ----------------------- silence flow (mid-call) -----------------------
  armMidCallSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");

    // If user spoke recently, don't check
    this._setTimer(sessionId, "midCheck", 7000, async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (s.isClosing || s.isCleaning) return;

      const sinceSpeech = Date.now() - (s.lastSpeechAt || 0);
      if (s.hasUserSpoken && sinceSpeech < 3000) return;
      if (s.isSpeaking || s.isProcessingUtterance) return;

      this.enqueueTTS(sessionId, "Are you still there?", { flush: true });

      this._setTimer(sessionId, "midHangup", 4500, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        if (ss.isClosing || ss.isCleaning) return;

        const sinceSpeech2 = Date.now() - (ss.lastSpeechAt || 0);
        if (ss.hasUserSpoken && sinceSpeech2 < 3000) return;

        logger.info(`[${sessionId}] MID-SILENCE: still silent → hangup`);
        await this.politeHangup(sessionId, { finalMessage: "Okay, I’ll let you go. Goodbye." });
      });
    });
  }

  // ----------------------- stop + clear -----------------------
  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // stop current audio
    if (session.ttsAbort) {
      try { session.ttsAbort.abort(); } catch {}
      session.ttsAbort = null;
    }
    session.isSpeaking = false;

    // stop current LLM
    if (session.llmAbort) {
      try { session.llmAbort.abort(); } catch {}
      session.llmAbort = null;
    }

    // optionally clear queued audio on barge-in
    session.ttsQueue.length = 0;
  }

  sendClearToTwilio(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.ws || !session.streamSid) return;

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

  // ----------------------- transfer + hangup + cleanup -----------------------
  async endTwilioCall(sessionId) {
    const session = this.sessions.get(sessionId);
    const callSid = session?.callLog?.callSid;
    if (!callSid) return;
    await this.twilioService.endCallHard(callSid);
  }

  async transferToBuyer(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.callLog?.callSid) throw new Error("Missing callSid for transfer");

    const buyerDid = String(session?.campaign?.transferSettings?.number || "").trim();
    const enabled = !!session?.campaign?.transferSettings?.enabled;

    if (!enabled || !buyerDid) {
      throw new Error("Transfer disabled or buyer DID missing in campaign");
    }

    session.isClosing = true;
    this._clearAllTimers(session);
    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    await this.twilioService.transferCall(session.callLog.callSid, buyerDid);
    await this.cleanupSession(sessionId);
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