const WebSocket = require("ws");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

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

class MediaStreamHandler {
  constructor(wss) {
    this.wss = wss;
    this.sessions = new Map();

    this.deepgramService = new DeepgramService();
    this.openaiService = new OpenAIService();
    this.elevenlabsService = new ElevenLabsService();
    this.campaignService = new CampaignService();

    logger.info("MediaStreamHandler initialized - NO FFMPEG VERSION");

    this.setupWebSocket();
    setInterval(() => this.cleanupInactiveSessions(), 30000);
  }

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const sessionId = req.url.split("/").pop();
      logger.info(`WEBSOCKET CONNECTED: ${sessionId}`);

      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));

      ws.on("message", async (msg) => {
        let data;
        try {
          data = JSON.parse(msg.toString());
        } catch (e) {
          logger.error(`Message parsing error: ${e.message}`);
          return;
        }

        if (data.event === "start") {
          let session = this.sessions.get(sessionId);
          if (!session) {
            session = this.createEmptySession(sessionId, ws);
            this.sessions.set(sessionId, session);
          }

          session.streamSid = data.start?.streamSid || session.streamSid;
          session.isTwilioReady = true;
          session.lastActivity = Date.now();

          logger.info(`Twilio START ready: streamSid=${session.streamSid}`);

          this.maybePlayInitialGreeting(sessionId).catch(() => { });

          return;
        }

        if (data.event === "media") {
          const session = this.sessions.get(sessionId);
          if (!session) return;
          session.lastActivity = Date.now();

          const audio = Buffer.from(data.media.payload, "base64");
          if (audio.length > 0) {
            this.deepgramService.sendAudio(sessionId, audio);
          }
          return;
        }

        if (data.event === "stop") {
          logger.info(`Twilio STOP event: ${sessionId}`);
          await this.cleanupSession(sessionId);
          return;
        }
      });

      ws.on("close", () => {
        logger.info(`WebSocket closed: ${sessionId}`);
        this.cleanupSession(sessionId);
      });

      ws.on("error", (err) => {
        logger.error(`WebSocket error: ${err.message}`);
        this.cleanupSession(sessionId);
      });

      this.initializeSession(sessionId, ws).catch((err) =>
        logger.error(`Session init failed: ${err.message}`),
      );
    });
  }

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

      isSpeaking: false,
      ttsAbort: null,
      ttsQueue: [],
      ttsQueueRunning: false,
      isClosing: false,

      isProcessingUtterance: false,
      llmAbort: null,
      lastSpeechAt: Date.now(),
      lastAiSpokeAt: 0,
      startTime: Date.now(),
      silenceTimer: null,
      initialGreetingSent: false,
    };
  }

  async initializeSession(sessionId, ws) {
    logger.info(`Initializing session: ${sessionId}`);

    const callLog = await CallLog.findById(sessionId).populate("campaign");
    if (!callLog) {
      logger.error(`CallLog not found for ${sessionId}`);
      return;
    }

    const data = await this.campaignService.getCampaignWithPrompt(
      callLog.campaign._id,
    );
    if (!data) return;

    const { campaign, systemPrompt, openingLine, agentName } = data;

    const existing = this.sessions.get(sessionId);
    const session = existing || this.createEmptySession(sessionId, ws);

    session.ws = ws;
    session.callLog = callLog;
    session.campaign = campaign;
    session.direction = String(callLog.direction || callLog.Direction || "")
      .toLowerCase()
      .trim();

    session.systemPrompt = systemPrompt;
    session.openingLine = openingLine;
    session.agentName = agentName || "Anna";

    this.sessions.set(sessionId, session);

    await this.deepgramService.createTranscriptionStream(sessionId, {
      onSpeechStarted: () => this.onUserSpeechStarted(sessionId),
      onTranscript: ({ text, isFinal, speechFinal }) =>
        this.onDeepgramTranscript(sessionId, text, isFinal, speechFinal),
    });

    logger.info(`Session initialized: ${sessionId}`);
    this.maybePlayInitialGreeting(sessionId).catch(() => { });
  }

  async maybePlayInitialGreeting(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.initialGreetingSent) return;
    if (!session.isTwilioReady || !session.streamSid) return;
    if (!session.campaign) return;
    if (!session.systemPrompt) return;

    const isOutbound = session.direction.startsWith("outbound");

    let greetingText = "";
    if (isOutbound) {
      greetingText = renderTemplate(session.openingLine, {
        agentname: session.agentName,
      });
    } else {
      greetingText = renderTemplate(session.openingLine, {
        agentname: session.agentName,
      });
    }

    greetingText = safeTTS(greetingText);
    if (!greetingText) return;

    session.initialGreetingSent = true;
    session.conversationHistory.push({
      role: "assistant",
      content: greetingText,
    });
    session.conversationHistory = session.conversationHistory.slice(-12);

    this.playTTS(sessionId, greetingText).catch((e) =>
      logger.error("Initial greeting TTS failed: " + e.message),
    );
  }

  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastSpeechAt = Date.now();
    if (session.isSpeaking) {
      logger.info("BARGE-IN (SpeechStarted) stopping TTS");
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
    }

    this.clearSilenceTimer(session);
  }

  onDeepgramTranscript(sessionId, text, isFinal, speechFinal) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const interim = (text || "").trim();
    const looksReal = interim.length >= 4 || /\s/.test(interim);

    if (!isFinal && session.isSpeaking && looksReal) {
      logger.info("BARGE-IN (interim transcript) stopping TTS");
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
      this.clearSilenceTimer(session);
      return;
    }

    if (!isFinal || !speechFinal || !text || !text.trim()) return;

    this.handleUserUtterance(sessionId, text.trim()).catch((e) => {
      if (e?.name !== "AbortError") {
        logger.error("handleUserUtterance failed: " + e.message);
      }
    });
  }
  enqueueTTS(sessionId, text, { flush = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const t = safeTTS(text);
    if (!t) return;

    if (flush) session.ttsQueue.length = 0;
    session.ttsQueue.push(t);

    this.runTTSQueue(sessionId).catch((e) => {
      if (e?.name !== "AbortError")
        logger.error(`runTTSQueue error: ${e.message}`);
    });
  }

  async runTTSQueue(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.ttsQueueRunning) return;
    session.ttsQueueRunning = true;

    try {
      while (session.ttsQueue.length > 0) {
        if (session.isClosing && session.ttsQueue.length > 1) {
          session.ttsQueue = [session.ttsQueue[session.ttsQueue.length - 1]];
        }

        const next = session.ttsQueue.shift();
        if (!next) continue;

        await this.playTTS(sessionId, next);
        if (session.isClosing) break;
      }
    } finally {
      session.ttsQueueRunning = false;
    }
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isProcessingUtterance) return;

    session.isProcessingUtterance = true;
    const t0 = Date.now();

    try {
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
      this.clearSilenceTimer(session);

      if (session.llmAbort) {
        try {
          session.llmAbort.abort();
        } catch { }
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

      session.isClosing = false;

      const chunker = new SentenceChunker((sentence) => {
        const sanitized = safeTTS(sentence);
        if (!sanitized) return;

        if (sanitized.length < 16 && !/[.!?]$/.test(sanitized)) return;

        logger.info(`[${sessionId}] TTS_CHUNK: "${sanitized}"`);
        this.enqueueTTS(sessionId, sanitized);
      });

      for await (const delta of this.openaiService.streamResponse(
        userText,
        systemPrompt,
        historyForModel,
        llmController.signal,
      )) {
        if (llmController.signal.aborted) break;

        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          logger.info(
            `[${sessionId}] LATENCY: first_token=${firstTokenAt - t0}ms`,
          );
        }

        fullText += delta;
        chunker.add(stripQCBlocks(delta));
      }

      chunker.end();

      logger.info(`[${sessionId}] LLM_COMPLETE total=${Date.now() - t0}ms`);

      while (
        (session.ttsQueueRunning || session.ttsQueue.length > 0) &&
        !llmController.signal.aborted
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const aiText = sanitizeForTTS(fullText);

      session.conversationHistory.push({ role: "user", content: userText });
      if (aiText)
        session.conversationHistory.push({
          role: "assistant",
          content: aiText,
        });
      session.conversationHistory = session.conversationHistory.slice(-12);

      session.lastAiSpokeAt = Date.now();

      const s = this.sessions.get(sessionId);
      if (s && !s.isSpeaking && !s.isProcessingUtterance) {
        this.startSilenceTimer(sessionId);
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      logger.error("handleUserUtterance error: " + e.message);
    } finally {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        s.llmAbort = null;
      }
    }
  }

  /**
   * PLAY TTS WITHOUT FFMPEG - DIRECT ULAW STREAMING
   */
  async playTTS(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.isTwilioReady || !session.streamSid) {
      logger.warn(`[${sessionId}] TTS skipped - Twilio not ready`);
      return;
    }
    if (!session.campaign) {
      logger.warn(`[${sessionId}] TTS skipped - no campaign`);
      return;
    }

    const finalText = safeTTS(text);
    if (!finalText) return;

    session.isSpeaking = true;
    const ac = new AbortController();
    session.ttsAbort = ac;

    const ttsStart = Date.now();
    logger.info(`[${sessionId}] TTS_START text="${finalText.substring(0, 50)}..."`);

    try {
      const audioStream = await this.elevenlabsService.streamTextToSpeechFast(finalText, session.campaign.voiceId, session.campaign.voiceSettings);

      logger.info(`[${sessionId}] TTS_STREAM_RECEIVED latency=${Date.now() - ttsStart}ms`);

      await this.streamDirectULawToTwilio(sessionId, audioStream, ac.signal);

      logger.info(`[${sessionId}] TTS_COMPLETE total=${Date.now() - ttsStart}ms`);
    } catch (e) {
      if (e?.name === "AbortError") {
        logger.info(`[${sessionId}] TTS aborted (barge-in)`);
        return;
      }
      logger.error(`[${sessionId}] TTS error: ${e.message}`);
    } finally {
      const s = this.sessions.get(sessionId);
      if (s && s.ttsAbort === ac) {
        s.isSpeaking = false;
        s.ttsAbort = null;
      }
    }
  }

  async streamDirectULawToTwilio(sessionId, audioStream, abortSignal) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not ready");
    }

    const ws = session.ws;
    const streamSid = session.streamSid;
    let isAborted = false;
    let frameCount = 0;
    const startTime = Date.now();
    let buffer = Buffer.alloc(0);

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        isAborted = true;
        try {
          audioStream.destroy();
        } catch { }
        resolve();
      };

      if (abortSignal.aborted) return onAbort();
      abortSignal.addEventListener("abort", onAbort);

      audioStream.on("data", (chunk) => {
        if (isAborted) return;

        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 160 && !isAborted) {
          const frame = buffer.subarray(0, 160);
          buffer = buffer.subarray(160);

          try {
            ws.send(
              JSON.stringify({
                event: "media",
                streamSid: streamSid,
                media: { payload: frame.toString("base64") },
              }),
            );
            frameCount++;

            if (frameCount % 50 === 0) {
              logger.info(`[${sessionId}] Sent ${frameCount} frames`);
            }
          } catch (err) {
            logger.error(`[${sessionId}] Send error: ${err.message}`);
            reject(err);
            return;
          }
        }
      });

      audioStream.on("end", () => {
        if (isAborted) return;

        if (buffer.length > 0) {
          const frame = Buffer.alloc(160, 0xff);
          buffer.copy(frame, 0, 0, Math.min(buffer.length, 160));

          try {
            ws.send(
              JSON.stringify({
                event: "media",
                streamSid: streamSid,
                media: { payload: frame.toString("base64") },
              }),
            );
            frameCount++;
          } catch (err) {
            logger.error(`[${sessionId}] Final send error: ${err.message}`);
          }
        }

        const totalTime = Date.now() - startTime;
        logger.info(
          `[${sessionId}] Audio stream complete: ${frameCount} frames in ${totalTime}ms`,
        );

        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      });

      audioStream.on("error", (err) => {
        if (isAborted) return;

        logger.error(`[${sessionId}] Audio stream error: ${err.message}`);
        abortSignal.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  }

  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.isSpeaking = false;

    if (session.ttsAbort) {
      try {
        session.ttsAbort.abort();
      } catch { }
      session.ttsAbort = null;
    }

    if (session.llmAbort) {
      try {
        session.llmAbort.abort();
      } catch { }
      session.llmAbort = null;
    }
  }

  sendClearToTwilio(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.ws || !session.streamSid) return;

    try {
      session.ws.send(
        JSON.stringify({ event: "clear", streamSid: session.streamSid }),
      );
      logger.info(`[${sessionId}] Sent clear to Twilio`);
    } catch (e) {
      logger.error("clear send failed: " + e.message);
    }
  }

  startSilenceTimer(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.clearSilenceTimer(session);

    session.silenceTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;

      if (Date.now() - s.lastSpeechAt < 2500) return;
      if (s.isSpeaking || s.isProcessingUtterance) return;

      this.playTTS(sessionId, "Just checking — are you still there?").catch(
        () => { },
      );
    }, 10000);
  }

  clearSilenceTimer(session) {
    if (session?.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
  }

  async cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isCleaning) return;

    session.isCleaning = true;
    logger.info(`Cleaning session: ${sessionId}`);

    try {
      this.stopTTS(sessionId);
      this.clearSilenceTimer(session);
    } catch { }

    try {
      this.deepgramService.closeTranscriptionStream(sessionId);
    } catch { }

    try {
      if (session.callLog) {
        const duration = Math.floor((Date.now() - session.startTime) / 1000);
        session.callLog.status = "completed";
        session.callLog.duration = duration;
        session.callLog.endTime = new Date();
        await session.callLog.save();
      }
    } catch (e) {
      logger.error("callLog save failed: " + e.message);
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
        this.cleanupSession(sessionId);
      }
    }
  }
}

module.exports = MediaStreamHandler;
