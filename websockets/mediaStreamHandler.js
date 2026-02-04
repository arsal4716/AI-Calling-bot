// websockets/mediaStreamHandler.js
const WebSocket = require("ws");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const AudioService = require("../utils/audio");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");
function sanitizeForTTS(text) {
  return (text || "")
    .replace(/\(short pause\)/gi, "")
    .replace(/\(pause\)/gi, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

class MediaStreamHandler {
  constructor(wss) {
    this.wss = wss;
    this.sessions = new Map();

    this.deepgramService = new DeepgramService();
    this.openaiService = new OpenAIService();
    this.elevenlabsService = new ElevenLabsService();
    this.campaignService = new CampaignService();

    logger.info("MediaStreamHandler initialized");

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

          // ✅ Reduced delay - Twilio is ready faster than you think
          setTimeout(() => {
            this.playTTS(sessionId, "Hello! How can I help today?").catch((e) =>
              logger.error("Welcome TTS failed: " + e.message)
            );
          }, 200); // Reduced from 400ms

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
        logger.error(`Session init failed: ${err.message}`)
      );
    });
  }

  createEmptySession(sessionId, ws) {
    return {
      id: sessionId,
      ws,
      callLog: null,
      campaign: null,
      prompt: null,
      conversationHistory: [],
      lastActivity: Date.now(),
      isTwilioReady: false,
      streamSid: null,

      isSpeaking: false,
      ttsAbort: null,
      ttsGeneration: 0,

      llmAbort: null,
      llmGeneration: 0,

      lastSpeechAt: 0,
      isProcessingUtterance: false,
      isCleaning: false,

      silenceTimer: null,
      lastAiSpokeAt: 0,
      startTime: Date.now(),
    };
  }

  async initializeSession(sessionId, ws) {
    logger.info(`Initializing session: ${sessionId}`);

    const callLog = await CallLog.findById(sessionId).populate("campaign");
    if (!callLog) {
      logger.error(`CallLog not found for ${sessionId}`);
      return;
    }

    const { campaign, prompt } =
      await this.campaignService.getCampaignWithPrompt(callLog.campaign._id);

    const existing = this.sessions.get(sessionId);
    const session = existing || this.createEmptySession(sessionId, ws);

    session.ws = ws;
    session.callLog = callLog;
    session.campaign = campaign;
    session.prompt = prompt;

    this.sessions.set(sessionId, session);

    await this.deepgramService.createTranscriptionStream(sessionId, {
      onSpeechStarted: () => this.onUserSpeechStarted(sessionId),
      onTranscript: ({ text, isFinal, speechFinal }) =>
        this.onDeepgramTranscript(sessionId, text, isFinal, speechFinal),
    });

    logger.info(`Session initialized: ${sessionId}`);
  }

  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastSpeechAt = Date.now();

    // ✅ Only stop if actually speaking - reduces unnecessary work
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

    logger.info(
      `DG ${isFinal ? "final" : "interim"}: ${text} (speech_final=${speechFinal})`
    );

    session.lastSpeechAt = Date.now();

    // Interim barge-in - only if currently speaking
    const interim = (text || "").trim();
    const looksReal = interim.length >= 6 || /\s/.test(interim);
    
    if (!isFinal && session.isSpeaking && looksReal) {
      logger.info("BARGE-IN (interim transcript) stopping TTS");
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
      this.clearSilenceTimer(session);
      return;
    }

    // Only handle final + speech_final
    if (!isFinal || !speechFinal || !text || !text.trim()) return;

    this.handleUserUtterance(sessionId, text.trim()).catch((e) => {
      if (e?.name !== "AbortError") {
        logger.error("handleUserUtterance failed: " + e.message);
      }
    });
  }

async handleUserUtterance(sessionId, userText) {
  const session = this.sessions.get(sessionId);
  if (!session) return;
  if (session.isProcessingUtterance) return;

  session.isProcessingUtterance = true;
  const t0 = Date.now();

  let myGen = 0;

  try {
    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);
    this.clearSilenceTimer(session);

    session.llmGeneration += 1;
    myGen = session.llmGeneration;

    if (session.llmAbort) {
      try { session.llmAbort.abort(); } catch {}
    }

    const llmController = new AbortController();
    session.llmAbort = llmController;

    const historyForModel = session.conversationHistory.slice(-12);
    const systemPrompt = session.prompt ||
      "You are a natural phone agent. Reply in 1-2 short sentences, then ask exactly one question. No stage directions like (pause).";

    logger.info(`[${sessionId}] LLM_START input="${userText}"`);

    const isValid = () => this.sessions.get(sessionId)?.llmGeneration === myGen;

    let fullText = "";
    let firstTokenAt = 0;

    // TTS queue for sequential playback
    const ttsQueue = [];
    let isTtsPlaying = false;
    let ttsError = null;

    // Process TTS queue
    const processTtsQueue = async () => {
      if (isTtsPlaying || ttsQueue.length === 0) return;
      if (!isValid()) return;

      isTtsPlaying = true;

      while (ttsQueue.length > 0 && isValid()) {
        const sentence = ttsQueue.shift();
        try {
          await this.playTTS(sessionId, sentence);
        } catch (e) {
          if (e?.name !== "AbortError") {
            ttsError = e;
            logger.error(`TTS queue error: ${e.message}`);
          }
          break;
        }
      }

      isTtsPlaying = false;
    };

    // Sentence chunker - emits sentences for TTS as soon as they're complete
    const chunker = new SentenceChunker((sentence) => {
      if (!isValid()) return;
      
      const sanitized = sanitizeForTTS(sentence);
      if (!sanitized) return;

      logger.info(`[${sessionId}] TTS_CHUNK: "${sanitized}"`);
      ttsQueue.push(sanitized);
      
      // Start processing queue (non-blocking)
      processTtsQueue().catch(e => {
        if (e?.name !== "AbortError") {
          logger.error(`TTS queue error: ${e.message}`);
        }
      });
    });

    // Stream from LLM
    for await (const delta of this.openaiService.streamResponse(
      userText,
      systemPrompt,
      historyForModel,
      llmController.signal
    )) {
      if (!isValid()) break;

      if (!firstTokenAt) {
        firstTokenAt = Date.now();
        logger.info(`[${sessionId}] LATENCY: first_token=${firstTokenAt - t0}ms`);
      }

      fullText += delta;
      
      // Feed to sentence chunker - may trigger TTS immediately!
      chunker.add(delta);
    }

    // Flush any remaining text
    chunker.end();

    logger.info(`[${sessionId}] LLM_COMPLETE output="${sanitizeForTTS(fullText)}" total=${Date.now() - t0}ms`);

    // Wait for all TTS to complete
    while ((ttsQueue.length > 0 || isTtsPlaying) && isValid()) {
      await new Promise(r => setTimeout(r, 50));
    }

    // Update conversation history
    const aiText = sanitizeForTTS(fullText);
    session.conversationHistory.push({ role: "user", content: userText });
    if (aiText) {
      session.conversationHistory.push({ role: "assistant", content: aiText });
    }
    session.conversationHistory = session.conversationHistory.slice(-12);

    session.lastAiSpokeAt = Date.now();

    // Start silence timer after speaking
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
      if (s.llmAbort && s.llmGeneration === myGen) s.llmAbort = null;
    }
  }
}


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

    session.isSpeaking = true;
    session.ttsGeneration += 1;
    const myTtsGen = session.ttsGeneration;

    const ac = new AbortController();
    session.ttsAbort = ac;

    const ttsStart = Date.now();
    logger.info(`[${sessionId}] TTS_START text="${text.substring(0, 50)}..."`);

    try {
      const audioStream = await this.elevenlabsService.streamTextToSpeech(
        text,
        session.campaign.voiceId,
        session.campaign.voiceSettings
      );

      logger.info(`[${sessionId}] TTS_STREAM_RECEIVED latency=${Date.now() - ttsStart}ms`);

      await AudioService.streamElevenLabsToTwilio({
        ws: session.ws,
        streamSid: session.streamSid,
        inputAudioStream: audioStream,
        abortSignal: ac.signal,
        isStillValid: () =>
          this.sessions.get(sessionId)?.ttsGeneration === myTtsGen,
      });
    } catch (e) {
      if (e?.name === "AbortError") {
        logger.info(`[${sessionId}] TTS aborted (barge-in)`);
        return;
      }
      logger.error(`[${sessionId}] TTS error: ${e.message}`);
    } finally {
      const s = this.sessions.get(sessionId);
      if (s && s.ttsGeneration === myTtsGen) {
        s.isSpeaking = false;
        s.ttsAbort = null;
      }
    }
  }

  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Increment generations to invalidate in-flight operations
    session.ttsGeneration += 1;
    session.isSpeaking = false;

    if (session.ttsAbort) {
      try {
        session.ttsAbort.abort();
      } catch {}
      session.ttsAbort = null;
    }

    session.llmGeneration += 1;
    if (session.llmAbort) {
      try {
        session.llmAbort.abort();
      } catch {}
      session.llmAbort = null;
    }
  }

  sendClearToTwilio(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.ws || !session.streamSid) return;

    try {
      session.ws.send(
        JSON.stringify({ event: "clear", streamSid: session.streamSid })
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
        () => {}
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
    } catch {}

    try {
      this.deepgramService.closeTranscriptionStream(sessionId);
    } catch {}

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
