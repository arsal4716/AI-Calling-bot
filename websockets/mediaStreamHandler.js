const WebSocket = require("ws");
const TwilioService = require("../services/TwilioService");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

// helpers
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

const USER_SILENCE_TIMEOUT_MS = 250; 
const MIN_UTTERANCE_LENGTH = 2; 

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

            // arm start-silence fallback
            this.armStartSilence(sessionId);

            // play campaign greeting if configured
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

      // Deepgram readiness markers
      dgOpenAt: 0,
      twilioStartAt: 0,

      // audio / llm
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

      // debounce clear
      lastClearAt: 0,

      // timers
      timers: {
        startSpeak: null,
        startHangup: null,
        midCheck: null,
        midHangup: null,
      },

      startSilenceFlowArmed: false,

      // --- NEW: user speech state for low-latency triggering ---
      userSpeech: {
        isSpeaking: false,           // true from SpeechStarted until silence timer fires
        buffer: "",                   // latest transcript (interim or final)
        lastInterimTime: 0,           // timestamp of last received interim
        silenceTimer: null,           // setTimeout handle for utterance processing
        // optional: store last processed to avoid duplicate finals (not used yet)
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

    const greetingText = safeTTS(
      renderTemplate(session.openingLine, { agentname: session.agentName })
    );
    if (!greetingText) return;

    session.initialGreetingSent = true;

    session.conversationHistory.push({ role: "assistant", content: greetingText });
    session.conversationHistory = session.conversationHistory.slice(-12);

    logger.info(`[${sessionId}] Playing initial greeting: "${greetingText}"`);
    this.enqueueTTS(sessionId, greetingText, { flush: true });

    // start mid-call silence after greeting begins
    this.armMidCallSilence(sessionId);
  }

  // ----------------------- START-SILENCE (unchanged) -----------------------
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

      this.enqueueTTS(sessionId, "Hello, can you hear me?", { flush: true });

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
              finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
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

  // ----------------------- deepgram events + barge-in (REVISED) -----------------------
  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._markUserActivity(session);

    // Reset user speech state for a new utterance
    const us = session.userSpeech;
    if (us.silenceTimer) {
      clearTimeout(us.silenceTimer);
      us.silenceTimer = null;
    }
    us.isSpeaking = true;
    us.buffer = "";               // start fresh
    us.lastInterimTime = Date.now();

    // Barge-in: if AI is speaking, stop it
    if (session.isSpeaking) {
      logger.info(`[${sessionId}] BARGE-IN (SpeechStarted) stopping TTS`);
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
    }
  }

onDeepgramTranscript(sessionId, text, isFinal, speechFinal) {
  const session = this.sessions.get(sessionId);
  if (!session) return;

  const trimmed = (text || "").trim();
  if (!trimmed) return;

  this._markUserActivity(session);

  // existing logic...
  const us = session.userSpeech;
  us.buffer = trimmed;
  us.lastInterimTime = Date.now();

  if (us.silenceTimer) {
    clearTimeout(us.silenceTimer);
    us.silenceTimer = null;
  }

  if (trimmed.length >= MIN_UTTERANCE_LENGTH && !session.isProcessingUtterance && !session.isClosing) {
    us.silenceTimer = setTimeout(() => {
      this._processUserUtterance(sessionId);
    }, USER_SILENCE_TIMEOUT_MS);
  }
}
_processUserUtterance(sessionId) {
  const session = this.sessions.get(sessionId);
  if (!session) return;
  if (session.isClosing || session.isCleaning) return;
  if (session.isProcessingUtterance) return;

  const us = session.userSpeech;
  if (us.silenceTimer) {
    clearTimeout(us.silenceTimer);
    us.silenceTimer = null;
  }

  const utterance = (us.buffer || "").trim();
  if (!utterance || utterance.length < MIN_UTTERANCE_LENGTH) {
    us.isSpeaking = false;
    us.buffer = "";
    return;
  }
  this._markUserActivity(session);

  logger.info(`[${sessionId}] Processing utterance (silence-triggered): "${utterance}"`);
  this.handleUserUtterance(sessionId, utterance).catch(/*...*/);

  us.isSpeaking = false;
  us.buffer = "";
}
  // ----------------------- TTS single pipeline (unchanged) -----------------------
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

        // wait a tiny bit if Twilio not ready
        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          await sleep(40);
          s.ttsQueue.unshift(textToSpeak);
          continue;
        }

        const audioStream = await this.getAudioStream(sessionId, textToSpeak);
        if (!audioStream) continue;

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

        // arm mid-call silence after each spoken chunk
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

          session.ws.send(
            JSON.stringify({
              event: "media",
              streamSid: session.streamSid,
              media: { payload: frame.toString("base64") },
            })
          );

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

  // ----------------------- LLM streaming (unchanged except minor) -----------------------
  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;
    if (session.isProcessingUtterance) return;

    session.isProcessingUtterance = true;

    const t0 = Date.now();
    try {
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);

      // abort any previous LLM
      if (session.llmAbort) {
        try { session.llmAbort.abort(); } catch {}
      }
      const llmController = new AbortController();
      session.llmAbort = llmController;

      const historyForModel = session.conversationHistory.slice(-8); // smaller for speed
      const systemPrompt =
        session.systemPrompt ||
        "You are a natural phone agent. Reply briefly and ask one short question.";

      logger.info(`[${sessionId}] LLM_START input="${userText}"`);

      let fullText = "";
      let firstTokenAt = 0;

      const chunker = new SentenceChunker((sentence) => {
        const sanitized = safeTTS(sentence);
        if (!sanitized) return;

        if (sanitized.length < 10 && !/[.!?]$/.test(sanitized)) return;

        logger.info(`[${sessionId}] TTS_CHUNK: "${sanitized}"`);
        this.enqueueTTS(sessionId, sanitized);
      });

      // speed tuning
      try {
        chunker.minChunkLength = 10;
        chunker.maxChunkLength = 80;
      } catch {}

      for await (const delta of this.openaiService.streamResponse(
        userText,
        systemPrompt,
        historyForModel,
        llmController.signal
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

      const aiText = sanitizeForTTS(fullText);

      // Store user message (interim) and assistant response in history
      session.conversationHistory.push({ role: "user", content: userText });
      if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
      session.conversationHistory = session.conversationHistory.slice(-12);
    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance error: ${e.message}`);
      }
    } finally {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        s.llmAbort = null;
      }
    }
  }

  // ----------------------- mid-call silence (unchanged) -----------------------
  armMidCallSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");

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
        await this.politeHangup(sessionId, {
          finalMessage: "Okay, I’ll let you go. Goodbye.",
        });
      });
    });
  }

  // ----------------------- stop + clear (unchanged) -----------------------
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

    // clear queued audio on barge-in
    session.ttsQueue.length = 0;
  }

  sendClearToTwilio(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.ws || !session.streamSid) return;

    const now = Date.now();
    if (now - (session.lastClearAt || 0) < 250) return; // debounce
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

  // ----------------------- hangup + cleanup (unchanged) -----------------------
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
      // Clear any user speech timer
      if (session.userSpeech?.silenceTimer) {
        clearTimeout(session.userSpeech.silenceTimer);
        session.userSpeech.silenceTimer = null;
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