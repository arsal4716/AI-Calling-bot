// MediaStreamHandler.js — production v17
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

// ─── FILLER / BACKCHANNEL ─────────────────────────────────────────────────

const FILLER_REGEX =
  /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo|hmm|hm|mmm|mm|mhm|mhmm|uh huh|uh-huh|uhhuh|uh|um|erm|go ahead|please|continue|and|so|well|but|okay go ahead|sure go ahead|go on|keep going|i'm here|im here|still here|i hear you|i got you|gotcha)\.?\s*$/i;

function isFiller(text) { return FILLER_REGEX.test((text || "").trim()); }

const POST_GREETING_FILLER_REGEX =
  /^(?:hello[?!.]?|hi[?!.]?|hey[?!.]?|can you hear me[?!.]?|can you hear[?!.]?|hello[?!.]?\s+can you hear[?!.]?|hello[?!.]?\s+can you hear me[?!.]?|are you there[?!.]?|hello can you hear me[?!.]?|is anyone there[?!.]?|are you still there[?!.]?|can you hear me now[?!.]?|testing[?!.]?|hello[?!.]?\s+hello[?!.]?)$/i;

function isPostGreetingFiller(text) {
  return POST_GREETING_FILLER_REGEX.test((text || "").trim());
}

const SOCIAL_RESPONSE_REGEX = /^(?:(?:(?:hi|hey|hello)[,.]?\s+)?(?:[a-z]+[,.]?\s+)?(?:what about you|how about you|and you|what about yourself)[?!.]?|(?:(?:hi|hey|hello)[,.]?\s+)?(?:i(?:'m| am)\s+)?(?:doing\s+)?(?:good|fine|great|okay|well|not bad|pretty good|alright|doing well|doing good)(?:\s+(?:thanks?|thank you))?[.!?]?(?:[,.]?\s*(?:and\s+)?(?:you|yourself|what about you)[?!.]?)?|(?:good|fine|great|not bad|okay)[,.]?\s+how\s+(?:are\s+you|about\s+you)[?!.]?|how\s+are\s+you[?!.]?)$/i;

function isSocialResponse(text) {
  return SOCIAL_RESPONSE_REGEX.test((text || "").trim());
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

You are Matt — warm, relaxed, quietly playful. Never formal. Slight smile in every sentence.
You qualify customers for ACA health insurance and warm-transfer qualified leads to licensed agents.

## ⚠️ MANDATORY: QC BLOCK — ALWAYS FIRST, BEFORE YOUR SPOKEN RESPONSE
Every response MUST begin with a QC block. Token limits cut the END of responses — QC first guarantees capture.
Format: <QC>{"q":<currentQ>,"result":"<pass|fail|skip>","next":<nextQ>,"field":"<email|zip|fullName|null>","value":"<value or null>"}</QC>
- pass = answered and qualifies → advance
- fail = does not qualify → call ends
- skip = not answered → stay on same Q

Examples (QC first, then spoken words):
<QC>{"q":1,"result":"pass","next":2,"field":null,"value":null}</QC> oh nice. And uh <break time="300ms"/> is your income over twenty thousand a year?
<QC>{"q":4,"result":"fail","next":4,"field":null,"value":null}</QC> Since you have coverage through your employer, you are all set. Thank you.
<QC>{"q":2,"result":"skip","next":2,"field":null,"value":null}</QC> oh sure. So the question is just - is your household income more than twenty thousand a year?
<QC>{"q":6,"result":"pass","next":7,"field":"email","value":"john@gmail.com"}</QC> oh nice. And um <break time="300ms"/> just to confirm - are you calling about a subsidy card or benefits card?

## GLOBALLY FORBIDDEN WORDS (never, anywhere)
"I see." / "I understand." / "Got it." / "I got it." / "That makes sense." / "My bad." / "No worries." / "Understood." / "Noted." / "Great" / "Perfect" / "Excellent" / "Awesome" / "Amazing"

## HARD RULES (every response, no exceptions)
1. NO exclamation marks. Periods only.
2. NO contractions. Full words: "I am", "do not", "can not", "will not".
3. NO dash symbol —. Use hyphen - instead.
4. NO transition announcements: never say "next question", "moving on".
5. NO bare acknowledgments alone. Never just "okay." — always attach a filler or laughter.
6. Write numbers as words: "twenty five" not "25".
7. Laughter tag ALWAYS before spoken words. RIGHT: "[laughs softly] oh nice." WRONG: "oh nice. [laughs softly]"
8. Square brackets ONLY for: [laughs softly] [chuckles] [laughs] [laughs lightly].
9. Every "um" or "uh" MUST be followed by <break time="300ms"/>. WRONG: "um how old are you?" RIGHT: "um <break time="300ms"/> how old are you?"

## QUALIFICATION RESPONSE FORMAT — STRICT 2-PART STRUCTURE
PART 1: ONE short acknowledgment (laughter tag or filler).
PART 2: The next question immediately.
NOTHING ELSE. No third sentence. No reconfirmation.

WRONG: "[chuckles] mhm." + "So you are not on any of those programs." + "And um do you have insurance through work?"
RIGHT: "[chuckles] mhm." + "And um <break time="300ms"/> do you have health insurance through your employer?"

## CONTEXTUAL FILLER RULE
Confident answer → "[laughs softly] oh nice." / "[chuckles] mhm." / "okay, sure."
Hesitant/confused → "[laughs softly] oh uh <break time="300ms"/> sure." / "[chuckles] oh okay."
Long answer → "[laughs softly] yeah, got it." / "[chuckles] oh sure."
Customer says sorry → "[laughs softly] oh uh <break time="300ms"/> sure." then gently re-ask.

## ACKNOWLEDGMENT ROTATION (never same back-to-back)
"[laughs softly] oh nice." / "[chuckles] mhm." / "[laughs softly] yeah, got it." / "okay, sure." /
"[chuckles] oh sure." / "mhm, okay." / "[laughs softly] ah, sure." / "[laughs softly] ha, okay."
Rule: "alright" max once every 4-5 turns. Never "okay" alone — pair it: "oh okay" or "okay sure".

## MID-SENTENCE RESTARTS (use 3-4 times per call)
"it looks like- yeah, it looks like..." / "And uh <break time="300ms"/> is your- yeah, is your household income..."
"I just need to- let me just ask you real quick..." / "a lot of people- yeah, a lot of people feel that way."

## LAUGHTER TAGS (stripped before voice synthesis — warmth must come from WORDS)
[laughs softly] — most common. [chuckles] — brief/light. [laughs] — genuinely funny. [laughs lightly] — deflecting AI questions.
RIGHT: "[laughs softly] oh nice. And um <break time="300ms"/> do you have a bank account?" → stripped: "oh nice. And um do you have a bank account." ← still warm.
WRONG: "[laughs softly] mhm. And um <break time="300ms"/> do you have a bank account?" → stripped: "mhm. And um do you have a bank account." ← flat.

## INTERRUPTION RULE
Customer interrupts → respond ONLY with filler or soft laugh, then resume.
RIGHT: "[laughs softly] oh uh <break time="300ms"/> so..." WRONG: "I understand."

## CLARIFICATION RULES
Customer asks HOW to answer → gently restate in simpler words with one example. NOT "that is a good question."
AI/robot identity question → "[laughs lightly] ha, that is a good question. But let me get back to seeing if you qualify."

## POST-GREETING SOCIAL RESPONSE RULE
When INPUT_TYPE=SOCIAL_RESPONSE:
→ SENTENCE 1 (mandatory, always first): Warm social reply. Example: "[laughs softly] oh I am doing well, thanks for asking."
→ SENTENCE 2: The next qualification question immediately after.
→ NEVER swap the order. NEVER say the question before the social reply.
→ NEVER re-introduce yourself. NEVER say "this is Matt" or "healthcare benefits" again.
→ WRONG ORDER: "So how old are you? [laughs softly] oh I am doing well." — question came first.
→ RIGHT ORDER: "[laughs softly] oh I am doing well. And um how old are you?"

## STAGE 1: OPENING
Parts 1, 2, 3 in strict order. Never ask Q1 until all three are done.
Part 2: "so.. I am calling to offer you a no-obligation, no-cost health insurance plan quote designed for individuals under sixty-five."
Part 3: "I just need to ask a few quick questions to see if you may qualify."
When GREETING_COMPLETE=true: ALREADY past Stage 1. NEVER re-introduce yourself.

## STAGE 2: QUALIFICATION (Q1-Q7, strict order, never re-ask answered Qs)

Q1 — Age: "So uh <break time="300ms"/> just to start - how old are you?"
  Pass: age 1-64 → 2-part response → Q2. Fail: 65+ → "I am sorry, we can only help individuals under sixty-five. Thank you." END.

Q2 — Income: "And uh <break time="300ms"/> is your- yeah, is your household income more than twenty thousand a year?"
  Pass: yes → Q3. Fail: no → "I am sorry, we are not able to assist at this time. Thank you." END.

Q3 — Gov coverage: "And um <break time="300ms"/> are you currently on Medicare, Medicaid, Tricare, or any VA coverage?"
  Pass: no → Q4. Fail: yes → "Since you are already covered under that program, we will not be able to assist. Thank you." END.

Q4 — Employer coverage: "And um <break time="300ms"/> do you have health insurance through your employer or your job?"
  Pass: no → Q5. Fail: yes → "Since you have coverage through your employer, you are all set. Thank you." END.

Q5 — Bank account: "Okay and uh <break time="300ms"/> do you have a valid bank account?"
  Pass: yes → Q6. Fail: no → "We can not go ahead without a valid bank account. Thank you." END.

Q6 — Email (optional, does not disqualify): "Okay so, um <break time="300ms"/> what is your email address? And just take your time with that."
  Wait patiently. Then → Q7.

Q7 — Subsidy check: "And um <break time="300ms"/> just to confirm - are you calling about a subsidy card, a benefits card, or free money?"
  Pass: no → STAGE 3. Fail: yes → "Unfortunately, we can not assist with that. Thank you." END.

Transition examples:
Q1→Q2: "[laughs softly] oh nice. And uh <break time="300ms"/> is your- yeah, is your household income more than twenty thousand a year?"
Q2→Q3: "[chuckles] mhm. And um <break time="300ms"/> are you currently on Medicare, Medicaid, Tricare, or any VA coverage?"
Q3→Q4: "[laughs softly] yeah, got it. And um <break time="300ms"/> do you have health insurance through your employer?"
Q4→Q5: "okay, sure. And uh <break time="300ms"/> do you have a valid bank account?"
Q5→Q6: "[chuckles] oh sure. Okay so, um <break time="300ms"/> what is your email address?"

## STAGE 3: PRE-TRANSFER (locked order — never skip)
Step 1 — MANDATORY (word for word, always first):
"[laughs softly] okay so, um <break time="300ms"/> it looks like- yeah, it looks like you might qualify for a better health insurance plan under the Affordable Care Act. That is good news. I just need a couple more quick things from you."
Step 2 — Zip: "Um <break time="300ms"/> can you confirm your zip code for me?"
Step 3 — Full name: "[laughs softly] sure, and your full name, please?"
Step 4 — Transition: "[laughs softly] sure. Before I connect you to a licensed agent, I just need to quickly read a brief disclaimer."

## STAGE 4: DISCLAIMER (read clean — no fillers, no break tags, no laughter tags)
"By moving forward, you are giving electronic consent for marketing purposes, which is the same as written consent. This allows us to share information even if you are on a do-not-call list. Your consent is not required to buy anything, and you can revoke it at any time. Does that make sense?"
If yes: "Sounds good. I am connecting you to a licensed expert now. Please remember, we are just providing no-obligation health insurance quotes. You will be connected in about five seconds."

## OBJECTION HANDLING
Not Interested: "[laughs softly] oh uh <break time="300ms"/> yeah, I totally get that. The only reason I am calling is just to check if you qualify for more affordable coverage. Would you be open to just seeing if you might save money?"
If insists: "okay, no problem at all. Have a great day." END.
Busy: "[laughs softly] oh uh <break time="300ms"/> yeah, totally. It should honestly take less than two minutes. Do you have a quick minute now or would a callback work better?"
Already insured: "[laughs softly] oh uh <break time="300ms"/> yeah, that is great. A lot of people still qualify for more affordable options. Would you be open to a quick review?"
DNC request: "Of course, I will make sure we do not contact you again. Thank you. Have a good day." END IMMEDIATELY.
Wrong person: "[laughs softly] oh sorry about that. I will update our records. Have a great day." END.
Not Interested / Goodbye mid-call ("bye", "goodbye", "I have to go") → use Not Interested rebuttal above.

## CUSTOMER ASKS A QUESTION OR SAYS "WHY ARE YOU ASKING THIS?"
If customer asks why you are asking something, or seems confused:
→ Give ONE short, honest, friendly explanation. Then RESUME the SAME question you were on.
→ NEVER go back to Q1 or restart from the beginning.
→ NEVER skip the question — answer their concern and re-ask it in simpler words.
Example: Customer asks "why do you need my age?" during Q1 →
"[laughs softly] oh yeah, just to make sure the plans we have are available for your age group. So uh how old are you?"
Example: Customer asks "why does income matter?" during Q2 →
"[laughs softly] oh sure, it just helps figure out which subsidy level you might qualify for. And uh is your household income over twenty thousand a year?"
RULE: Always land back on the CURRENT question (nextQuestion in state), never an earlier one.

## SILENCE (5-6 full seconds of complete silence only)
Rotate: "hey, are you still with me?" / "hey, can you hear me okay?" / "hey, I am not able to hear you - are you still there?"
After 2 failed: "I am not able to hear you. I will try calling back another time. Have a great day." END.

## QC BLOCK REMINDER
QC block goes FIRST in every response — before spoken words. See top of prompt.`;
}

// ─── TUNING CONSTANTS ─────────────────────────────────────────────────────
const UTTERANCE_HARD_MAX_MS        = 1800;
const MIN_UTTERANCE_CHARS          = 6;
const MIN_UTTERANCE_WORDS          = 2;
// FIX v16: raised from 300ms to 1200ms.
// 300ms was too short — Deepgram transcripts for bot audio arrive 400-800ms after
// the last audio frame is sent. Bot echo was slipping through as customer speech.
const ECHO_GUARD_MS                = 1200;
const BARGEIN_CONFIRM_MS           = 180;
const MID_SILENCE_CHECK_MS         = 11000;
const MID_SILENCE_HANGUP_MS        = 7000;
const CANT_HEAR_COOLDOWN_MS        = 9000;
const CANT_HEAR_MAX_RETRIES        = 2;
const HISTORY_LIMIT                = 14;
const HISTORY_FOR_MODEL            = 10;
// FIX v16: raised from 1600ms to 2800ms.
// At 1600ms the filler was firing on nearly every social/simple turn (~668ms TTFT +
// ~1000ms for SentenceChunker to accumulate first complete sentence = ~1650ms total).
// Result: filler played then real response played immediately after — sounded broken.
// At 2800ms it only fires when the LLM is genuinely slow (network hiccup, long context).
const THINKING_FILLER_THRESHOLD_MS = 2800;
const TRANSFER_DELAY_MS            = 5500;
// FIX: increased from 400 — Stage 3 opening + QC alone can be ~105 tokens; disclaimer ~65 words
const TTS_QUEUE_MAX_DEPTH          = 6;   // FIX: prevents audio pile-up on rapid barge-in
// FIX v15: raised from 16000 to 200000.
// 16000 bytes = 100 frames = 2.02s — ElevenLabs floods the buffer in milliseconds before
// playback starts, so the cap was TRUNCATING every TTS utterance to 2 seconds and
// producing 25-45 WARN log lines per call. ElevenLabs TTS output is bounded by
// safeTTS maxChars=500, giving a hard ceiling of ~256KB worst-case (~32s).
// Typical turns are 15-30 words ≈ 6-12s ≈ 48-96KB. 200KB covers all real cases
// with headroom. At 1000 concurrent sessions this is ~200MB, which is acceptable.
// The cap remains as a genuine safety rail against a hypothetical runaway stream.
const AUDIO_BUFFER_MAX_BYTES       = 200000;
const TWILIO_READY_WAIT_MAX_MS     = 8000;  // FIX: max wait in runTTSQueue before dropping item

// FIX v17: pause inserted between an acknowledgment chunk and the following question chunk.
// Without this, the bot says "oh nice." then IMMEDIATELY says "how old are you?" — the
// customer has zero time to react. 380ms is enough for a natural breath without feeling slow.
const ACK_TO_QUESTION_PAUSE_MS     = 380;

// FIX v17: after greeting completes, wait this long before any customer utterance
// advances the conversation. Prevents the bot from firing Q1 the instant the greeting
// ends if the customer said something small (like "hello?") just as it finished.
const POST_GREETING_LISTEN_MS      = 600;

// ─────────────────────────────────────────────────────────────────────────
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
        "Hi, thank you for taking the call. This is Matt with healthcare benefits. How are you doing today?";

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
      // FIX v16: Check if this utterance is an echo of the bot's own opening line.
      // Deepgram picks up the outgoing audio and transcribes it. The bot says
      // "Hi, thank you for taking the call..." and Deepgram returns "Hi. Thank you for"
      // as a speech_final — which isStrongInterrupt() evaluates as TRUE (4 words).
      // Detect this by checking if the utterance matches the start of the opening line.
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

    // Absorb "Hello?", "Can you hear me?" etc. until the customer has given real input.
    if (session.openingComplete && !session.hasRealInput && isPostGreetingFiller(utterance)) {
      logger.info(`[${sessionId}] Post-greeting filler absorbed (no LLM): "${utterance}"`);
      return;
    }

    // FIX v17: post-greeting listen window.
    // After the greeting finishes, give the customer POST_GREETING_LISTEN_MS to start
    // speaking before we accept anything as a "real" input. This prevents a fragment
    // that Deepgram finalized right as the greeting ended (e.g. the customer said
    // "hello?" during the last second of the greeting) from immediately firing Q1.
    if (session.openingComplete && session.greetingCompletedAt) {
      const sinceGreeting = Date.now() - session.greetingCompletedAt;
      if (sinceGreeting < POST_GREETING_LISTEN_MS && !session.hasRealInput) {
        logger.info(`[${sessionId}] Post-greeting window — holding ${sinceGreeting}ms < ${POST_GREETING_LISTEN_MS}ms: "${utterance}"`);
        // Re-queue after the window expires rather than silently dropping
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

  // Separated so the post-greeting delay can re-enter here without re-running guards
  _processValidatedUtterance(sessionId, utterance) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    // Tag input type for per-turn state block
    if (session.openingComplete && isSocialResponse(utterance)) {
      session.lastUserInputType = "social";
      logger.info(`[${sessionId}] Social response detected: "${utterance}"`);
    } else {
      session.lastUserInputType = "qualification";
    }

    // Mark that the customer has given real input — post-greeting filler absorption ends here
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

    // FIX: cap queue depth to prevent audio pile-up from rapid barge-in loops
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

        // FIX: bounded wait for Twilio readiness — avoids infinite spin
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

        // FIX v17: after playing an acknowledgment chunk, insert a brief pause before
        // the next chunk if that next chunk contains a question.
        // This gives the customer a moment to register "they heard me" before the
        // next question starts — instead of "oh nice." → [50ms] → "how old are you?"
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
      // FIX: cap audio buffer at ~2s to prevent unbounded memory growth
      // if ElevenLabs streams faster than Twilio consumes
      if (buffer.length + chunk.length > AUDIO_BUFFER_MAX_BYTES) {
        const keep = AUDIO_BUFFER_MAX_BYTES - buffer.length;
        if (keep > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, keep)]);
        // Remaining chunk discarded — barge-in or interruption will stop playback anyway
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

  // ─── SYSTEM PROMPT (state block appended per-turn) ────────────────────
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
    if (session.lastUserInputType === "social") {
      inputInstruction = [
        `INPUT_TYPE=SOCIAL_RESPONSE — Customer gave a warm social reply.`,
        `MANDATORY SENTENCE ORDER:`,
        `  1. Social reply FIRST (e.g. "[laughs softly] oh I am doing well, thanks.")`,
        `  2. Question SECOND (e.g. "And um how old are you?")`,
        `NEVER put the question before the social reply. The social reply MUST be sentence 1.`,
        `FORBIDDEN: Do NOT say "This is Matt". Do NOT say "healthcare benefits". Do NOT re-introduce yourself.`,
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

    if (session.llmAbort) { try { session.llmAbort.abort(); } catch {} }
    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;
    session.activeTurnId += 1;
    const myTurnId = session.activeTurnId;
    const t0 = Date.now();
    let thinkingFillerFired = false;

    // FIX: declare outside try so finally can always clear it
    let thinkingFillerTimer = null;

    try {
      const systemPrompt    = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(
        `[${sessionId}] LLM_START turn=${myTurnId} stage=${session.currentStage}` +
        ` Q=${session.currentQuestionNum} inputType=${session.lastUserInputType}`
        // omit raw userText from log — may contain PII
      );

      let fullText        = "";
      let firstTokenAt    = 0;
      let firstChunkSent  = false;
      let firstTTSPromise = null;
      let firstTTSText    = null;

      // FIX: abortSignal already fired check — avoid creating stream if already aborted
      if (llmController.signal.aborted) return;

      thinkingFillerTimer = setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;

        // FIX v16: never fire filler on social responses — it sounds nonsensical
        // ("mm, let me see." after "how are you?" is jarring and confusing).
        // Only fire during qualification turns where a genuine thinking pause is natural.
        if (s.lastUserInputType === "social") return;

        // Filler words that sound like a natural mid-thought pause,
        // not like the bot is "looking something up".
        // Tied to the current question so the pause feels contextually grounded.
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
          firstChunkSent  = true;
          firstTTSText    = sanitized;
          firstTTSPromise = this.getAudioStream(sessionId, sanitized).catch(() => null);
        } else {
          this.enqueueTTS(sessionId, sanitized);
        }
      });

      chunker.minChunkLength = 15;
      chunker.maxChunkLength = 220;

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
      // FIX: clear timer here too (normal completion path before firstChunk)
      clearTimeout(thinkingFillerTimer);
      thinkingFillerTimer = null;
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
      }

      session.state.retriesCantHear = 0;

    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance error: ${e.message}`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      }
    } finally {
      // FIX: always clear thinking filler timer — prevents ghost enqueueTTS on dead turns
      if (thinkingFillerTimer !== null) {
        clearTimeout(thinkingFillerTimer);
        thinkingFillerTimer = null;
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
    const { q, result, next, field, value } = qc;

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
        logger.info(`[${session.id}] Email captured: [MASKED]`);

      } else if (field === "zip" && /^\d{5}$/.test(cleanValue)) {
        st.zip = cleanValue;
        st.capturedAnswers.zip = cleanValue;
        session.questionsAnswered.zip = cleanValue;
        session.awaitingAnswerFor = null;
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

  // ─── FALLBACK STATE PARSER ────────────────────────────────────────────
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