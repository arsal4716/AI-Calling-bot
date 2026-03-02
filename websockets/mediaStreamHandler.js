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

// ---------------- Short Acknowledgment Words ----------------
// These words must trigger AI response ONLY when AI has finished speaking.
// When AI is speaking, they are treated as noise (barge-in guard handles this).
const SHORT_ACKNOWLEDGMENT_WORDS = new Set([
  // affirmative
  "yes", "yeah", "yep", "yup", "yea", "sure", "okay", "ok", "alright",
  "alright", "absolutely", "definitely", "certainly", "of course", "right",
  "correct", "exactly", "indeed", "true", "totally", "of course",
  // negative
  "no", "nope", "nah", "not really", "never",
  // acknowledgment/filler
  "hmm", "hm", "hmmm", "uh", "uhh", "um", "umm", "ah", "ahh",
  "oh", "ohh", "uh huh", "uhhuh", "mhm", "mmhm", "mm", "mmm",
  // positive reactions
  "great", "good", "nice", "cool", "awesome", "perfect", "fine",
  "sounds good", "got it", "i see", "i know", "i understand",
  "understood", "makes sense", "fair enough",
  // go on / continue cues
  "go ahead", "continue", "please", "and", "so", "tell me",
]);

/**
 * Returns true if the utterance is a short acknowledgment/filler
 * that should still trigger an AI response when AI is idle.
 */
function isShortAcknowledgment(text) {
  const t = (text || "").trim().toLowerCase().replace(/[?.!,]+$/, "");
  if (!t) return false;

  // Direct match
  if (SHORT_ACKNOWLEDGMENT_WORDS.has(t)) return true;

  // Single word check (covers misspellings like "yeahh", "noooo")
  if (wordCount(t) === 1 && t.length <= 6) return true;

  // Two-word phrase check
  if (wordCount(t) <= 2 && SHORT_ACKNOWLEDGMENT_WORDS.has(t)) return true;

  return false;
}

// ---------------- Disposition detection ----------------
const DISPOSITION_PATTERNS = [
  // DNC triggers
  { pattern: /do not call|remove me|take me off|stop calling|don't call/i, disposition: "DNC" },
  // Not interested
  { pattern: /not interested|no thank you|no thanks|don't want|not for me/i, disposition: "NOT_INTERESTED" },
  // Language barrier
  { pattern: /no english|don't speak english|habla español|no speak/i, disposition: "LANGUAGE_BARRIER" },
  // Callback
  { pattern: /call back|call me back|call me later|try again later|bad time|busy right now/i, disposition: "CALLBACK" },
  // Not qualified (common insurance disqualifiers)
  { pattern: /have insurance|already covered|medicare|medicaid|i have coverage/i, disposition: "NOT_QUALIFIED" },
  // Target hung up / hostile
  { pattern: /go to hell|leave me alone|stop bothering|scam|fraud/i, disposition: "DNC" },
];

/**
 * Detect disposition from conversation context.
 * Returns disposition string or null.
 */
function detectDisposition(utterance, conversationHistory = []) {
  const text = (utterance || "").trim();

  for (const { pattern, disposition } of DISPOSITION_PATTERNS) {
    if (pattern.test(text)) return disposition;
  }

  // Check last few history items for repeated unresponsiveness
  const assistantTurns = conversationHistory.filter(h => h.role === "assistant").length;
  const userTurns = conversationHistory.filter(h => h.role === "user").length;
  if (assistantTurns >= 3 && userTurns === 0) return "UNRESPONSIVE";

  return null;
}

// ---------------- tuning constants ----------------
const UTTERANCE_DEBOUNCE_MS = 650;
const UTTERANCE_HARD_MAX_MS = 1800;

// FIX #1: Allow short acknowledgment words (min 1 char, min 1 word)
// but ONLY when AI is not currently speaking.
// We keep stricter thresholds for barge-in interruption scenarios.
const MIN_UTTERANCE_CHARS = 1;           // allow "ok", "yes", etc.
const MIN_UTTERANCE_WORDS = 1;
const MIN_UTTERANCE_CHARS_BARGEIN = 6;   // during AI speech: higher threshold
const MIN_UTTERANCE_WORDS_BARGEIN = 2;   // during AI speech: require more content

// Echo/noise barge-in protection
const ECHO_GUARD_MS = 320;
const BARGEIN_CONFIRM_MS = 160;
const BARGEIN_MIN_CHARS = 4;

// Mid-call silence prompts
const MID_SILENCE_CHECK_MS = 11000;
const MID_SILENCE_HANGUP_MS = 7000;

// "cannot hear you" loop control
const CANT_HEAR_COOLDOWN_MS = 9000;
const CANT_HEAR_MAX_RETRIES = 2;

// Post-AI-speech buffer: time to wait after AI stops speaking before accepting
// short utterances. Prevents echo/TTS tail from triggering.
const POST_AI_SPEECH_BUFFER_MS = 400;

// History limits
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

      // turn + ordering control
      activeTurnId: 0,
      lastProcessedAt: 0,

      // echo guard
      lastAiAudioSentAt: 0,
      // FIX: track when AI *finished* speaking (for post-AI-speech buffer)
      lastAiSpeechEndAt: 0,

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

      // external state
      state: {
        qualified: false,
        zip: "",
        fullName: "",
        retriesCantHear: 0,
        lastCantHearAt: 0,
      },

      // FIX: disposition tracking
      pendingDisposition: null,

      // user speech aggregation
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
        "Hi, thank you for taking the call. This is Anna with healthcare benefits. I hope you are doing well";

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
              finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
              disposition: "UNRESPONSIVE",
            });
          });
          return;
        }

        logger.info(`[${sessionId}] START-SILENCE: still silent → hangup`);
        await this.politeHangup(sessionId, {
          finalMessage: "Sorry, I can't hear you. I'll hang up now. Goodbye.",
          disposition: "UNRESPONSIVE",
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

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us.hardMaxTimer) { clearTimeout(us.hardMaxTimer); us.hardMaxTimer = null; }

    us.hardMaxTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, { reason: "hard_max", utteranceId: us.utteranceId });
    }, UTTERANCE_HARD_MAX_MS);

    // Barge-in protection: only trigger if AI is currently speaking
    if (session.isSpeaking) {
      const sinceAiAudio = Date.now() - (session.lastAiAudioSentAt || 0);
      if (sinceAiAudio < ECHO_GUARD_MS) return; // echo guard

      us.pendingBargeIn = true;

      if (us.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }

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
    us.buffer = trimmed;

    // Confirm barge-in only with meaningful transcript
    if (session.isSpeaking && us.pendingBargeIn) {
      if (trimmed.length >= BARGEIN_MIN_CHARS) {
        logger.info(`[${sessionId}] BARGE-IN confirmed by transcript → stop TTS`);
        us.pendingBargeIn = false;
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
      }
    }

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }

    if (speechFinal || isFinal) {
      this._finalizeUtterance(sessionId, {
        reason: speechFinal ? "speech_final" : "is_final",
        utteranceId: us.utteranceId,
      });
      return;
    }

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

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us.hardMaxTimer) { clearTimeout(us.hardMaxTimer); us.hardMaxTimer = null; }
    if (us.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }
    us.pendingBargeIn = false;

    const utterance = (us.buffer || "").trim();
    us.isSpeaking = false;
    us.buffer = "";

    if (!utterance) return;

    // -------------------------------------------------------
    // FIX #1 & #2: Smart length filtering based on context
    // -------------------------------------------------------
    const wasBargingIn = session.isSpeaking; // AI was speaking when user started
    const sinceAiSpeechEnd = Date.now() - (session.lastAiSpeechEndAt || 0);
    const aiJustFinished = sinceAiSpeechEnd < POST_AI_SPEECH_BUFFER_MS && sinceAiSpeechEnd > 0;

    if (wasBargingIn) {
      // User interrupted while AI was speaking → require more content
      // Short filler words during AI speech are ignored
      if (
        utterance.length < MIN_UTTERANCE_CHARS_BARGEIN &&
        wordCount(utterance) < MIN_UTTERANCE_WORDS_BARGEIN
      ) {
        logger.info(`[${sessionId}] Drop short barge-in utterance (${reason}): "${utterance}"`);
        return;
      }
    } else {
      // AI is NOT speaking → user is responding to AI question
      // Allow short acknowledgments like "yes", "no", "hmm", "ok", etc.
      if (utterance.length < MIN_UTTERANCE_CHARS || wordCount(utterance) < MIN_UTTERANCE_WORDS) {
        logger.info(`[${sessionId}] Drop empty utterance (${reason}): "${utterance}"`);
        return;
      }

      // Very short utterances are allowed ONLY if they are known acknowledgment words
      // OR if AI has already finished speaking (not in echo zone)
      if (utterance.length < 4 && !isShortAcknowledgment(utterance) && aiJustFinished) {
        logger.info(`[${sessionId}] Drop non-acknowledgment tiny utterance (${reason}): "${utterance}"`);
        return;
      }
    }
    // -------------------------------------------------------

    // Check for disposition triggers
    const detectedDisposition = detectDisposition(utterance, session.conversationHistory);
    if (detectedDisposition) {
      logger.info(`[${sessionId}] Disposition detected: ${detectedDisposition} from: "${utterance}"`);
      session.pendingDisposition = detectedDisposition;
    }

    const now = Date.now();
    logger.info(`[${sessionId}] Finalized utterance (${reason}): "${utterance}"`);
    session.lastProcessedAt = now;

    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
      }
    });
  }

  // ----------------------- Handle user utterance -----------------------
  async handleUserUtterance(sessionId, utterance) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing || session.isCleaning) return;

    // Stop any ongoing TTS/LLM
    this.stopTTS(sessionId);
    if (session.llmAbort) {
      session.llmAbort.abort();
      session.llmAbort = null;
    }

    session.isProcessingUtterance = true;

    // Add user message to history
    session.conversationHistory.push({ role: "user", content: utterance });
    session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

    // FIX: If pending disposition action (DNC, NOT_INTERESTED, etc.) handle before LLM
    if (session.pendingDisposition) {
      const disposition = session.pendingDisposition;
      session.pendingDisposition = null;

      const dispositionResponses = {
        DNC: "I completely understand. I'll make sure to remove you from our list right away. Have a great day! Goodbye.",
        NOT_INTERESTED: "No problem at all! I appreciate your time. Have a wonderful day! Goodbye.",
        LANGUAGE_BARRIER: "I'm sorry about that. I'll try to connect you with someone who can assist you better. Goodbye.",
        CALLBACK: "Of course! I'll have someone reach out to you at a better time. Have a great day! Goodbye.",
        NOT_QUALIFIED: "I understand. Thank you so much for your time today. Have a wonderful day! Goodbye.",
      };

      const closeMessage = dispositionResponses[disposition] ||
        "Thank you for your time. Have a great day! Goodbye.";

      session.isProcessingUtterance = false;
      await this.politeHangup(sessionId, { finalMessage: closeMessage, disposition });
      return;
    }

    try {
      const abortController = new AbortController();
      session.llmAbort = abortController;

      const historySlice = session.conversationHistory
        .slice(-(HISTORY_FOR_MODEL + 1))
        .slice(0, -1); // exclude the just-added user message (it's in the last position)

      const messages = [
        ...historySlice,
        { role: "user", content: utterance },
      ];

      logger.info(`[${sessionId}] Sending to OpenAI: "${utterance}"`);

      const aiResponse = await this.openaiService.streamResponse(
        session.systemPrompt,
        messages,
        { signal: abortController.signal }
      );

      if (abortController.signal.aborted) return;

      session.llmAbort = null;

      if (!aiResponse) {
        session.isProcessingUtterance = false;
        return;
      }

      const cleanResponse = stripQCBlocks(aiResponse);

      // Check if AI response indicates call should end
      const shouldHangup = this.checkAIShouldHangup(cleanResponse, session);

      // Add AI response to history
      session.conversationHistory.push({ role: "assistant", content: cleanResponse });
      session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

      session.lastAiSpokeAt = Date.now();
      session.isProcessingUtterance = false;

      if (shouldHangup) {
        await this.politeHangup(sessionId, {
          finalMessage: cleanResponse,
          disposition: shouldHangup.disposition,
        });
        return;
      }

      this.enqueueTTS(sessionId, cleanResponse, { flush: true });
      this.armMidCallSilence(sessionId);

    } catch (err) {
      session.isProcessingUtterance = false;
      session.llmAbort = null;
      if (err?.name !== "AbortError") {
        logger.error(`[${sessionId}] LLM error: ${err.message}`);
      }
    }
  }

  /**
   * Check if AI response indicates call should end.
   * Returns { disposition } or null.
   */
  checkAIShouldHangup(aiResponse, session) {
    const text = (aiResponse || "").toLowerCase();

    // Check for goodbye/closing phrases in AI response
    const goodbyePhrases = [
      "goodbye", "have a great day", "have a wonderful day",
      "take care", "farewell", "thanks for your time",
    ];

    const hasGoodbye = goodbyePhrases.some(p => text.includes(p));
    if (!hasGoodbye) return null;

    // Map conversation outcome to disposition
    const history = session.conversationHistory || [];
    const userContent = history
      .filter(h => h.role === "user")
      .map(h => h.content)
      .join(" ")
      .toLowerCase();

    if (/not interested|no thank|don't want/.test(userContent)) {
      return { disposition: "NOT_INTERESTED" };
    }
    if (/do not call|remove|stop calling/.test(userContent)) {
      return { disposition: "DNC" };
    }
    if (/interested|yes|tell me more|how does|sign me up/.test(userContent)) {
      return { disposition: "SALES" };
    }
    if (/call back|later|busy/.test(userContent)) {
      return { disposition: "CALLBACK" };
    }

    return { disposition: "TARGET_HUNG_UP" };
  }

  // ----------------------- Disposition + Hangup -----------------------
  /**
   * FIX #3: Close call with proper disposition saved to DB.
   */
  async closeCallWithDisposition(sessionId, disposition, reason = "") {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    logger.info(`[${sessionId}] Closing call with disposition: ${disposition} | reason: ${reason}`);

    try {
      if (session.callLog?._id) {
        await CallLog.findByIdAndUpdate(session.callLog._id, {
          disposition,
          status: "completed",
          endTime: new Date(),
          duration: Math.round((Date.now() - session.startTime) / 1000),
        });
        logger.info(`[${sessionId}] CallLog updated: disposition=${disposition}`);
      }
    } catch (err) {
      logger.error(`[${sessionId}] Failed to update CallLog disposition: ${err.message}`);
    }
  }

  async politeHangup(sessionId, { finalMessage = "", disposition = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isClosing) return;

    session.isClosing = true;

    logger.info(`[${sessionId}] politeHangup: disposition=${disposition}, msg="${finalMessage}"`);

    // Save disposition first
    if (disposition) {
      await this.closeCallWithDisposition(sessionId, disposition, finalMessage);
    }

    if (finalMessage) {
      const tts = safeTTS(finalMessage);
      if (tts) {
        this.stopTTS(sessionId);
        // Play final message, then hang up after it finishes
        await this.playTTSAndWait(sessionId, tts);
      }
    }

    await sleep(600);
    await this.twilioService.endCall(session.callLog?.callSid);
    await this.cleanupSession(sessionId);
  }

  /**
   * Play TTS synchronously (wait for it to finish before continuing).
   */
  async playTTSAndWait(sessionId, text) {
    return new Promise(async (resolve) => {
      const session = this.sessions.get(sessionId);
      if (!session) return resolve();

      try {
        const audioStream = await this.elevenlabsService.textToSpeech(text, {
          agentName: session.agentName,
        });

        if (!audioStream) return resolve();

        const chunks = [];
        for await (const chunk of audioStream) {
          chunks.push(chunk);
          if (session.streamSid && session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                event: "media",
                streamSid: session.streamSid,
                media: { payload: chunk.toString("base64") },
              })
            );
            session.lastAiAudioSentAt = Date.now();
          }
        }
        session.lastAiSpeechEndAt = Date.now();
        await sleep(300);
        resolve();
      } catch (err) {
        logger.error(`[${sessionId}] playTTSAndWait error: ${err.message}`);
        resolve();
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

    this.runTTSQueue(sessionId);
  }

  async runTTSQueue(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttsQueueRunning) return;
    if (session.ttsQueue.length === 0) return;

    session.ttsQueueRunning = true;

    while (session.ttsQueue.length > 0) {
      const s = this.sessions.get(sessionId);
      if (!s || s.isClosing || s.isCleaning) break;

      const text = s.ttsQueue.shift();
      if (!text) continue;

      try {
        await this.streamTTS(sessionId, text);
      } catch (err) {
        if (err?.name !== "AbortError") {
          logger.error(`[${sessionId}] TTS queue error: ${err.message}`);
        }
        break;
      }
    }

    const s = this.sessions.get(sessionId);
    if (s) {
      s.ttsQueueRunning = false;
      // FIX: Mark when AI finished speaking (used for short utterance threshold)
      s.lastAiSpeechEndAt = Date.now();
      s.isSpeaking = false;
    }
  }

  async streamTTS(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const abortController = new AbortController();
    session.ttsAbort = abortController;
    session.isSpeaking = true;

    logger.info(`[${sessionId}] TTS: "${text.substring(0, 80)}..."`);

    try {
      const audioStream = await this.elevenlabsService.textToSpeech(text, {
        agentName: session.agentName,
        signal: abortController.signal,
      });

      if (!audioStream || abortController.signal.aborted) return;

      for await (const chunk of audioStream) {
        if (abortController.signal.aborted) break;

        const s = this.sessions.get(sessionId);
        if (!s || s.isClosing) break;

        if (s.streamSid && s.ws?.readyState === WebSocket.OPEN) {
          s.ws.send(
            JSON.stringify({
              event: "media",
              streamSid: s.streamSid,
              media: { payload: chunk.toString("base64") },
            })
          );
          s.lastAiAudioSentAt = Date.now();
        }
      }
    } finally {
      const s = this.sessions.get(sessionId);
      if (s && s.ttsAbort === abortController) {
        s.ttsAbort = null;
      }
    }
  }

  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.ttsAbort) {
      session.ttsAbort.abort();
      session.ttsAbort = null;
    }

    session.ttsQueue.length = 0;
    session.ttsQueueRunning = false;
    session.isSpeaking = false;
    session.lastAiSpeechEndAt = Date.now();
  }

  sendClearToTwilio(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session.streamSid || session.ws?.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        event: "clear",
        streamSid: session.streamSid,
      })
    );
    session.lastClearAt = Date.now();
    logger.info(`[${sessionId}] Sent clear to Twilio`);
  }

  // ----------------------- Mid-call silence -----------------------
  armMidCallSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");

    this._setTimer(sessionId, "midCheck", MID_SILENCE_CHECK_MS, async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.isClosing) return;

      const sinceUserSpoke = Date.now() - s.lastSpeechAt;
      if (sinceUserSpoke < MID_SILENCE_CHECK_MS - 500) {
        this.armMidCallSilence(sessionId);
        return;
      }

      if (s.isSpeaking || s.isProcessingUtterance) {
        this.armMidCallSilence(sessionId);
        return;
      }

      const now = Date.now();
      const cooldownOk = now - s.state.lastCantHearAt > CANT_HEAR_COOLDOWN_MS;
      const retriesOk = s.state.retriesCantHear < CANT_HEAR_MAX_RETRIES;

      if (cooldownOk && retriesOk) {
        s.state.retriesCantHear += 1;
        s.state.lastCantHearAt = now;

        const promptMsg = s.state.retriesCantHear === 1
          ? "Are you still there? I didn't catch that."
          : "I'm having trouble hearing you. Could you speak up a bit?";

        this.enqueueTTS(sessionId, promptMsg, { flush: true });

        this._setTimer(sessionId, "midHangup", MID_SILENCE_HANGUP_MS, async () => {
          const ss = this.sessions.get(sessionId);
          if (!ss || ss.isClosing) return;

          const sinceUser = Date.now() - ss.lastSpeechAt;
          if (sinceUser < MID_SILENCE_HANGUP_MS - 500) return;

          await this.politeHangup(sessionId, {
            finalMessage: "I'm sorry, I still can't hear you. I'll try again later. Goodbye!",
            disposition: "UNRESPONSIVE",
          });
        });
      } else {
        await this.politeHangup(sessionId, {
          finalMessage: "It seems we're having connection issues. I'll try again later. Goodbye!",
          disposition: "UNRESPONSIVE",
        });
      }
    });
  }

  // ----------------------- cleanup -----------------------
  async cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.isCleaning) return;

    session.isCleaning = true;
    session.isClosing = true;

    logger.info(`[${sessionId}] Cleaning up session`);

    this._clearAllTimers(session);
    this.stopTTS(sessionId);

    if (session.llmAbort) {
      session.llmAbort.abort();
      session.llmAbort = null;
    }

    const us = session.userSpeech;
    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us.hardMaxTimer) { clearTimeout(us.hardMaxTimer); us.hardMaxTimer = null; }
    if (us.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }

    try {
      await this.deepgramService.closeStream(sessionId);
    } catch (e) {
      logger.error(`[${sessionId}] Deepgram close error: ${e.message}`);
    }

    // If no disposition set yet, mark as completed
    try {
      if (session.callLog?._id) {
        const existing = await CallLog.findById(session.callLog._id).select("disposition status");
        if (existing && !existing.disposition) {
          await CallLog.findByIdAndUpdate(session.callLog._id, {
            status: "completed",
            endTime: new Date(),
            duration: Math.round((Date.now() - session.startTime) / 1000),
          });
        }
      }
    } catch (e) {
      logger.error(`[${sessionId}] CallLog final update error: ${e.message}`);
    }

    this.sessions.delete(sessionId);
    logger.info(`[${sessionId}] Session cleaned up. Active sessions: ${this.sessions.size}`);
  }

  cleanupInactiveSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.isCleaning || session.isClosing) continue;

      const inactive = now - (session.lastActivity || 0);
      if (inactive > 300000) { // 5 minutes
        logger.warn(`[${sessionId}] Inactive session cleanup (${Math.round(inactive / 1000)}s)`);
        this.cleanupSession(sessionId);
      }
    }
  }
}

module.exports = MediaStreamHandler;