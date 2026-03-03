// MediaStreamHandler.js — production v7
const WebSocket = require("ws");
const TwilioService = require("../services/TwilioService");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

// ─────────────────────────── helpers ───────────────────────────────────────

function sanitizeForTTS(text) {
  return (text || "")
    .replace(/\(short pause\)/gi, "")
    .replace(/\(pause\)/gi, "")
    // Strip uppercase system/internal tags
    .replace(/\[(SYSTEM|SYS|STAGE|QC|SECTION|NOTE|INTERNAL)[^\]]*\]/gi, "")
    // FIX 2: Strip malformed bracket content that is NOT a valid ElevenLabs tag.
    // Valid tags: [laughs softly], [chuckles], [laughs], [laughs lightly]
    // Invalid (LLM hallucination): [mhm, okaaay], [laughs softly, okaaay], etc.
    // Rescue the inner text so it is spoken rather than lost entirely.
    .replace(/\[(?!laughs softly\]|chuckles\]|laughs\]|laughs lightly\])[^\]]*\]/gi, (match) => {
      const inner = match.slice(1, -1).trim();
      // Keep inner text only if it looks like speakable words
      if (/^[a-z0-9 ,'.!?-]+$/i.test(inner) && inner.length < 40) return inner;
      return "";
    })
    .replace(/={3,}/g, "")
    .replace(/^\s*(SYS|SYSTEM|SECTION).*$/gim, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripQCBlocks(text) {
  return (text || "").replace(/<QC>[\s\S]*?<\/QC>/gi, "");
}

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

// ─── FILLER / BACKCHANNEL ─────────────────────────────────────────────────
const FILLER_REGEX =
  /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo|hmm|hm|mmm|mm|mhm|mhmm|uh huh|uh-huh|uhhuh|uh|um|erm|go ahead|please|continue|and|so|well|but|okay go ahead|sure go ahead|go on|keep going|i'm here|im here|still here|i hear you|i got you|gotcha)\.?\s*$/i;

function isFiller(text) { return FILLER_REGEX.test((text || "").trim()); }

// POST_GREETING_FILLER_REGEX — only applies BEFORE the first LLM turn (activeTurnId === 0).
// Absorbs "Hello?", "Can you hear me?" etc. which cause gpt-4o-mini to re-greet.
// Once activeTurnId >= 1, this regex is NOT checked — "Yes", "Yeah", "Sure", "Ok"
// are qualification answers and must reach the LLM.
const POST_GREETING_FILLER_REGEX =
  /^(?:hello[?!.]?|hi[?!.]?|hey[?!.]?|can you hear me[?!.]?|can you hear[?!.]?|hello[?!.]? can you hear[?!.]?|hello[?!.]? can you hear me[?!.]?|are you there[?!.]?|hello can you hear me[?!.]?|is anyone there[?!.]?|yeah[?!.]?|yep[?!.]?|yes[?!.]?|i'm here[.]?|im here[.]?|i am here[.]?|ok[.]?|okay[.]?|sure[.]?|go ahead[.]?|alright[.]?|are you still there[?!.]?|can you hear me now[?!.]?|testing[?!.]?|hello[?!.]? hello[?!.]?)$/i;

function isPostGreetingFiller(text) {
  return POST_GREETING_FILLER_REGEX.test((text || "").trim());
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

// ─── COMPRESSED RUNTIME PROMPT ────────────────────────────────────────────
// ~1,800 tokens — sent to OpenAI every turn instead of the full 42k-char campaign prompt.
// Full campaign prompt is stored in session.systemPrompt for reference but never sent.
function buildCompressedRuntimePrompt() {
  return `========================================
ACA QUALIFICATION VOICE AGENT — Matt
========================================

You are Matt, a warm, relaxed, gently playful ACA qualification voice agent for a healthcare benefits company. Qualify customers for ACA health insurance and warm-transfer qualified leads to licensed agents.

## PERSONALITY (always on)
Calm, warm, quietly playful. Never formal. Slight smile in every sentence. Never rush.
- NO exclamation marks. Periods only.
- NO: Awesome, Excellent, Perfect, Amazing, Wonderful
- ALL speech soft, gentle, quiet.

## SPEECH RULES (apply every turn)
- ONE question at a time. Never bundle.
- NO contractions. Full words only.
- Every 1-2 sentences: filler, hesitation, stretch word, OR laughter tag.
- Laughter tag BEFORE words: "[laughs softly] okaaay" not "okaaay [laughs softly]"
- Every "um" or "uh" followed immediately by <break time="300ms"/>
- Questions end softly: "...right?" or "...yeah?" or "...currently?"
- Mid-sentence restarts 3-4x per call: "it looks like- yeah, it looks like..."
- NO transition announcements ("next question", "moving on")

## LAUGHTER TAGS (ElevenLabs native — use freely)
[laughs softly] — most common. [chuckles] — brief. [laughs] — genuinely funny. [laughs lightly] — AI deflect.

## ACKNOWLEDGMENT (rotate every time — NEVER same back to back)
"[laughs softly] okaaay." / "[chuckles] mhm." / "[laughs softly] yeaah, got it." / "mmkay, suure." / "[chuckles] oh suure." / "mhm, okaaay." / "totaally." — "alright" max once per 4-5 turns.

## INTERRUPTION RULE
When interrupted: filler/laugh ONLY. No full sentences as direct reaction. Then resume.
Wrong: "I understand." Right: "[laughs softly] oh uh <break time="300ms"/> sooo..."

## STAGE 1: OPENING (complete ALL 3 parts before Q1)
Part 1 (greeting — say as ONE unbroken flow, rotate each call):
- "Hi, thank you for- yeah, thank you for taking the call. This is Matt with healthcare benefits, I hope you are doing well."
- "Hi, uh- <break time="200ms"/> thank you for taking the call. This is Matt with healthcare benefits, I hope you are doing good."
- "Hey there, sooo this is Matt with healthcare benefits, hope your day is going well."
- "Hey, hi- this is Matt, um <break time="300ms"/> calling from healthcare benefits, I hope you are having a good day."

Part 2 (REQUIRED): "so.. I am calling to offer you a no-obligation, no-cost health insurance plan quote designed for individuals under 65."
Part 3 (REQUIRED): "I just need to ask a few quick questions to see if you may qualify."
Then immediately Q1. If customer says "hello?", "hi", short word mid-greeting — DO NOT STOP. Finish sentence first.

## STAGE 2: QUALIFICATION (Q1 through Q7 in order. Never re-ask. Never skip.)

Q1 — Age: "So uh <break time="300ms"/> just to start - how old are you?"
  Pass: age 1-64 → Q2. Fail: 65+ → "I am sorry, but we can only help individuals under 65. Thank you." END

Q2 — Income: "And uh <break time="300ms"/> is your- yeah, is your household income more than twenty thousand a year?"
  Pass: yes → Q3. Fail: no/under → "I am sorry, but we are not able to assist at this time. Thank you." END

Q3 — Gov coverage: "And um <break time="300ms"/> are you currently on Medicare, Medicaid, Tricare, or any VA coverage...?"
  Pass: no → Q4. Fail: yes → "Since you are already covered under [program], we will not be able to assist. Thank you." END

Q4 — Employer coverage: "And um <break time="300ms"/> do you have health insurance through your employer or your job...?"
  Pass: no → Q5. Fail: yes → "Since you have coverage through your employer, you are all set. Thank you." END

Q5 — Bank account: "Okaaay and uh <break time="300ms"/> do you have a valid bank account...?"
  Pass: yes → Q6. Fail: no → "We can not go ahead without it. Thank you." END

Q6 — Email (optional, no disqualify): "Okaaay sooo, um <break time="300ms"/> what is your email address? And just take your time with that."
  Wait FULL 5-6 seconds. Customer spells slowly. Then go to Q7.

Q7 — Subsidy check: "And um <break time="300ms"/> just to confirm real quick - are you calling about a subsidy card, a benefits card, or free money...?"
  Pass: no → STAGE 3. Fail: yes → "Unfortunately, we can not assist with that. Thank you." END

## STAGE 3: PRE-TRANSFER (LOCKED ORDER — never skip any step)
Step 1 — MANDATORY opening sentence (word for word, every time):
"[laughs softly] okaaay sooo, um <break time="300ms"/> it looks like- yeah, it looks like you might qualify for a better health insurance plan under the Affordable Care Act. That is good news. I just need a couple more quick things from you."

Step 2 — Zip: "Um <break time="300ms"/> can you confirm your zip code for me?"
Step 3 — Name: "[laughs softly] suure, and your full name, please?"
Step 4 — Transition: "[laughs softly] suure. Before I connect you to a licensed agent, I just need to quickly read a brief disclaimer."

## STAGE 4: DISCLAIMER (read clean — no fillers, no break tags, no laughter)
"By moving forward, you are giving electronic consent for marketing purposes, which is the same as written consent. This allows us to share information even if you are on a do-not-call list. Your consent is not required to buy anything, and you can revoke it at any time. Does that make sense?"
If yes: "Sounds good. I am connecting you to a licensed expert now. Please remember, we are just providing no-obligation health insurance quotes. You will be connected in about five seconds."

## OBJECTION HANDLING (one rebuttal each, then respect decision)
Not Interested: "[laughs softly] oh uh <break time="300ms"/> yeah, I- I totally get that. A lotta people- yeah, a lotta people feel that way at first. Um <break time="300ms"/> the only reason I am calling is just to check if you qualify for more affordable coverage. Would you be open to just- yeah, to seeing if you might save money?"
Busy: "[laughs softly] oh uh <break time="300ms"/> yeah, totally. It should- yeah, it should honestly take less than two minutes. Do you have a quick minute now or would a callback work better?"
Already insured: "[laughs softly] oh uh <break time="300ms"/> yeah, that- that is great. Um <break time="300ms"/> a lot of people still qualify for more affordable options. Would you be open to a quick review?"
DNC request: "Of course, I will make sure we do not contact you again. Thank you. Have a good day." END IMMEDIATELY
AI/robot question: "[laughs lightly] ha, that is a good question. But let me get back to seeing if you qualify for better coverage."
Wrong person: "[laughs softly] oh sorry about that. I will update our records. Thanks. Have a great day." END

## SILENCE (after 5-6 full seconds of complete silence only)
Rotate: "hey, are you still with me?" / "hey, can you hear me okay?" / "hey, I am not able to hear you - are you still there?"
After 2 failed: "I am not able to hear you. I will try calling back another time. Have a great day." END

## MEMORY
Never re-ask answered questions. If customer volunteers info (age, income), acknowledge and skip that Q.

## TECHNICAL
No contractions. No — symbol (use -). Write numbers as words. No exclamation marks.
Square brackets are ONLY for these four exact ElevenLabs tags: [laughs softly], [chuckles], [laughs], [laughs lightly].
NEVER put acknowledgments or words inside brackets. "[mhm, okaaay]" is WRONG. Write: "mhm, okaaay." instead.`;
}

// ─────────────────────────── tuning constants ──────────────────────────────
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

    // Pre-build the compressed prompt once at startup (it is static)
    this._compressedRuntimePrompt = buildCompressedRuntimePrompt();
    logger.info(`MediaStreamHandler initialized. Runtime prompt: ~${Math.round(this._compressedRuntimePrompt.length / 4)} tokens`);

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

  // ─── SESSION ──────────────────────────────────────────────────────────────
  createEmptySession(sessionId, ws) {
    return {
      id: sessionId,
      ws,
      callLog: null,
      campaign: null,
      systemPrompt: null,   // full prompt stored but NOT sent to model
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
      currentQuestionNum: 0,
      state: {
        qualified: false,
        zip: "",
        fullName: "",
        email: "",
        retriesCantHear: 0,
        lastCantHearAt: 0,
        capturedAnswers: {},
        ageQualified: null,
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
    session.systemPrompt = systemPrompt; // stored for reference, not sent to model
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
    this.maybePlayInitialGreeting(sessionId).catch(() => {});
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
        s.currentQuestionNum = 1;
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

    // FIX 1: Post-greeting filler absorption — ONLY active before first LLM turn.
    // Window: openingComplete=true AND activeTurnId===0 (no Q has been asked yet).
    // Once activeTurnId >= 1, "Yes", "Yeah", "Sure", "Ok" are qualification answers
    // and must reach the LLM. Never absorb them after Q1 has been asked.
    if (session.openingComplete && session.activeTurnId === 0 && isPostGreetingFiller(utterance)) {
      logger.info(`[${sessionId}] Post-greeting filler absorbed (no LLM): "${utterance}"`);
      return;
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
      try { audioStream.off("data", onData); audioStream.off("end", onEnd); audioStream.off("error", onError); } catch {}
      try { audioStream.destroy(); } catch {}
      session.isSpeaking = false;
      session.ttsAbort = null;
      logger.info(`[${sessionId}] TTS done frames=${frameCount}`);
    }
  }

  // ─── LLM ──────────────────────────────────────────────────────────────────
  _buildSystemPrompt(session) {
    const st = session.state || {};

    const answeredQs = [];
    if (st.ageQualified !== null)              answeredQs.push(`Q1(age):${st.ageQualified ? "pass" : "fail"}`);
    if (st.incomeQualified !== null)           answeredQs.push(`Q2(income):${st.incomeQualified ? "pass" : "fail"}`);
    if (st.govCoverageQualified !== null)      answeredQs.push(`Q3(govCoverage):${st.govCoverageQualified ? "pass" : "fail"}`);
    if (st.employerCoverageQualified !== null) answeredQs.push(`Q4(employerCoverage):${st.employerCoverageQualified ? "pass" : "fail"}`);
    if (st.bankAccountQualified !== null)      answeredQs.push(`Q5(bankAccount):${st.bankAccountQualified ? "pass" : "fail"}`);
    if (st.email)                              answeredQs.push(`Q6(email):${st.email}`);
    if (st.subsidyCheckQualified !== null)     answeredQs.push(`Q7(subsidy):${st.subsidyCheckQualified ? "pass" : "fail"}`);

    const awaitLabel = session.awaitingAnswerFor ? `;collecting=${session.awaitingAnswerFor}` : "";

    const greetedFlag = session.openingComplete
      ? "GREETING_COMPLETE=true — DO NOT re-introduce yourself. DO NOT say your name or company again. You are mid-call."
      : "GREETING_IN_PROGRESS — Complete the greeting script before Q1.";

    const stateBlock = [
      `\n\n---`,
      `## CURRENT CALL STATE (internal — do not read aloud)`,
      greetedFlag,
      `stage: ${session.currentStage}`,
      `nextQuestion: Q${session.currentQuestionNum}`,
      `questionsAnswered: [${answeredQs.join(", ") || "none yet"}]`,
      `zip: ${st.zip || "not collected"}`,
      `fullName: ${st.fullName || "not collected"}`,
      `email: ${st.email || "not collected"}`,
      `qualified: ${!!st.qualified}${awaitLabel}`,
      `INSTRUCTION: Stage is "${session.currentStage}". Next Q to ask: Q${session.currentQuestionNum}. Never re-ask answered Qs. Never skip Qs. Follow script order.`,
      `---`,
    ].join("\n");

    return this._compressedRuntimePrompt + stateBlock;
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    if (session.llmAbort) { try { session.llmAbort.abort(); } catch {} }
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

      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || llmController.signal.aborted) return;

        const sanitized = safeTTS(sentence);
        if (!sanitized) return;
        // Don't fire a chunk that is only a bare laughter tag with no spoken content
        const textWithoutTags = sanitized.replace(/\[[^\]]+\]/g, "").trim();
        if (textWithoutTags.length < 3 && sanitized.length < 20) return;

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}: "${sanitized}"`);

        if (!firstChunkSent) {
          firstChunkSent = true;
          firstTTSText = sanitized;
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

      if (firstTTSPromise && firstTTSText && session.activeTurnId === myTurnId) {
        const resolvedStream = await firstTTSPromise;
        if (resolvedStream) {
          const s = this.sessions.get(sessionId);
          if (s && !s.isClosing && !s.isCleaning) {
            s.ttsQueue.unshift({ text: firstTTSText, _preloadedStream: resolvedStream, onComplete: null });
            this.runTTSQueue(sessionId).catch(() => {});
          }
        }
      }

      const aiText = sanitizeForTTS(fullText);

      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiText) session.conversationHistory.push({ role: "assistant", content: aiText });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

        if (questionBeingAnswered) {
          session.state.capturedAnswers[questionBeingAnswered] = userText;
          session.questionsAnswered[questionBeingAnswered] = userText;
          if (questionBeingAnswered === "zip") session.state.zip = userText.trim();
          if (questionBeingAnswered === "fullName") session.state.fullName = userText.trim();
          if (questionBeingAnswered === "email") session.state.email = userText.trim();
          if (session.awaitingAnswerFor === questionBeingAnswered) session.awaitingAnswerFor = null;
          logger.info(`[${sessionId}] Answer stored: ${questionBeingAnswered}="${userText}"`);
        }

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

  _parseAndUpdateQualificationState(session, userText, aiText) {
    const st = session.state;
    const aiLower = (aiText || "").toLowerCase();
    const userLower = (userText || "").toLowerCase();
    const q = session.currentQuestionNum;

    if (q === 1 && st.ageQualified === null) {
      const ageMatch = userText.match(/\b(\d{1,3})\b/);
      if (ageMatch) {
        const age = parseInt(ageMatch[1], 10);
        if (age >= 1 && age <= 64) {
          st.ageQualified = true; session.currentQuestionNum = 2;
          logger.info(`[${session.id}] Q1 passed: age=${age} → Q2`);
        } else if (age >= 65) {
          st.ageQualified = false;
          if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
        }
      }
      if (/household income|twenty thousand|income.*year/i.test(aiLower) && q === 1) session.currentQuestionNum = 2;
    }

    if (q === 2 && st.incomeQualified === null) {
      if (/\byes\b|\byeah\b|\byep\b|\bsure\b|\bi do\b|\bmore\b/i.test(userLower)) {
        st.incomeQualified = true; session.currentQuestionNum = 3;
      } else if (/\bno\b|\bnope\b|\bnot\b|\bless\b/i.test(userLower)) {
        st.incomeQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
      if (/medicare|medicaid|tricare|va coverage/i.test(aiLower) && q === 2) session.currentQuestionNum = 3;
    }

    if (q === 3 && st.govCoverageQualified === null) {
      if (/\bno\b|\bnope\b|\bnot\b|\bi do not\b|\bdo not have\b/i.test(userLower)) {
        st.govCoverageQualified = true; session.currentQuestionNum = 4;
      } else if (/\byes\b|\byeah\b|\bi am\b|\bi do\b/i.test(userLower)) {
        st.govCoverageQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
      if (/employer|through.*job|through.*work/i.test(aiLower) && q === 3) session.currentQuestionNum = 4;
    }

    if (q === 4 && st.employerCoverageQualified === null) {
      if (/\bno\b|\bnope\b|\bnot\b|\bi do not\b|\bdo not have\b/i.test(userLower)) {
        st.employerCoverageQualified = true; session.currentQuestionNum = 5;
      } else if (/\byes\b|\byeah\b|\bi do\b|\bi am\b/i.test(userLower)) {
        st.employerCoverageQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
      if (/bank account|active bank/i.test(aiLower) && q === 4) session.currentQuestionNum = 5;
    }

    if (q === 5 && st.bankAccountQualified === null) {
      if (/\byes\b|\byeah\b|\byep\b|\bsure\b|\bi do\b|\bi have\b/i.test(userLower)) {
        st.bankAccountQualified = true; session.currentQuestionNum = 6;
      } else if (/\bno\b|\bnope\b|\bnot\b/i.test(userLower)) {
        st.bankAccountQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
      if (/email|email address/i.test(aiLower) && q === 5) session.currentQuestionNum = 6;
    }

    if (q === 6) {
      if (/subsidy card|benefits card|free money/i.test(aiLower)) {
        session.currentQuestionNum = 7;
        logger.info(`[${session.id}] Q6 done → Q7`);
      }
    }

    if (q === 7 && st.subsidyCheckQualified === null) {
      if (/\bno\b|\bnope\b|\bnot\b|\bi am not\b|\bdo not\b/i.test(userLower)) {
        st.subsidyCheckQualified = true;
        st.qualified = true;
        session.currentQuestionNum = 8;
        logger.info(`[${session.id}] Q7 passed → QUALIFIED → Stage 3`);
      } else if (/\byes\b|\byeah\b|\bi am\b|\bi do\b/i.test(userLower)) {
        st.subsidyCheckQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }

    if (/it looks like.*qualify.*affordable care act/i.test(aiLower)) {
      st.qualified = true;
      session.currentStage = "preTransfer";
      logger.info(`[${session.id}] Stage 3 opening detected → preTransfer`);
    }
  }

  _detectAndSetQuestionLock(session, aiText) {
    if (session.awaitingAnswerFor) return;
    const lower = (aiText || "").toLowerCase();
    if (/\bzip\b|\bzip code\b|\bconfirm your zip\b/.test(lower)) {
      session.awaitingAnswerFor = "zip";
      logger.info(`[${session.id}] Question lock → zip`);
    } else if (/\bfull name\b|\byour name\b|\bname please\b/.test(lower)) {
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
    if (session.ttsAbort) { try { session.ttsAbort.abort(); } catch {} session.ttsAbort = null; }
    session.isSpeaking = false;
    if (session.llmAbort) { try { session.llmAbort.abort(); } catch {} session.llmAbort = null; }
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

    try { if (session.ws?.readyState === WebSocket.OPEN) session.ws.close(); } catch {}
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