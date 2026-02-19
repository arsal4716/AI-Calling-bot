const WebSocket = require("ws");
const TwilioService = require("../services/TwilioService");
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
    logger.info("MediaStreamHandler initialized");
    this.twilioService = new TwilioService({
      getActiveSessionCount: () => this.sessions.size,
    });
    this.setupWebSocket();
    setInterval(() => this.cleanupInactiveSessions(), 30000);
  }

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const sessionId = req.url.split("/").pop();
      logger.info(`[${sessionId}] WEBSOCKET CONNECTED`);
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));

      this.initializeSession(sessionId, ws).catch((err) =>
        logger.error(
          `[${sessionId}] Immediate Session Init failed: ${err.message}`,
        ),
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
            if (session) {
              session.streamSid = data.start?.streamSid || session.streamSid;
              session.isTwilioReady = true;
              session.lastActivity = Date.now();
              logger.info(
                `[${sessionId}] Twilio START: streamSid=${session.streamSid}`,
              );

              // [ADDED] Issue #1: start-call silence flow
              this.onTwilioStart(sessionId);

              this.maybePlayInitialGreeting(sessionId).catch(() => { });
            }
            break;
          }

          case "media": {
            const activeSession = this.sessions.get(sessionId);
            if (!activeSession) return;

            activeSession.lastActivity = Date.now();
            const audio = Buffer.from(data.media.payload, "base64");
            if (audio.length > 0) {
              this.deepgramService.sendAudio(sessionId, audio);
            }
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
      timers: {
        startNoSpeech: null,
        afterGreetNoSpeech: null,
        afterAiNoSpeech: null,
        afterCheckNoSpeech: null,
      },
      initialGreetingSent: false,
      hasUserSpoken: false,
      startSilenceFlowArmed: false,
      startHelloSent: false,
      midCallCheckSent: false,
    };
  }

  // NOTE: Your file had TWO initializeSession() definitions.
  // The second one overwrote the first at runtime.
  // [MODIFIED] Keep ONE initializeSession and merge the important Deepgram callback wiring from your first version.
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
    if (
      !session ||
      session.initialGreetingSent ||
      !session.campaign ||
      !session.openingLine
    ) {
      return;
    }
    if (!session.isTwilioReady || !session.streamSid) {
      logger.info(
        `[${sessionId}] Greeting ready, waiting for Twilio streamSid...`,
      );
      return;
    }

    const greetingText = safeTTS(
      renderTemplate(session.openingLine, {
        agentname: session.agentName,
      }),
    );
    if (!greetingText) return;

    session.initialGreetingSent = true;

    session.conversationHistory.push({ role: "assistant", content: greetingText });
    session.conversationHistory = session.conversationHistory.slice(-12);

    logger.info(`[${sessionId}] Playing initial greeting: "${greetingText}"`);
    this.playTTS(sessionId, greetingText).catch((e) =>
      logger.error(
        `[${sessionId}] Initial greeting TTS failed: ${e.message}`,
      ),
    );

    // [ADDED] Issue #2: after any AI speaks first, arm mid-call silence flow
    this.armAfterAiSilenceFlow(sessionId);
  }

  // =========================
  // [ADDED] Silence-timer utilities (single-source of truth)
  // =========================
  _clearTimer(session, key) {
    if (!session?.timers) return;
    if (session.timers[key]) {
      clearTimeout(session.timers[key]);
      session.timers[key] = null;
    }
  }

  _clearAllSilenceTimers(session) {
    if (!session?.timers) return;
    this._clearTimer(session, "startNoSpeech");
    this._clearTimer(session, "afterGreetNoSpeech");
    this._clearTimer(session, "afterAiNoSpeech");
    this._clearTimer(session, "afterCheckNoSpeech");
  }

  _setTimer(sessionId, key, ms, fn) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Prevent multiple timers of the same purpose
    this._clearTimer(session, key);

    session.timers[key] = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      // Ensure we don't run stale timers after cleanup / state changes
      if (s.isClosing) return;
      fn();
    }, ms);
  }

  _markUserActivity(session) {
    session.lastSpeechAt = Date.now();
    session.hasUserSpoken = true;

    // Reset all silence flows when user activity happens
    this._clearAllSilenceTimers(session);

    // Mid-call checks should be re-eligible after user speaks again
    session.midCallCheckSent = false;

    // Once user speaks, start-call flow no longer needed
    session.startSilenceFlowArmed = false;
  }

  // =========================
  // [ADDED] Issue #1 Start-call silence flow
  // =========================
  onTwilioStart(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Arm only once per call
    if (session.startSilenceFlowArmed) return;
    session.startSilenceFlowArmed = true;

    // Don't stack old timers
    this._clearTimer(session, "startNoSpeech");
    this._clearTimer(session, "afterGreetNoSpeech");

    // If AI already greeted (campaign openingLine) or has spoken for any reason, do not force "Hello, can you hear me?"
    const aiAlreadySpoke =
      session.initialGreetingSent || (session.lastAiSpokeAt && session.lastAiSpokeAt > 0);

    this._setTimer(sessionId, "startSpeak", 1200, async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (s.hasUserSpoken) return;
      if (s.initialGreetingSent) return;
      if (s.isSpeaking || s.isProcessingUtterance) return;

      // Fast fallback greeting
      this.enqueueTTS(sessionId, "Hello, can you hear me?", { flush: true });

      // Wait 3 seconds after asking, then hangup if still silent
      this._setTimer(sessionId, "startHangup", 3000, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        if (ss.hasUserSpoken) return;

        logger.info(
          `[${sessionId}] START-SILENCE: still silent after hello → hangup`,
        );
        await this.politeHangup(sessionId, {
          finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
        });
      });
    });
  }

  // =========================
  // [MODIFIED] Speech handlers to reset timers reliably
  // =========================
  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._markUserActivity(session);

    if (session.isSpeaking) {
      logger.info("BARGE-IN (SpeechStarted) stopping TTS");
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
    }
  }

  onDeepgramTranscript(sessionId, text, isFinal, speechFinal) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const interim = (text || "").trim();
    const looksReal = interim.length >= 3 || /\s/.test(interim);

    if (looksReal) this._markUserActivity(session);

    if (!isFinal && session.isSpeaking && looksReal) {
      logger.info("BARGE-IN (interim transcript) stopping TTS");
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
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

        this.armAfterAiSilenceFlow(sessionId);

        if (session.isClosing) break;
      }
    } finally {
      session.ttsQueueRunning = false;
    }
  }

  // =========================
  // [ADDED] Issue #2 Mid-call silence flow (after AI response)
  // =========================
  armAfterAiSilenceFlow(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");

    this._setTimer(sessionId, "midCheck", 6000, async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (s.hasUserSpoken && Date.now() - s.lastSpeechAt < 2500) return;
      if (s.isSpeaking || s.isProcessingUtterance) return;

      this.enqueueTTS(sessionId, "Are you still there?", { flush: true });

      this._setTimer(sessionId, "midHangup", 3000, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        if (ss.hasUserSpoken && Date.now() - ss.lastSpeechAt < 2500) return;

        logger.info(`[${sessionId}] MID-SILENCE: still silent → hangup`);
        await this.politeHangup(sessionId, {
          finalMessage: "Okay, I’ll let you go. Goodbye.",
        });
      });
    });
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
      this._clearAllSilenceTimers(session);

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
      if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
      session.conversationHistory = session.conversationHistory.slice(-16);

      // Re-arm mid-call silence after AI finishes queue
      // (runTTSQueue already arms after each play)
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
    logger.info(
      `[${sessionId}] TTS_START text="${finalText.substring(0, 50)}..."`,
    );

    try {
      const audioStream =
        await this.elevenlabsService.streamTextToSpeechFast(
          finalText,
          session.campaign.voiceId,
          session.campaign.voiceSettings,
        );

      logger.info(
        `[${sessionId}] TTS_STREAM_RECEIVED latency=${Date.now() - ttsStart}ms`,
      );

      await this.streamDirectULawToTwilio(sessionId, audioStream, ac.signal);

      logger.info(
        `[${sessionId}] TTS_COMPLETE total=${Date.now() - ttsStart}ms`,
      );
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

  async _waitForTTSIdle(sessionId, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (!s.isSpeaking && !s.ttsQueueRunning && s.ttsQueue.length === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async politeHangup(sessionId, { finalMessage } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing) return;

    session.isClosing = true;
    this._clearAllSilenceTimers(session);

    try {
      if (finalMessage) {
        this.enqueueTTS(sessionId, finalMessage, { flush: true });
        await this._waitForTTSIdle(sessionId, 9000);
      }
    } catch { }

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
      this.stopTTS(sessionId);
      this._clearAllSilenceTimers(session);
    } catch { }

    try {
      this.deepgramService.closeTranscriptionStream(sessionId);
    } catch { }

    try {
      if (session.callLog) {
        const durationApprox = Math.floor((Date.now() - session.startTime) / 1000);
        if (!session.callLog.duration || session.callLog.duration === 0) {
          session.callLog.duration = durationApprox;
        }
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
