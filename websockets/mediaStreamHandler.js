// MediaStreamHandler.js — production v19
"use strict";
const WebSocket = require("ws");
const TwilioService = require("../services/TwilioService");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

// ─────────────────────────── helpers ────────────────────────────────────────

function sanitizeForTTS(text) {
  return (text || "")
    .replace(/<QC>[\s\S]*?<\/QC>/gi, "")
    .replace(/\(short pause\)/gi, "")
    .replace(/\(pause\)/gi, "")
    .replace(/\[(SYSTEM|SYS|STAGE|QC|SECTION|NOTE|INTERNAL)[^\]]*\]/gi, "")
    .replace(/\[[^\]]*\]/gi, "")
    .replace(/\bokaaay\b/gi, "okay")
    .replace(/\byeaah\b/gi, "yeah")
    .replace(/\bsuure\b/gi, "sure")
    .replace(/\btotaally\b/gi, "totally")
    .replace(/\bsooo\b/gi, "so")
    .replace(/={3,}/g, "")
    .replace(/^\s*(SYS|SYSTEM|SECTION).*$/gim, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}


function stripTrailingFillers(text) {
  let t = (text || "").trim();
  if (!t) return "";

  t = t.replace(/\s*[\(\[]?\s*(?:oh|ah|um+|uh+)\s+(?:nice|great|good|okay|ok|cool|right|sure|sweet)\s*[\)\]]?\s*$/i, "");
  t = t.replace(/\s*[,;]\s*(?:oh|ah)\s+(?:nice|great|good|okay|ok|cool)\s*$/i, "");

  const qIdx = t.lastIndexOf("?");
  if (qIdx !== -1 && qIdx < t.length - 1) {
    t = t.slice(0, qIdx + 1).trim();
  }
  return t.trim();
}

function stripQCBlocks(text) {
  return (text || "").replace(/<QC>[\s\S]*?<\/QC>/gi, "");
}

function safeTTS(text, maxChars = 500) {
  const t = sanitizeForTTS(stripTrailingFillers(text));
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

function isAcknowledgmentChunk(text) {
  const t = (text || "").replace(/\[[^\]]+\]/g, "").replace(/<[^>]+>/g, "").trim();
  if (!t) return false;
  if (t.includes("?")) return false;        
  if (t.split(/\s+/).length > 12) return false; 
  return true;
}



function wordCount(s) {
  const t = (s || "").trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

const FILLER_REGEX =
  /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo|hmm|hm|mmm|mm|mhm|mhmm|uh huh|uh-huh|uhhuh|uh|um|erm|go ahead|please|continue|and|so|well|but|okay go ahead|sure go ahead|go on|keep going|i'm here|im here|still here|i hear you|i got you|gotcha)\.?\s*$/i;

function isFiller(text) { return FILLER_REGEX.test((text || "").trim()); }

const POST_GREETING_FILLER_REGEX =
  /^(?:hello[?!.]?|hi[?!.]?|hey[?!.]?|can you hear me[?!.]?|can you hear[?!.]?|hello[?!.]?\s+can you hear[?!.]?|hello[?!.]?\s+can you hear me[?!.]?|are you there[?!.]?|hello can you hear me[?!.]?|is anyone there[?!.]?|are you still there[?!.]?|can you hear me now[?!.]?|testing[?!.]?|hello[?!.]?\s+hello[?!.]?)$/i;

function isPostGreetingFiller(text) {
  return POST_GREETING_FILLER_REGEX.test((text || "").trim());
}

const SOCIAL_ASK_REGEX =
  /\b(?:and\s+(?:you|u|ya)|n\s+you|what\s+about\s+(?:you|u|ya)|how\s+about\s+(?:you|u|ya)|how\s+are\s+you|how\s+you\s+doing|how\s+are\s+you\s+doing|what\s+about\s+yourself|and\s+yourself)\b/i;

// Social response = customer explicitly asks about YOU ("and you?", "how are you?").
// Plain statements like "I am fine" are NOT social.
function isSocialResponse(text) {
  return SOCIAL_ASK_REGEX.test((text || "").trim());
}
const DIGRESSION_QUESTION_REGEX =
  /^(?:why|what|how|who|when|where|can you|could you|do you|are you|is this|what do you mean|i don.?t understand|i.?m not sure|explain|tell me more|what.?s this about|what is this|what kind|what sort|what type|say that again|repeat that|can you repeat|didn.?t catch|didn.?t hear|sorry what|sorry could you|huh|pardon|what did you say|hold on|one second|one sec|wait|hang on|i.?m (?:driving|busy|at work|in a meeting|eating|walking)|not a good time|can i ask you something|i have a question|question for you|before (?:you|we|i)|actually|never mind|forget it|just wondering|curious(?:ly)?)\b/i;

function isDigression(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.endsWith("?") && !FILLER_REGEX.test(t)) return true;
  if (DIGRESSION_QUESTION_REGEX.test(t)) return true;
  return false;
}

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

// ─── DISPOSITION ──────────────────────────────────────────────────────────
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
    const inferred = inferDispositionFromText(
      `${transcript} ${(session.aiChunks || []).slice(-25).join(" ")}`
    );
    status = inferred || (endedBy === "ws_error" ? "TECH_ISSUES" : "TARGET_HUNG_UP");
  }
  return {
    status,
    stage: session.currentStage || "unknown",
    qualified: !!st.qualified,
    zip: st.zip || "",
    fullName: st.fullName || "",
    email: st.email || "",
    capturedAnswers: st.capturedAnswers || {},
    endedBy: endedBy || "unknown",
    durationMs: Date.now() - (session.startTime || Date.now()),
    // Mask PII in logs — full values stored in callLog only
    transcriptSummary: transcript.slice(0, 400),
  };
}

// ─── RUNTIME PROMPT ───────────────────────────────────────────────────────
function buildCompressedRuntimePrompt() {
  return `========================================
ACA QUALIFICATION VOICE AGENT — Matt
========================================

You are Matt. Friendly, calm, human. Never formal.

## ABSOLUTE FLOW RULE (highest priority)
- If the customer asks you a question or speaks to you directly (examples: "and you?", "how are you?", "why are you asking?", "what is this about?"),
  you MUST answer that customer message FIRST in 1 short sentence.
- Only AFTER that, ask the campaign question.
- Never ask the next campaign question and then answer the customer after.

## NO RANDOM FILLER
- Do NOT say: "oh nice", "oh great", "oh wow", "um", "uh", "mhm", "right" unless it is truly needed.
- Default: no filler at all.
- If you acknowledge, use a relevant one-liner based on the customer message:
  - Positive: "Okay." or "Thanks."
  - Negative/upset: "I am sorry to hear that."
  - Confused: "Sure, I can explain."
  Never add an acknowledgment after a question.

## QUESTIONS MUST END CLEANLY
- If you ask a question, the sentence MUST end with a question mark and NOTHING after it.

## MANDATORY: QC BLOCK — ALWAYS FIRST
Every response MUST begin with a QC block:
<QC>{"q":<currentQ>,"result":"<pass|fail|skip>","next":<nextQ>,"field":"<email|zip|fullName|null>","value":"<value or null>"}</QC>

- pass = answered and qualifies → advance
- fail = does not qualify → call ends
- skip = not answered → stay on same Q

## HARD RULES
1. NO exclamation marks. Periods only.
2. NO contractions. Full words: "I am", "do not", "can not", "will not".
3. Never announce transitions like "next question".
4. Write numbers as words: "twenty five" not "25".
5. Square brackets ONLY for: [laughs softly] [chuckles] [laughs] [laughs lightly].
6. Do NOT invent customer data. If unclear, re-ask the same question.

## REPEATING FOR CONFIRMATION (only when needed)
- Only confirm important fields (email, zip, full name) OR if you suspect mis-hearing.
Examples:
- "So your email is john at gmail dot com. Is that right?"
- "Your zip code is nine zero zero zero one. Is that right?"

Stay short. Stay natural.`;
}

// ─── TUNING CONSTANTS ─────────────────────────────────────────────────────
const UTTERANCE_HARD_MAX_MS        = 1800;

const MIN_UTTERANCE_CHARS          = 3;
const MIN_UTTERANCE_WORDS          = 1;
const ECHO_GUARD_MS                = 1200;
const BARGEIN_CONFIRM_MS           = 180;
const MID_SILENCE_CHECK_MS         = 11000;
const MID_SILENCE_HANGUP_MS        = 7000;
const CANT_HEAR_COOLDOWN_MS        = 9000;
const CANT_HEAR_MAX_RETRIES        = 2;
const HISTORY_LIMIT                = 14;
const HISTORY_FOR_MODEL            = 10;
const THINKING_FILLER_THRESHOLD_MS = 999999; // disabled (no auto fillers)
const TRANSFER_DELAY_MS            = 5500;
const TTS_QUEUE_MAX_DEPTH          = 6;  
const AUDIO_BUFFER_MAX_BYTES       = 200000;
const TWILIO_READY_WAIT_MAX_MS     = 8000;  

const ACK_TO_QUESTION_PAUSE_MS     = 380;
const POST_GREETING_LISTEN_MS      = 600;
const BACKCHANNEL_FILLER_MS        = 300;
const BACKCHANNEL_FILLERS          = []; // disabled

class MediaStreamHandler {
  constructor(wss) {
    this.wss = wss;
    this.sessions = new Map();

    this.deepgramService   = new DeepgramService();
    this.openaiService     = new OpenAIService();
    this.elevenlabsService = new ElevenLabsService();
    this.campaignService   = new CampaignService();

    this.twilioService = new TwilioService({
      getActiveSessionCount: () => this.sessions.size,
    });

    this._compressedRuntimePrompt = buildCompressedRuntimePrompt();
    logger.info(
      `MediaStreamHandler initialized. Runtime prompt: ~${Math.round(
        this._compressedRuntimePrompt.length / 4
      )} tokens`
    );

    this.setupWebSocket();

    // FIX: store interval handle so it can be cleared on shutdown
    this._cleanupInterval = setInterval(() => this.cleanupInactiveSessions(), 30000);

    // FIX: heartbeat interval — actually pings clients so dead sockets are detected
    this._heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      });
    }, 30000);
  }

  // Allow clean shutdown without leaked intervals
  destroy() {
    clearInterval(this._cleanupInterval);
    clearInterval(this._heartbeatInterval);
  }

  // ─── WEBSOCKET ────────────────────────────────────────────────────────
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
        try { data = JSON.parse(msg.toString()); }
        catch (e) { logger.error(`[${sessionId}] Message parse error: ${e.message}`); return; }

        switch (data.event) {
          case "start": {
            const session = this.sessions.get(sessionId);
            if (!session) return;
            session.streamSid     = data.start?.streamSid || session.streamSid;
            session.isTwilioReady = true;
            session.twilioStartAt = Date.now();
            session.lastActivity  = Date.now();
            logger.info(`[${sessionId}] Twilio START streamSid=${session.streamSid}`);
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

  // ─── SESSION ──────────────────────────────────────────────────────────
  createEmptySession(sessionId, ws) {
    return {
      id: sessionId,
      ws,
      callLog:               null,
      campaign:              null,
      systemPrompt:          null,
      openingLine:           null,
      agentName:             "Matt",
      direction:             "",
      conversationHistory:   [],
      lastActivity:          Date.now(),
      isTwilioReady:         false,
      streamSid:             null,
      dgOpenAt:              0,
      twilioStartAt:         0,
      isSpeaking:            false,
      ttsAbort:              null,
      llmAbort:              null,
      ttsQueue:              [],
      ttsQueueRunning:       false,
      isClosing:             false,
      isCleaning:            false,
      isProcessingUtterance: false,
      lastSpeechAt:          Date.now(),
      lastAiSpokeAt:         0,
      startTime:             Date.now(),
      hasUserSpoken:         false,
      hasRealInput:          false,  // true once customer gives a substantive non-filler response
      greetingCompletedAt:   0,      // timestamp when greeting finished playing — used for post-greeting listen window
      initialGreetingSent:   false,
      lastClearAt:           0,
      activeTurnId:          0,
      lastProcessedAt:       0,
      lastAiAudioSentAt:     0,
      transferAttempted:     false,
      timers: { startSpeak: null, startHangup: null, midCheck: null, midHangup: null },
      startSilenceFlowArmed: false,
      currentStage:          "greeting",
      openingComplete:       false,
      awaitingAnswerFor:     null,
      questionsAnswered:     {},
      currentQuestionNum:    0,
      lastUserInputType:     "unknown",
      lastBackchannelTurn:   0,
      pendingSocialReply:    false,
      socialHandledThisTurn: false,
      lastThinkingFillerAt:  0,
      pendingConfirmField:   null,  // FIX v22: field awaiting read-back confirmation
      pendingConfirmValue:   null,
      pausedQuestionNum:     null,   
      digressionCount:       0,     
      state: {
        qualified:                false,
        zip:                      "",
        fullName:                 "",
        email:                    "",
        retriesCantHear:          0,
        lastCantHearAt:           0,
        capturedAnswers:          {},
        ageQualified:             null,
        incomeQualified:          null,
        govCoverageQualified:     null,
        employerCoverageQualified: null,
        bankAccountQualified:     null,
        subsidyCheckQualified:    null,
      },
      transcriptChunks: [],
      aiChunks:         [],
      userSpeech: {
        utteranceId:         0,
        isSpeaking:          false,
        buffer:              "",
        lastInterimTime:     0,
        startedAt:           0,
        finalizeTimer:       null,
        hardMaxTimer:        null,
        pendingBargeIn:      false,
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
    const session  = existing || this.createEmptySession(sessionId, ws);

    session.ws           = ws;
    session.callLog      = callLog;
    session.campaign     = campaign;
    session.systemPrompt = systemPrompt;
    session.openingLine  = openingLine;
    session.agentName    = agentName || "Matt";
    session.direction    = String(callLog.direction || callLog.Direction || "").toLowerCase().trim();
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

  // ─── TIMERS ───────────────────────────────────────────────────────────
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

  // ─── GREETING ─────────────────────────────────────────────────────────
  async maybePlayInitialGreeting(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.initialGreetingSent) return;
    if (!session.campaign || !session.openingLine) return;
    if (!session.isTwilioReady || !session.streamSid) {
      logger.info(`[${sessionId}] Greeting ready — waiting for streamSid`);
      return;
    }

    const greetingText = safeTTS(
      renderTemplate(session.openingLine, { agentname: session.agentName })
    );
    if (!greetingText) return;

    session.initialGreetingSent = true;
    session.currentStage        = "greeting";
    session.openingComplete     = false;

    session.conversationHistory.push({ role: "assistant", content: greetingText });
    session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
    session.aiChunks.push(greetingText);

    logger.info(`[${sessionId}] Playing greeting`);

    this.enqueueTTS(sessionId, greetingText, {
      flush: true,
      onComplete: () => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.openingComplete    = true;
        s.currentStage       = "qualification";
        s.currentQuestionNum = 1;
        s.greetingCompletedAt = Date.now();
        logger.info(`[${sessionId}] Opening done → qualification (Q1 next)`);
        this.armMidCallSilence(sessionId);
      },
    });
  }

  // ─── START-SILENCE ────────────────────────────────────────────────────
  armStartSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.startSilenceFlowArmed) return;
    session.startSilenceFlowArmed = true;

    this._setTimer(sessionId, "startSpeak", 1800, async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.hasUserSpoken || s.initialGreetingSent || s.isSpeaking) return;

      const fallback =
        safeTTS(renderTemplate(s.openingLine, { agentname: s.agentName })) ||
        "Hi, thank you for taking the call. This is Matt with healthcare benefits. I just need to ask a few quick questions to see if you may qualify.";

      s.initialGreetingSent = true;
      s.currentStage        = "greeting";
      s.openingComplete     = false;
      s.aiChunks.push(fallback);

      this.enqueueTTS(sessionId, fallback, {
        flush: true,
        onComplete: () => {
          const ss = this.sessions.get(sessionId);
          if (!ss) return;
          ss.openingComplete    = true;
          ss.currentStage       = "qualification";
          ss.currentQuestionNum = 1;
          ss.greetingCompletedAt = Date.now();
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

  // ─── DEEPGRAM ─────────────────────────────────────────────────────────
  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._markUserActivity(session);

    const us = session.userSpeech;
    us.utteranceId    += 1;
    us.isSpeaking      = true;
    us.buffer          = "";
    us.lastInterimTime = Date.now();
    us.startedAt       = Date.now();

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us.hardMaxTimer)  { clearTimeout(us.hardMaxTimer);  us.hardMaxTimer  = null; }

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
        if (uus.pendingBargeIn && (uus.buffer || "").trim().length < 3) {
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

    if (us.finalizeTimer)       { clearTimeout(us.finalizeTimer);       us.finalizeTimer       = null; }
    if (us.hardMaxTimer)        { clearTimeout(us.hardMaxTimer);        us.hardMaxTimer        = null; }
    if (us.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }
    us.pendingBargeIn = false;

    const utterance = (us.buffer || "").trim();
    us.isSpeaking = false;
    us.buffer     = "";
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
      const openingNorm = (session.openingLine || "")
        .toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      const utterNorm = utterance
        .toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      if (openingNorm && utterNorm.length >= 4) {
        const firstWords = openingNorm.split(/\s+/).slice(0, 6).join(" ");
        if (openingNorm.startsWith(utterNorm) || firstWords.startsWith(utterNorm.split(/\s+/).slice(0,4).join(" "))) {
          logger.info(`[${sessionId}] Echo of opening line suppressed: "${utterance}"`);
          return;
        }
      }

      if (isStrongInterrupt(utterance) && !isFiller(utterance)) {
        logger.info(`[${sessionId}] Opening not done — strong interrupt, processing anyway`);
      } else {
        logger.info(`[${sessionId}] Opening not complete — buffering: "${utterance}"`);
        return;
      }
    }
    if (session.openingComplete && !session.hasRealInput && isPostGreetingFiller(utterance)) {
      logger.info(`[${sessionId}] Post-greeting filler absorbed (no LLM): "${utterance}"`);
      return;
    }
    if (session.openingComplete && session.greetingCompletedAt) {
      const sinceGreeting = Date.now() - session.greetingCompletedAt;
      if (sinceGreeting < POST_GREETING_LISTEN_MS && !session.hasRealInput) {
        logger.info(`[${sessionId}] Post-greeting window — holding ${sinceGreeting}ms < ${POST_GREETING_LISTEN_MS}ms: "${utterance}"`);
        const delay = POST_GREETING_LISTEN_MS - sinceGreeting + 20;
        setTimeout(() => {
          const s = this.sessions.get(sessionId);
          if (!s || s.isClosing || s.isCleaning) return;
          this._processValidatedUtterance(sessionId, utterance);
        }, delay);
        return;
      }
    }

    this._processValidatedUtterance(sessionId, utterance);
  }
  _processValidatedUtterance(sessionId, utterance) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    // Classify input type
    if (session.openingComplete && isSocialResponse(utterance)) {
      session.lastUserInputType = "social";
      session.pendingSocialReply = true;
      logger.info(`[${sessionId}] Social ask detected — will reply first: "${utterance}"`);
    } else if (session.openingComplete && isDigression(utterance)) {
      session.lastUserInputType = "digression";
      if (session.pausedQuestionNum === null) {
        session.pausedQuestionNum = session.currentQuestionNum;
        session.digressionCount += 1;
        logger.info(`[${sessionId}] Digression detected — pausing at Q${session.pausedQuestionNum}: "${utterance}"`);
      }
    } else {
      session.lastUserInputType = "qualification";
      if (session.pausedQuestionNum !== null) {
        logger.info(`[${sessionId}] Digression resolved — resuming Q${session.currentQuestionNum}`);
        session.pausedQuestionNum = null;
      }
    }
    session.hasRealInput = true;

    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError")
        logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
    });
  }

  // ─── TTS PIPELINE ─────────────────────────────────────────────────────
  enqueueTTS(sessionId, text, { flush = false, onComplete = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) {
      if (onComplete) onComplete();
      return;
    }
    const t = safeTTS(text);
    if (!t) { if (onComplete) onComplete(); return; }

    if (flush) session.ttsQueue.length = 0;
    if (session.ttsQueue.length >= TTS_QUEUE_MAX_DEPTH) {
      logger.warn(`[${sessionId}] TTS queue at max depth (${TTS_QUEUE_MAX_DEPTH}) — dropping item`);
      if (onComplete) onComplete();
      return;
    }

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

        const textToSpeak     = typeof item === "string" ? item : item.text;
        const onComplete      = typeof item === "string" ? null : item.onComplete;
        const preloadedStream = item._preloadedStream || null;

        if (!textToSpeak) { if (onComplete) onComplete(); continue; }
        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          const waitStart = Date.now();
          while (!s.isTwilioReady || !s.streamSid || !s.ws) {
            if (Date.now() - waitStart > TWILIO_READY_WAIT_MAX_MS) {
              logger.warn(`[${sessionId}] Twilio not ready after ${TWILIO_READY_WAIT_MAX_MS}ms — dropping TTS item`);
              if (onComplete) onComplete();
              break;
            }
            await sleep(35);
            const ss = this.sessions.get(sessionId);
            if (!ss || ss.isClosing || ss.isCleaning) return;
          }
          const ss = this.sessions.get(sessionId);
          if (!ss || !ss.isTwilioReady || !ss.streamSid || !ss.ws) continue;
        }

        const audioStream = preloadedStream || await this.getAudioStream(sessionId, textToSpeak);
        if (!audioStream) { if (onComplete) onComplete(); continue; }

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

        {
          const ss = this.sessions.get(sessionId);
          if (ss && !ss.isClosing && !ss.isCleaning && ss.ttsQueue.length > 0) {
            const nextItem = ss.ttsQueue[0];
            const nextText = typeof nextItem === "string" ? nextItem : (nextItem?.text || "");
            const nextHasQuestion = (nextText || "").includes("?");
            const currentIsAck = isAcknowledgmentChunk(textToSpeak);
            if (currentIsAck && nextHasQuestion) {
              logger.info(`[${sessionId}] ACK→QUESTION pause ${ACK_TO_QUESTION_PAUSE_MS}ms`);
              await sleep(ACK_TO_QUESTION_PAUSE_MS);
            }
          }
        }

        if (onComplete) { try { onComplete(); } catch {} }
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
    session.ttsAbort     = ac;
    session.isSpeaking   = true;
    session.lastAiSpokeAt = Date.now();

    const FRAME_BYTES = 160;
    const FRAME_MS    = 20;
    let buffer     = Buffer.alloc(0);
    let ended      = false;
    let frameCount = 0;

    const onData = (chunk) => {
      if (!chunk?.length) return;

      if (buffer.length + chunk.length > AUDIO_BUFFER_MAX_BYTES) {
        const keep = AUDIO_BUFFER_MAX_BYTES - buffer.length;
        if (keep > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, keep)]);
        logger.warn(`[${sessionId}] Audio buffer cap hit — discarding ${chunk.length - Math.max(0, keep)} bytes`);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
    };
    const onEnd   = () => { ended = true; };
    const onError = () => { ended = true; };

    audioStream.on("data",  onData);
    audioStream.on("end",   onEnd);
    audioStream.on("error", onError);

    try {
      while (!ac.signal.aborted) {
        if (buffer.length >= FRAME_BYTES) {
          const frame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);
          try {
            session.ws.send(JSON.stringify({
              event:     "media",
              streamSid: session.streamSid,
              media:     { payload: frame.toString("base64") },
            }));
          } catch {}
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
        audioStream.off("data",  onData);
        audioStream.off("end",   onEnd);
        audioStream.off("error", onError);
      } catch {}
      try { audioStream.destroy(); } catch {}
      // Explicitly free the buffer
      buffer = Buffer.alloc(0);
      session.isSpeaking = false;
      session.ttsAbort   = null;
      logger.info(`[${sessionId}] TTS done frames=${frameCount}`);
    }
  }
  _buildSystemPrompt(session) {
    const st = session.state || {};

    const answeredQs = [];
    if (st.ageQualified !== null)
      answeredQs.push(`Q1(age):${st.ageQualified ? "pass" : "fail"}`);
    if (st.incomeQualified !== null)
      answeredQs.push(`Q2(income):${st.incomeQualified ? "pass" : "fail"}`);
    if (st.govCoverageQualified !== null)
      answeredQs.push(`Q3(govCoverage):${st.govCoverageQualified ? "pass" : "fail"}`);
    if (st.employerCoverageQualified !== null)
      answeredQs.push(`Q4(employerCoverage):${st.employerCoverageQualified ? "pass" : "fail"}`);
    if (st.bankAccountQualified !== null)
      answeredQs.push(`Q5(bankAccount):${st.bankAccountQualified ? "pass" : "fail"}`);
    if (st.email)
      answeredQs.push(`Q6(email):${st.email}`);
    if (st.subsidyCheckQualified !== null)
      answeredQs.push(`Q7(subsidy):${st.subsidyCheckQualified ? "pass" : "fail"}`);
    if (st.zip)
      answeredQs.push(`zip:${st.zip}`);
    if (st.fullName)
      answeredQs.push(`fullName:${st.fullName}`);

    const awaitLabel = session.awaitingAnswerFor ? `;collecting=${session.awaitingAnswerFor}` : "";

    let inputInstruction = "";
    if (session.lastUserInputType === "social" && !session.socialHandledThisTurn) {
      inputInstruction = [
        `INPUT_TYPE=SOCIAL_RESPONSE — Customer gave a warm social reply.`,
        `CUSTOMER SAID: "${session._lastUtterance || ""}"`,
        `MANDATORY ORDER: Social reply FIRST, question SECOND. NEVER swap.`,
        `HOW TO PICK YOUR SOCIAL REPLY (read the customer text above and decide):`,
        `  - If they asked about you ("and you?" / "how about you?" / "what about yourself?" or any similar phrasing): reply naturally like "[laughs softly] I am doing well."`,
        `  - If they did NOT ask about you (e.g. "I am good" / "fine" / "doing well" with no question back): react to THEIR news only, e.g. "[laughs softly] oh nice, glad to hear that." NEVER say "thanks for asking" if they did not ask.`,
        `  The LLM reads the customer text and makes this judgment — not a rigid regex.`,
        `FORBIDDEN: Do NOT say "This is Matt". Do NOT say "healthcare benefits". Do NOT re-introduce yourself.`,
      ].join("\n");
    } else if (session.socialHandledThisTurn) {
      inputInstruction = [
        `SOCIAL_REPLY_ALREADY_SENT=true — You already replied to the customer's "and you?" in audio.`,
        `Do NOT add any social reply now.`,
        `Go straight to the current campaign question (Q${session.currentQuestionNum}).`,
      ].join("\n");
    } else if (session.lastUserInputType === "digression") {
      const resumeQ = session.pausedQuestionNum || session.currentQuestionNum;
      inputInstruction = [
        `INPUT_TYPE=DIGRESSION — Customer interrupted with a question or comment mid-call.`,
        `RULES:`,
        `  1. Give ONE short honest answer to what they asked (max 1-2 sentences).`,
        `  2. Immediately re-ask Q${resumeQ} — the EXACT same question you were on.`,
        `  3. NEVER advance to the next question. NEVER go back to Q1. Return to Q${resumeQ}.`,
        `  4. NEVER give a long explanation. NEVER list features or benefits.`,
        `  5. QC block: always result=skip, q=${resumeQ}, next=${resumeQ}.`,
        `EXAMPLE: Customer asked "why do you need this?" during Q${resumeQ} →`,
        `<QC>{"q":${resumeQ},"result":"skip","next":${resumeQ},"field":null,"value":null}</QC> [laughs softly] oh yeah, just to check you qualify. So uh [restate Q${resumeQ} in simple words]?`,
        `RETURN TO: Q${resumeQ} — do not move forward.`,
      ].join("\n");
    }

    const greetedFlag = session.openingComplete
      ? [
          `GREETING_COMPLETE=true`,
          `— You ALREADY introduced yourself and said why you are calling.`,
          `— NEVER say your name again. NEVER say "healthcare benefits" again.`,
          `— You are mid-call. The next thing to do is Q${session.currentQuestionNum}.`,
        ].join(" ")
      : `GREETING_IN_PROGRESS — Say Part 2, then Part 3, then ask Q1.`;

    const wrapupGuard = session.currentStage === "wrapup"
      ? `STAGE=WRAPUP — Transfer is in progress. Do NOT ask questions. Do NOT give rebuttals. If customer speaks just say "You will be connected shortly."`
      : "";

    const stateBlock = [
      `\n\n---`,
      `## CURRENT CALL STATE (internal — never read aloud)`,
      greetedFlag,
      wrapupGuard || "",
      inputInstruction || "",
      `stage: ${session.currentStage}`,
      `nextQuestion: Q${session.currentQuestionNum}`,
      `questionsAnswered: [${answeredQs.join(", ") || "none yet"}]`,
      `qualified: ${!!st.qualified}${awaitLabel}`,
      // FIX v22: tell LLM when backchannel fired so it skips its own ack
      session.lastBackchannelTurn === session.activeTurnId
        ? `BACKCHANNEL_SENT=true \u2014 A filler word was already auto-played. Do NOT add any acknowledgment. Go STRAIGHT to the question.`
        : "",
      // FIX v22: read-back instruction for email/zip confirmation
      session.pendingConfirmField === "email"
        ? `CONFIRM_EMAIL=true \u2014 You just captured the email "${session.pendingConfirmValue}". Your FIRST sentence MUST read it back: "so your email is [say the email letter by letter if complex, or naturally if simple]." Then move to the next question. After reading it back, set pendingConfirmField to null.`
        : session.pendingConfirmField === "zip"
        ? `CONFIRM_ZIP=true \u2014 You just captured zip code "${session.pendingConfirmValue}". Your FIRST sentence MUST read it back: "so your zip code is [zip]." Then move to next question.`
        : "",
      `INSTRUCTION: Stage="${session.currentStage}". Next Q=Q${session.currentQuestionNum}. Never re-ask answered Qs. Never skip Qs. START your response with the QC block first, then speak.`,
      `---`,
    ].filter(Boolean).join("\n");

    return this._compressedRuntimePrompt + stateBlock;
  }

  // ─── TRANSFER LOGIC ───────────────────────────────────────────────────
  async _maybeTransferCall(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.transferAttempted) return;
    if (!session.state?.qualified) return;

    const callSid  = session.callLog?.callSid;
    const buyerDid = session.campaign?.buyerDid;

    if (!callSid || !buyerDid) {
      logger.warn(
        `[${sessionId}] Transfer skipped — callSid="${callSid}" buyerDid="${buyerDid}"`
      );
      return;
    }

    session.transferAttempted = true;
    session.currentStage      = "wrapup";
    if (session.callLog) session.callLog.disposition = "TRANSFERRED";

    logger.info(`[${sessionId}] TRANSFER_CALL → buyerDid=[MASKED]`);

    try {
      await this.twilioService.transferCall(callSid, buyerDid);
      logger.info(`[${sessionId}] Transfer successful`);
    } catch (e) {
      logger.error(`[${sessionId}] Transfer failed: ${e.message}`);
      if (session.callLog) session.callLog.disposition = "TECH_ISSUES";
    }
  }

  // ─── MAIN UTTERANCE HANDLER ───────────────────────────────────────────
  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    if (session.currentStage === "wrapup" && session.transferAttempted) {
      logger.info(`[${sessionId}] Transfer done — ignoring input`);
      return;
    }

    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    // ── HARD GUARANTEE: if customer asked "and you?/how are you?", reply FIRST ──
    // This prevents the model from asking the next campaign question before answering.
    if (session.pendingSocialReply) {
      session.pendingSocialReply = false;
      session.socialHandledThisTurn = true;

      // Keep this reply short and neutral. No "thanks for asking" unless they asked.
      // (We only set pendingSocialReply when they explicitly asked about you.)
      this.enqueueTTS(sessionId, "[laughs softly] I am doing well.", { flush: true });

      // Continue the flow in qualification mode only.
      session.lastUserInputType = "qualification";
    } else {
      session.socialHandledThisTurn = false;
    }


    if (session.llmAbort) { try { session.llmAbort.abort(); } catch {} }
    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;
    session.activeTurnId += 1;
    session._lastUtterance = userText;  // FIX v22: for social reply context detection
    const myTurnId = session.activeTurnId;
    const t0 = Date.now();
    let thinkingFillerFired = false;
    let thinkingFillerTimer = null;
    let backchannelTimer = null;

    try {
      const systemPrompt    = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      const llmInput = session.socialHandledThisTurn ? "" : userText;

      logger.info(
        `[${sessionId}] LLM_START turn=${myTurnId} stage=${session.currentStage}` +
        ` Q=${session.currentQuestionNum} inputType=${session.lastUserInputType}`
      );

      let fullText        = "";
      let firstTokenAt    = 0;
      let firstChunkSent  = false;
      let firstTTSPromise = null;
      let firstTTSText    = null;
      if (llmController.signal.aborted) return;
      // Backchannel fillers disabled (they sound like confusion and double-ack).

      thinkingFillerTimer = setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
        if (s.lastUserInputType === "social") return;

        // Cooldown: never inject thinking filler too often.
        const now = Date.now();
        if (now - (s.lastThinkingFillerAt || 0) < 20000) return;
        s.lastThinkingFillerAt = now;
        const q = s.currentQuestionNum;
        const fillers = q <= 2
          ? ["mhm.", "right."]
          : q <= 5
          ? ["mhm.", "okay."]
          : ["mhm.", "sure."];
        const filler = fillers[myTurnId % fillers.length];

        thinkingFillerFired = true;
        logger.info(`[${sessionId}] THINKING_FILLER turn=${myTurnId}`);
        this.enqueueTTS(sessionId, filler);
      }, THINKING_FILLER_THRESHOLD_MS);

      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || llmController.signal.aborted) return;

        const sanitized = safeTTS(sentence);
        if (!sanitized) return;
        const textWithoutTags = sanitized.replace(/\[[^\]]+\]/g, "").trim();
        if (textWithoutTags.length < 3 && sanitized.length < 20) return;

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}`);

        if (!firstChunkSent) {
          clearTimeout(thinkingFillerTimer);
          clearTimeout(backchannelTimer); 
          backchannelTimer = null;
          firstChunkSent  = true;
          firstTTSText    = sanitized;
          firstTTSPromise = this.getAudioStream(sessionId, sanitized).catch(() => null);
        } else {
          this.enqueueTTS(sessionId, sanitized);
        }
      });

      chunker.minChunkLength = 8;  
      chunker.maxChunkLength = 220;

      for await (const delta of this.openaiService.streamResponse(
        llmInput, systemPrompt, historyForModel, llmController.signal
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
      clearTimeout(thinkingFillerTimer);
      clearTimeout(backchannelTimer);
      thinkingFillerTimer = null;
      backchannelTimer = null;
      chunker.end();

      logger.info(`[${sessionId}] LLM_COMPLETE turn=${myTurnId} total=${Date.now() - t0}ms`);

      if (firstTTSPromise && firstTTSText && session.activeTurnId === myTurnId) {
        const resolvedStream = await firstTTSPromise;
        if (resolvedStream) {
          const s = this.sessions.get(sessionId);
          if (s && !s.isClosing && !s.isCleaning) {
            if (thinkingFillerFired) {
              s.ttsQueue.push({ text: firstTTSText, _preloadedStream: resolvedStream, onComplete: null });
            } else {
              s.ttsQueue.unshift({ text: firstTTSText, _preloadedStream: resolvedStream, onComplete: null });
            }
            this.runTTSQueue(sessionId).catch(() => {});
          }
        }
      }

      const aiTextClean = sanitizeForTTS(fullText);

      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiTextClean) session.conversationHistory.push({ role: "assistant", content: aiTextClean });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

        this._parseAndUpdateQualificationState(session, userText, fullText);
        this._detectAndSetQuestionLock(session, fullText);
        this._maybeAdvanceStage(session, fullText);

        if (
          session.currentStage === "wrapup" &&
          session.state.qualified &&
          !session.transferAttempted
        ) {
          setTimeout(() => this._maybeTransferCall(sessionId), TRANSFER_DELAY_MS);
        }

        session.lastUserInputType = "qualification";
        // FIX v22: clear pending confirm after LLM has processed it
        if (session.pendingConfirmField) {
          session.pendingConfirmField = null;
          session.pendingConfirmValue = null;
        }
      }

      session.state.retriesCantHear = 0;

    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance error: ${e.message}`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      }
    } finally {
      // FIX: always clear timers — prevents ghost audio on dead turns
      if (thinkingFillerTimer !== null) {
        clearTimeout(thinkingFillerTimer);
        thinkingFillerTimer = null;
      }
      if (backchannelTimer !== null) {
        clearTimeout(backchannelTimer);
        backchannelTimer = null;
      }
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        if (s.activeTurnId === myTurnId) s.llmAbort = null;
      }
    }
  }

  // ─── QC BLOCK PARSER ──────────────────────────────────────────────────
  _parseAndUpdateQualificationState(session, userText, rawLLMText) {
    const qcMatch = (rawLLMText || "").match(/<QC>([\s\S]*?)<\/QC>/i);
    if (!qcMatch) {
      logger.warn(`[${session.id}] No QC block — using fallback parser`);
      this._fallbackParseFromAiText(session, userText, rawLLMText);
      return;
    }

    let qc;
    try { qc = JSON.parse(qcMatch[1].trim()); }
    catch (e) {
      logger.warn(`[${session.id}] QC JSON parse error: ${e.message}`);
      this._fallbackParseFromAiText(session, userText, rawLLMText);
      return;
    }

    const st = session.state;
    // FIX v22: LLM sometimes emits q=null. Normalize to current question number.
    const { result, field, value } = qc;
    const q    = (typeof qc.q === "number" && qc.q > 0) ? qc.q : session.currentQuestionNum;
    const next = (typeof qc.next === "number" && qc.next > 0) ? qc.next : q;

    logger.info(`[${session.id}] QC q=${q} result=${result} next=${next} field=${field}`);
    // value not logged — may contain PII (email, name)

    // ── Capture structured fields ─────────────────────────────────────────
    if (field && value && value !== "null" && value !== null) {
      const cleanValue = String(value).trim();

      if (field === "email" && cleanValue.includes("@") && cleanValue.includes(".")) {
        st.email = cleanValue;
        st.capturedAnswers.email = cleanValue;
        session.questionsAnswered.email = cleanValue;
        session.awaitingAnswerFor = null;
        // FIX v22: flag for read-back confirmation in next LLM turn
        session.pendingConfirmField = "email";
        session.pendingConfirmValue = cleanValue;
        logger.info(`[${session.id}] Email captured: [MASKED]`);

      } else if (field === "zip" && /^\d{5}$/.test(cleanValue)) {
        st.zip = cleanValue;
        st.capturedAnswers.zip = cleanValue;
        session.questionsAnswered.zip = cleanValue;
        session.awaitingAnswerFor = null;
        // FIX v22: flag for read-back confirmation
        session.pendingConfirmField = "zip";
        session.pendingConfirmValue = cleanValue;
        logger.info(`[${session.id}] Zip captured`);

      } else if (field === "fullName") {
        const nameCheck = cleanValue.replace(/[?!.,]/g, "").trim();
        const nameValid = (
          nameCheck.length > 1 &&
          !/^\d+$/.test(nameCheck) &&
          !/^(hello|hey|hi|yes|no|okay|sure|what|again|sorry|mhm|uh|um|nope|nah|bye)$/i.test(nameCheck)
        );
        // FIX: was missing braces — st.fullName was always set regardless of nameValid
        if (nameValid) {
          st.fullName = cleanValue;
          st.capturedAnswers.fullName = cleanValue;
          session.questionsAnswered.fullName = cleanValue;
          session.awaitingAnswerFor = null;
          logger.info(`[${session.id}] Name captured`);
        } else {
          logger.info(`[${session.id}] Name rejected (invalid): value omitted from log`);
        }
      }
    }

    // ── skip ──────────────────────────────────────────────────────────────
    if (result === "skip") {
      logger.info(`[${session.id}] Q${q} skip — staying on Q${next || q}`);
      if (typeof next === "number" && next > 0) session.currentQuestionNum = next;
      return;
    }

    // ── fail ──────────────────────────────────────────────────────────────
    if (result === "fail") {
      logger.info(`[${session.id}] Q${q} FAIL — NOT_QUALIFIED`);
      if (q === 1) st.ageQualified               = false;
      if (q === 2) st.incomeQualified             = false;
      if (q === 3) st.govCoverageQualified        = false;
      if (q === 4) st.employerCoverageQualified   = false;
      if (q === 5) st.bankAccountQualified        = false;
      if (q === 7) st.subsidyCheckQualified       = false;
      if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      return;
    }

    // ── pass ──────────────────────────────────────────────────────────────
    if (result === "pass") {
      if (q === 1) { st.ageQualified             = true; }
      if (q === 2) { st.incomeQualified           = true; }
      if (q === 3) { st.govCoverageQualified      = true; }
      if (q === 4) { st.employerCoverageQualified = true; }
      if (q === 5) { st.bankAccountQualified      = true; }
      if (q === 7) {
        st.subsidyCheckQualified = true;
        st.qualified             = true;
        session.currentStage     = "preTransfer";
        logger.info(`[${session.id}] Q7 pass → QUALIFIED → preTransfer`);
      }
      if (typeof next === "number" && next > 0) {
        session.currentQuestionNum = next;
      }
      logger.info(`[${session.id}] Q${q} pass → Q${session.currentQuestionNum}`);
    }
  }

  _fallbackParseFromAiText(session, userText, aiText) {
    const lower = (aiText  || "").toLowerCase();
    const uText = (userText || "").toLowerCase();
    const st    = session.state;
    const q     = session.currentQuestionNum;

    if (q === 1 && st.ageQualified === null) {
      const ageMatch = uText.match(/\b(\d{1,3})\b/);
      if (ageMatch) {
        const age = parseInt(ageMatch[1], 10);
        if (age >= 1 && age <= 64 && /household income|twenty thousand|income.*year/i.test(lower)) {
          st.ageQualified = true; session.currentQuestionNum = 2;
          logger.info(`[${session.id}] FALLBACK Q1 pass → Q2`);
        } else if (age >= 65) {
          st.ageQualified = false;
          if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
        }
      } else if (/household income|twenty thousand/i.test(lower)) {
        st.ageQualified = true; session.currentQuestionNum = 2;
        logger.info(`[${session.id}] FALLBACK Q1 → Q2`);
      }
    }

    if (q === 2 && st.incomeQualified === null) {
      if (/medicare|medicaid|tricare|va coverage/i.test(lower)) {
        st.incomeQualified = true; session.currentQuestionNum = 3;
        logger.info(`[${session.id}] FALLBACK Q2 → Q3`);
      } else if (/not able to assist|cannot assist/i.test(lower)) {
        st.incomeQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }

    if (q === 3 && st.govCoverageQualified === null) {
      if (/employer|through.*job|through.*work|health insurance.*job/i.test(lower)) {
        st.govCoverageQualified = true; session.currentQuestionNum = 4;
        logger.info(`[${session.id}] FALLBACK Q3 → Q4`);
      } else if (/already covered|not able to assist/i.test(lower)) {
        st.govCoverageQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }

    if (q === 4 && st.employerCoverageQualified === null) {
      if (/bank account|active bank/i.test(lower)) {
        st.employerCoverageQualified = true; session.currentQuestionNum = 5;
        logger.info(`[${session.id}] FALLBACK Q4 → Q5`);
      } else if (/coverage through your employer|you are all set/i.test(lower)) {
        st.employerCoverageQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }

    if (q === 5 && st.bankAccountQualified === null) {
      if (/email|email address/i.test(lower)) {
        st.bankAccountQualified = true; session.currentQuestionNum = 6;
        logger.info(`[${session.id}] FALLBACK Q5 → Q6`);
      } else if (/cannot go ahead without/i.test(lower)) {
        st.bankAccountQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }

    if (q === 6) {
      if (/subsidy card|benefits card|free money/i.test(lower)) {
        session.currentQuestionNum = 7;
        logger.info(`[${session.id}] FALLBACK Q6 → Q7`);
      }
    }

    if (q === 7 && st.subsidyCheckQualified === null) {
      if (/it looks like.*qualify|affordable care act/i.test(lower)) {
        st.subsidyCheckQualified = true;
        st.qualified             = true;
        session.currentQuestionNum = 8;
        session.currentStage     = "preTransfer";
        logger.info(`[${session.id}] FALLBACK Q7 → QUALIFIED`);
      } else if (/cannot assist with that/i.test(lower)) {
        st.subsidyCheckQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }
  }

  // ─── QUESTION LOCK ────────────────────────────────────────────────────
  _detectAndSetQuestionLock(session, rawLLMText) {
    const qcMatch = (rawLLMText || "").match(/<QC>([\s\S]*?)<\/QC>/i);
    if (!qcMatch) return;
    let qc;
    try { qc = JSON.parse(qcMatch[1].trim()); } catch { return; }

    const { field, value } = qc;
    const st = session.state;

    if (field === "email" && !st.email && !session.awaitingAnswerFor) {
      session.awaitingAnswerFor = "email";
      logger.info(`[${session.id}] Question lock → email`);
    } else if (field === "zip" && !st.zip && !session.awaitingAnswerFor) {
      session.awaitingAnswerFor = "zip";
      logger.info(`[${session.id}] Question lock → zip`);
    } else if (field === "fullName" && !st.fullName && !session.awaitingAnswerFor) {
      session.awaitingAnswerFor = "fullName";
      logger.info(`[${session.id}] Question lock → fullName`);
    }

    if (field && value && value !== "null") {
      if (field === "email"    && st.email)    session.awaitingAnswerFor = null;
      if (field === "zip"      && st.zip)      session.awaitingAnswerFor = null;
      if (field === "fullName" && st.fullName) session.awaitingAnswerFor = null;
    }
  }

  // ─── STAGE ADVANCEMENT ────────────────────────────────────────────────
  _maybeAdvanceStage(session, rawLLMText) {
    const lower = (rawLLMText || "").toLowerCase();

    if (session.currentStage === "qualification") {
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

  // ─── MID-CALL SILENCE ─────────────────────────────────────────────────
  armMidCallSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;
    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");
    this._setTimer(sessionId, "midCheck", MID_SILENCE_CHECK_MS, async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.isClosing || s.isCleaning || s.isSpeaking || s.isProcessingUtterance) return;
      if (s.currentStage === "wrapup" && s.transferAttempted) return;
      const sinceSpeech  = Date.now() - (s.lastSpeechAt || 0);
      const sinceInterim = s.userSpeech?.lastInterimTime
        ? Date.now() - s.userSpeech.lastInterimTime : 999999;
      if (sinceInterim < 2500 || sinceSpeech < 3500) return;
      await this._maybeCantHearOrPrompt(sessionId);
    });
  }

  async _maybeCantHearOrPrompt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;
    const now          = Date.now();
    const st           = session.state;
    const sinceSpeech  = now - (session.lastSpeechAt || 0);
    const sinceInterim = session.userSpeech?.lastInterimTime
      ? now - session.userSpeech.lastInterimTime : 999999;

    if (sinceSpeech > 8000 && sinceInterim > 8000) {
      if (st.lastCantHearAt && now - st.lastCantHearAt < CANT_HEAR_COOLDOWN_MS) {
        this.enqueueTTS(sessionId, "hey, are you still with me?", { flush: true });
      } else {
        st.retriesCantHear = (st.retriesCantHear || 0) + 1;
        st.lastCantHearAt  = now;
        if (st.retriesCantHear <= CANT_HEAR_MAX_RETRIES) {
          const silenceChecks = [
            "hey, are you still with me?",
            "hey, can you hear me okay?",
            "hey, I am not able to hear you - are you still there?",
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
      const now2          = Date.now();
      const sinceSpeech2  = now2 - (ss.lastSpeechAt || 0);
      const sinceInterim2 = ss.userSpeech?.lastInterimTime
        ? now2 - ss.userSpeech.lastInterimTime : 999999;
      if (sinceSpeech2 < 3500 || sinceInterim2 < 3500 || ss.isSpeaking || ss.isProcessingUtterance) return;
      if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "UNRESPONSIVE";
      await this.politeHangup(sessionId, {
        finalMessage: "I am not able to hear you. I will try calling back another time. Have a great day.",
      });
    });
  }

  // ─── STOP + CLEAR ─────────────────────────────────────────────────────
  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttsAbort)  { try { session.ttsAbort.abort();  } catch {} session.ttsAbort  = null; }
    if (session.llmAbort)  { try { session.llmAbort.abort();  } catch {} session.llmAbort  = null; }
    session.isSpeaking    = false;
    session.ttsQueue.length = 0;
    const us = session.userSpeech;
    if (us?.finalizeTimer)       { clearTimeout(us.finalizeTimer);       us.finalizeTimer       = null; }
    if (us?.hardMaxTimer)        { clearTimeout(us.hardMaxTimer);        us.hardMaxTimer        = null; }
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

  // ─── HANGUP + CLEANUP ─────────────────────────────────────────────────
  async endTwilioCall(sessionId) {
    const session = this.sessions.get(sessionId);
    const callSid = session?.callLog?.callSid;
    if (!callSid) return;
    await this.twilioService.endCallHard(callSid);
  }

  async politeHangup(sessionId, { finalMessage } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing) return;
    session.isClosing    = true;
    session.currentStage = "wrapup";
    this._clearAllTimers(session);
    try {
      if (finalMessage) {
        this.enqueueTTS(sessionId, finalMessage, { flush: true });
        await this._waitForTTSIdle(sessionId, 9000);
      }
    } catch {}
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

    try { this._clearAllTimers(session); this.stopTTS(sessionId); } catch {}
    try { this.deepgramService.closeTranscriptionStream(sessionId); } catch {}

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
        session.callLog.disposition       = dispositionObj.status;
        session.callLog.dispositionDetail = dispositionObj;

        if (session.state?.capturedAnswers)
          session.callLog.capturedAnswers = session.state.capturedAnswers;

        await session.callLog.save();
        logger.info(`[${sessionId}] CallLog saved disposition=${dispositionObj.status}`);
      }
    } catch (e) {
      logger.error(`[${sessionId}] callLog save failed: ${e.message}`);
    }

    try { if (session.ws?.readyState === WebSocket.OPEN) session.ws.close(); } catch {}
    this.sessions.delete(sessionId);
    logger.info(`Session cleaned: ${sessionId}`);
  }

  cleanupInactiveSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > 300000) {
        logger.warn(`Cleaning inactive session: ${sessionId}`);
        if (session.callLog && !session.callLog.disposition)
          session.callLog.disposition = "UNRESPONSIVE";
        this.cleanupSession(sessionId, { endedBy: "inactive_cleanup" });
      }
    }
  }
}

module.exports = MediaStreamHandler;