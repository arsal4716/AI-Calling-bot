// mediaStreamHandler.js
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

// ─────────────────────────── TUNING CONSTANTS ────────────────────────────────

const UTTERANCE_HARD_MAX_MS    = 1800;
const MIN_UTTERANCE_CHARS      = 3;
const MIN_UTTERANCE_WORDS      = 1;
const ECHO_GUARD_MS            = 1200;
const BARGEIN_CONFIRM_MS       = 180;
const MID_SILENCE_CHECK_MS     = 11000;
const MID_SILENCE_HANGUP_MS    = 7000;
const CANT_HEAR_COOLDOWN_MS    = 9000;
const CANT_HEAR_MAX_RETRIES    = 2;
const HISTORY_LIMIT            = 14;
const HISTORY_FOR_MODEL        = 6;
const THINKING_FILLER_MS       = 999999; // effectively disabled
const TRANSFER_DELAY_MS        = 5500;
const TTS_QUEUE_MAX_DEPTH      = 6;
const AUDIO_BUFFER_MAX_BYTES   = 200000;
const TWILIO_READY_WAIT_MAX_MS = 8000;
const ACK_TO_QUESTION_PAUSE_MS = 380;
const POST_GREETING_LISTEN_MS  = 600;
const BACKCHANNEL_FILLER_MS    = 300;
const BACKCHANNEL_FILLERS      = ["mm.", "oh.", "mhm.", "right."];
const BARGEIN_MIN_WORDS        = 3;

// ─────────────────────────── STATIC SYSTEM PROMPT ────────────────────────────

const STATIC_SYSTEM_PROMPT = `You are Candice, a warm and natural-sounding voice agent for Health Subsidy Center. You qualify leads for ACA health subsidies and warm-transfer qualified leads to licensed insurance agents. Sound human, never robotic.

## QC BLOCK — MANDATORY, ALWAYS FIRST IN EVERY RESPONSE
Token limits cut the END of responses — QC block first guarantees state capture.
Format: <QC>{"q":<1|2>,"result":"<pass|fail|skip>","next":<1|2>}</QC>

- pass  = confirmed / qualifies → advance to next question or transfer
- fail  = not interested / disqualified → end call
- skip  = unclear / no real answer → stay on same question

## SCRIPT — EXACTLY 2 QUESTIONS. NOTHING ELSE.

### HOW THE CALL WORKS
The greeting has already been delivered before your first turn. Candice said:
"Hi [name], this is Candice calling from the Health Subsidy Center in your state. We were just calling to ask if you are still interested in the health subsidy program?"

The customer's reply to that greeting IS their Q1 answer.

### Q1 — INTEREST
Customer says YES / sure / yeah / okay / go ahead:
  <QC>{"q":1,"result":"pass","next":2}</QC>
  Immediately ask Q2. No filler, no extra words.

Customer says NO / not interested / stop / remove:
  <QC>{"q":1,"result":"fail","next":1}</QC>
  Rebuttal: "oh uh <break time="300ms"/> yeah, I hear you. I was just calling to check if you qualify - it is completely free and just one quick question. Would you be open to that?"
  They insist → "okay, no problem. You have a great day." [END]
  They soften → ask Q2.

Unclear / no real answer:
  <QC>{"q":1,"result":"skip","next":1}</QC>
  Re-ask: "We were just calling to check if you are still interested in the health subsidy program?"

### Q2 — GOVERNMENT COVERAGE
Ask exactly this, word for word:
"Are you currently on Medicaid, Medicare, or VA benefits?"

Customer says NO (not on any of those):
  <QC>{"q":2,"result":"pass","next":2}</QC>
  Say exactly: "Okay great, let me get you a licensed agent that can assist you with your subsidy."
  [TRANSFER CALL]

Customer says YES (on Medicaid, Medicare, or VA):
  <QC>{"q":2,"result":"fail","next":2}</QC>
  Say exactly: "Thank you for letting me know. Unfortunately this program is not available for people currently on Medicaid, Medicare, or VA benefits. Have a great day."
  [END CALL]

Unclear:
  <QC>{"q":2,"result":"skip","next":2}</QC>
  Re-ask: "okay so - are you currently on Medicaid, Medicare, or VA benefits?"

## RESPONSE FORMAT RULES
- No exclamation marks
- No contractions — use: I am, do not, can not, would not, it is
- No em dash — use hyphen
- Numbers as words
- um / uh → must always be followed by <break time="300ms"/>
- If response ends with "?" — STOP. Nothing after the question mark. No trailing filler.
- Never say "next question" or "moving on"
- Never re-introduce yourself after the greeting
- Keep responses short — 1 to 3 sentences max

## FORBIDDEN WORDS
"I see" / "I understand" / "That makes sense" / "No worries" / "Great" / "Perfect" / "Excellent" / "Amazing"

## OBJECTIONS

### Already insured
"heh heh, yeah a lot of people still qualify for a subsidy even with existing coverage. Worth a quick look?"
Insists → "okay, I appreciate your time. Have a great day." [END]

### Busy
"oh uh <break time="300ms"/> sorry to bother you. I will try calling back another time - thanks, goodbye." [END]

### Cost concerns
"yeah, there is no cost for this call or the review. The licensed agent will explain everything before you decide anything."

### Scam concerns
"heh heh uh <break time="300ms"/> that is a fair question. We are not the government and we are not collecting any payment info. We just connect you with licensed agents who check your eligibility."
Still uncomfortable → "I hear you. We can end the call - you can contact a licensed local agent on your own. Thank you." [END]

### What is the subsidy program
"The health subsidy program is part of the Affordable Care Act - it helps people get low-cost or no-cost health insurance based on their income and household size. Some people qualify for plans with zero dollar premiums."

### Is this government
"oh no, we are not a government agency. We work with licensed insurance agents authorized to help people enroll in ACA health plans and access subsidies."

### How long will this take
"oh it is pretty quick - just one question then I connect you to a licensed agent. Takes about a minute total." [continue to Q2]

### Not the decision-maker
"oh okay, no problem. Maybe I can call back when they are available. You have a good day - thank you." [END]

### DNC request
"Of course, I will make sure we do not contact you again. Thank you. Have a good day." [END]

### Wrong person
"oh sorry about that. I will update our records. Have a good day." [END]

### Abusive language (profanity / insults)
[END IMMEDIATELY — no response at all]

## WHEN CUSTOMER ASKS A QUESTION (digression)
1. Answer in 1 sentence max — be honest and brief.
2. Immediately re-ask the current question at the end.
Example: "oh yeah, this is just to check your eligibility for the subsidy. okay so - are you currently on Medicaid, Medicare, or VA benefits?"

"hold on" / "wait" / "one sec" → "oh sure, take your time." [PAUSE — wait for them]

## SILENCE (no customer speech for 5-6 seconds)
Rotate: "hey, are you still with me?" / "hey, can you hear me okay?" / "hey, I am not able to hear you - are you still there?"
After 2 failed attempts: "I am not able to hear you. I will try calling back another time. Have a good day." [END]

## INTELLIGENCE RULES
- Always understand what the customer said before responding
- Background noise / TV in background / no human voice → wait silently
- Customer filler sounds (uh, um, hmm, mm) → wait, do not respond yet
- Match customer energy
- Wait for customer to finish speaking before responding
- Never repeat the same filler twice in a row`;

// ─────────────────────────── HELPER FUNCTIONS ────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return (str || "")
    .replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

function wordCount(s) {
  const t = (s || "").trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

function isAckOnlyUtterance(text) {
  const raw = String(text || "")
    .replace(/<[^>]+>/g, " ").replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ").trim().toLowerCase();
  if (!raw || raw.includes("?") || raw.split(/\s+/).filter(Boolean).length > 6) return false;
  return /^(?:oh\s+nice|oh\s+yeah|oh\s+okay|oh\s+sure|nice|great|perfect|cool|right|okay|ok|sure|mhm+|mhmm+|mm+|hmm+|uh\s*huh|uh-huh|yeah|yea|yep|yup|alright)(?:\s*[,.;-]\s*(?:oh\s+nice|nice|great|perfect|cool|right|okay|ok|sure|mhm+|mm+|hmm+|yeah|yea|yep|yup|alright))*[.!?]*$/i.test(raw);
}

function isAcknowledgmentChunk(text) {
  const t = (text || "").replace(/\[[^\]]+\]/g, "").replace(/<[^>]+>/g, "").trim();
  if (!t || t.includes("?") || t.split(/\s+/).length > 12) return false;
  return true;
}

function looksLikeQuestionStart(text) {
  const t = String(text || "").replace(/<[^>]+>/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  const s = t.toLowerCase();
  if (/^(?:is|are|was|were|do|does|did|can|could|would|will|have|has|had|may|might|should)\b/.test(s)) return true;
  if (/^(?:what|why|how|when|where|who|which)\b/.test(s)) return true;
  return false;
}

const FILLER_REGEX = /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo|hmm|hm|mmm|mm|mhm|mhmm|uh huh|uh-huh|uhhuh|uh|um|erm|go ahead|please|continue|and|so|well|but|okay go ahead|sure go ahead|go on|keep going|i'm here|im here|still here|i hear you|i got you|gotcha)\.?\s*$/i;

function isFiller(text) { return FILLER_REGEX.test((text || "").trim()); }

const POST_GREETING_FILLER_REGEX = /^(?:hello[?!.]?|hi[?!.]?|hey[?!.]?|can you hear me[?!.]?|are you there[?!.]?|is anyone there[?!.]?|are you still there[?!.]?|can you hear me now[?!.]?|testing[?!.]?|hello[?!.]?\s+hello[?!.]?)$/i;

function isPostGreetingFiller(text) {
  return POST_GREETING_FILLER_REGEX.test((text || "").trim());
}

const SOCIAL_RESPONSE_REGEX = /^(?:(?:(?:hi|hey|hello)[,.]?\s+)?(?:[a-z]+[,.]?\s+)?(?:what about you|how about you|and you|what about yourself)[?!.]?|(?:(?:hi|hey|hello)[,.]?\s+)?(?:i(?:'m| am)\s+)?(?:doing\s+)?(?:good|fine|great|okay|well|not bad|pretty good|alright|doing well|doing good)(?:\s+(?:thanks?|thank you))?[.!?]?(?:[,.]?\s*(?:and\s+)?(?:you|yourself|what about you)[?!.]?)?|(?:good|fine|great|not bad|okay)[,.]?\s+how\s+(?:are\s+you|about\s+you)[?!.]?|how\s+are\s+you[?!.]?)$/i;

function isSocialResponse(text) {
  return SOCIAL_RESPONSE_REGEX.test((text || "").trim());
}

function containsReciprocalQuestion(text) {
  return /(\band you\b|\bwhat about you\b|\bhow about you\b|\bhow are you\b|\bwhat about yourself\b)/i.test(text || "");
}

function buildForcedSocialReply(utterance) {
  return containsReciprocalQuestion(utterance)
    ? "[laughs softly] oh I am doing well, thanks for asking."
    : "[laughs softly] oh nice, glad to hear that.";
}

const DIGRESSION_REGEX = /^(?:why|what|how|who|when|where|can you|could you|do you|are you|is this|what do you mean|i don.?t understand|explain|tell me more|what.?s this about|say that again|repeat that|can you repeat|didn.?t catch|sorry what|sorry could you|huh|pardon|what did you say|hold on|one second|one sec|wait|hang on|i.?m (?:driving|busy|at work|in a meeting|eating|walking)|not a good time|can i ask you something|i have a question|question for you|actually|never mind|forget it|just wondering|curious(?:ly)?)\b/i;

function isDigression(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.endsWith("?") && !FILLER_REGEX.test(t)) return true;
  if (DIGRESSION_REGEX.test(t)) return true;
  return false;
}

function isShortButValidUtterance(u) {
  const t = (u || "").trim();
  if (!t) return false;
  if (FILLER_REGEX.test(t)) return true;
  if (/^\d{1,6}\.?\s*$/.test(t)) return true;
  return false;
}

const INTERRUPT_REGEX = /^(?:stop|wait|hold on|hang on|one sec|one second|listen|excuse me|shut up|pause|cancel|quiet|i have a question|can i ask|let me ask|actually|wait wait)\b/i;

function isStrongInterrupt(text) {
  const t = (text || "").trim();
  if (INTERRUPT_REGEX.test(t)) return true;
  if (wordCount(t) >= BARGEIN_MIN_WORDS && !isFiller(t)) return true;
  return false;
}

function detectToneHint(utterance) {
  const t = (utterance || "").toLowerCase();
  if (!t) return "neutral";
  if (/(hate|stupid|idiot|shut up|fuck|f\*+k|bitch|asshole|scam|lawsuit|angry|mad)/i.test(t)) return "hostile";
  if (/(sad|depressed|cry|sick|pain|hospital|broke|lost my job|unemployed|no money)/i.test(t)) return "negative";
  if (/(good|fine|great|awesome|amazing|happy|doing well|not bad|pretty good|fantastic)/i.test(t)) return "positive";
  return "neutral";
}

function stripLeadingAck(text) {
  let t = (text || "").trim();
  if (!t || /^<QC>/i.test(t)) return t;
  return t.replace(/^(\[[^\]]+\]\s*)?(?:oh\s+nice|oh\s+sure|oh\s+okay|oh\s+yeah|yeah,\s+got\s+it|mhm|mhmm|mm|okay\s+sure|okay|sure|right)\.?\s*/i, "").trim();
}

function stripDisallowedSocial(text) {
  let t = (text || "");
  t = t.replace(/\bI am doing well\b[^.?!]*[.?!]?/gi, "");
  t = t.replace(/\bthanks for asking\b[^.?!]*[.?!]?/gi, "");
  t = t.replace(/\bI am well\b[^.?!]*[.?!]?/gi, "");
  return t.trim();
}

function scrubTrailingFillerAfterQuestion(text) {
  let t = (text || "").trim();
  if (!t) return t;
  const qm = t.lastIndexOf("?");
  if (qm !== -1) {
    const after = t.slice(qm + 1).trim();
    if (!after) return t;
    const tailIsFiller = /^[\)\]\s.,;:-]*?(?:\(?\s*)?(?:oh\s+)?(?:ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|alright|okay|ok|sure|perfect|great|nice|cool|got\s+it|sounds\s+good|will\s+do|noted|understood|I\s+see|I\s+got\s+it|thank\s+you|thanks)(?:\s*[,.]?\s*(?:got\s+it|sounds\s+good|will\s+do|noted|understood|nice|great|good|okay|ok|sure|perfect|right|cool|alright))?(?:[\s,.;:-]+(?:oh\s+)?(?:ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|alright|okay|ok|sure|perfect|great|nice|cool|got\s+it|sounds\s+good|will\s+do|noted|understood)(?:\s*[,.]?\s*(?:nice|great|good|okay|ok|sure|perfect|right|cool|alright|got\s+it))?)*[.!?\)\]]*\s*$/i.test(after);
    if (tailIsFiller) return t.slice(0, qm + 1).trim();
  }
  return t;
}

function scrubTrailingPoliteTail(text) {
  let t = (text || "").trim();
  if (!t) return t;
  const qm = t.lastIndexOf("?");
  if (qm !== -1) {
    const after = t.slice(qm + 1).trim();
    if (after) {
      const tail = /^[\)\]\s.,-]*(?:\(?\s*)?(?:oh\s+)?(?:thanks?|thank\s+you|got\s+it|okay|ok|alright|sure|right|sounds\s+good|will\s+do|noted|understood|I\s+see|mhm+|mm+|uh+|um+|yeah|yep|yup)[^a-z0-9]*$/i.test(after);
      if (tail) return t.slice(0, qm + 1).trim();
    }
  }
  return t.replace(/(?:\s*[,.-]?\s*)(?:\[?[^\]]*\]?\s*)?(?:oh\s+)?(?:thank\s+you|thanks|got\s+it|okay|ok|alright|sure|sounds\s+good|noted|understood)\.?\s*$/i, "").trim();
}

function scrubTrailingEndFillers(text) {
  let t = (text || "").trim();
  if (!t) return t;
  const hasQuestion = t.includes("?");
  t = t.replace(
    hasQuestion
      ? /([?.!])\s*(?:,\s*)?(?:mhm+|mhmm+|mm+|hmm+|uh+|um+|erm+|ah+|oh+|right|okay|ok|sure)\b(?:\s*[?.!])?\s*$/i
      : /([?.!])\s*(?:,\s*)?(?:mhm+|mhmm+|mm+|hmm+|uh+|um+|erm+|ah+|oh+)\b(?:\s*[?.!])?\s*$/i,
    "$1"
  ).trim();
  t = t.replace(/\s*(?:,\s*)?(?:mhm+|mhmm+|mm+|hmm+|uh+|um+|erm+|ah+)\b\s*$/i, "").trim();
  return t.replace(/[\s,]+$/g, "").trim();
}

// ─────────────────────────── DISPOSITION ─────────────────────────────────────

function inferDispositionFromText(text) {
  const s = (text || "").toLowerCase();
  if (/\b(do not call|don't call|dnc|remove me|stop calling)\b/.test(s)) return "DNC";
  if (/\b(not interested|no thanks|stop calling|leave me alone)\b/.test(s)) return "NOT_INTERESTED";
  if (/\b(wrong number|misdial|wrong person)\b/.test(s)) return "MISDIALED";
  if (/\b(voicemail|leave (a )?message|beep)\b/.test(s)) return "VOICEMAIL";
  if (
    /\b(medicaid|medicare|va benefits|va coverage|tricare)\b/.test(s) &&
    /\b(not available|unfortunately|disqualif|enrolled)\b/.test(s)
  ) return "DISQUALIFIED_GOVT_COVERAGE";
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
    if (inferred) {
      status = inferred;
    } else if (endedBy === "ws_error") {
      status = "DISCONNECTED";
    } else if (st.qualified && session.transferAttempted) {
      status = "TRANSFERRED_TO_AGENT";
    } else if (st.govtCoverageChecked === false) {
      status = "DISQUALIFIED_GOVT_COVERAGE";
    } else if (st.interestConfirmed === false) {
      status = "NOT_INTERESTED";
    } else {
      status = "TARGET_HUNG_UP";
    }
  }

  // Normalise any legacy values
  const normalize = {
    TRANSFERRED: "TRANSFERRED_TO_AGENT",
    TRANSFERRED_TO_LICENSED_AGENT: "TRANSFERRED_TO_AGENT",
    NOT_QUALIFIED: "DISQUALIFIED_GOVT_COVERAGE",
    MEDICAID_MEDICARE_VA_DISQUALIFIED: "DISQUALIFIED_GOVT_COVERAGE",
    UNRESPONSIVE: "NO_ANSWER",
  };
  status = normalize[status] || status;

  return {
    status,
    stage: session.currentStage || "unknown",
    qualified: !!st.qualified,
    interestConfirmed: st.interestConfirmed,
    govtCoverageChecked: st.govtCoverageChecked,
    capturedAnswers: st.capturedAnswers || {},
    endedBy: endedBy || "unknown",
    durationMs: Date.now() - (session.startTime || Date.now()),
    transcriptSummary: transcript.slice(0, 400),
  };
}

// ─────────────────────────── MAIN CLASS ──────────────────────────────────────

class MediaStreamHandler {
  constructor(wss) {
    this.wss = wss;
    this.sessions = new Map();

    this.deepgramService   = new DeepgramService();
    this.openaiService     = new OpenAIService();
    this.elevenlabsService = new ElevenLabsService();
    this.campaignService   = new CampaignService();
    this.twilioService     = new TwilioService({
      getActiveSessionCount: () => this.sessions.size,
    });

    logger.info(
      `MediaStreamHandler initialized. Static prompt ~${Math.round(STATIC_SYSTEM_PROMPT.length / 4)} tokens`
    );

    this.setupWebSocket();
    this._cleanupInterval = setInterval(() => this.cleanupInactiveSessions(), 30000);
    this._heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        try { ws.ping(); } catch { }
      });
    }, 30000);
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    clearInterval(this._heartbeatInterval);
  }

  // ─── WEBSOCKET ────────────────────────────────────────────────────────

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const sessionId = req.url.split("/").pop();
      logger.info(`[${sessionId}] WS CONNECTED`);
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));

      this.initializeSession(sessionId, ws).catch((err) =>
        logger.error(`[${sessionId}] Session init failed: ${err.message}`)
      );

      ws.on("message", async (msg) => {
        let data;
        try { data = JSON.parse(msg.toString()); }
        catch (e) { logger.error(`[${sessionId}] Parse error: ${e.message}`); return; }

        switch (data.event) {
          case "start": {
            const session = this.sessions.get(sessionId);
            if (!session) return;
            session.streamSid     = data.start?.streamSid || session.streamSid;
            session.isTwilioReady = true;
            session.twilioStartAt = Date.now();
            session.lastActivity  = Date.now();
            logger.info(`[${sessionId}] Twilio START streamSid=${session.streamSid}`);

            // Start recording (non-blocking)
            const recordCallSid = session.callLog?.callSid;
            if (recordCallSid) {
              Promise.resolve()
                .then(() => this.twilioService.startCallRecording(recordCallSid))
                .then(() => logger.info(`[${sessionId}] Recording started`))
                .catch((e) => logger.warn(`[${sessionId}] Recording failed: ${e.message}`));
            }

            this.armStartSilence(sessionId);
            this.maybePlayInitialGreeting(sessionId).catch(() => { });
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
        logger.info(`[${sessionId}] WS closed`);
        this.cleanupSession(sessionId, { endedBy: "ws_close" });
      });
      ws.on("error", (err) => {
        logger.error(`[${sessionId}] WS error: ${err.message}`);
        this.cleanupSession(sessionId, { endedBy: "ws_error" });
      });
    });
  }

  // ─── SESSION ─────────────────────────────────────────────────────────

  createEmptySession(sessionId, ws) {
    return {
      id: sessionId,
      ws,
      callLog: null,
      campaign: null,
      openingLine: null,
      agentName: "Candice",
      firstName: "",
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
      hasRealInput: false,
      _pendingQuestion: false,
      _lastUtterance: "",
      _prewarmedGreetingStream: null,
      greetingCompletedAt: 0,
      initialGreetingSent: false,
      lastClearAt: 0,
      activeTurnId: 0,
      lastProcessedAt: 0,
      lastAiAudioSentAt: 0,
      lastAckTurn: 0,
      transferAttempted: false,
      timers: { startSpeak: null, startHangup: null, midCheck: null, midHangup: null },
      startSilenceFlowArmed: false,
      currentStage: "greeting",
      openingComplete: false,
      currentQuestionNum: 1,
      lastUserInputType: "unknown",
      pausedQuestionNum: null,
      digressionCount: 0,
      turnRules: {
        forcedPrefix: null,
        disallowAck: false,
        disallowSocial: false,
        disableBackchannel: false,
      },
      state: {
        qualified: false,
        interestConfirmed: null,   // null=pending, true=yes, false=no
        govtCoverageChecked: null, // null=pending, true=no-govt(qualifies), false=has-govt(disqualified)
        retriesCantHear: 0,
        lastCantHearAt: 0,
        capturedAnswers: {},
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
    if (!callLog) {
      logger.error(`[${sessionId}] CallLog not found`);
      return;
    }
    const answeredBy = String(
      callLog.answeredBy || callLog.amd || callLog.AMD || ""
    ).toLowerCase().trim();

    if (answeredBy && answeredBy !== "human") {
      const isMachine =
        answeredBy.includes("machine") ||
        answeredBy.includes("fax") ||
        answeredBy.includes("voicemail") ||
        answeredBy.includes("beep") ||
        answeredBy === "unknown";

      if (isMachine) {
        const disposition = (answeredBy.includes("voicemail") || answeredBy.includes("beep"))
          ? "VOICEMAIL" : "ANSWERING_MACHINE";
        callLog.disposition = disposition;
        callLog.endTime = new Date();
        callLog.status = "completed";
        try { await callLog.save(); } catch (e) {
          logger.error(`[${sessionId}] AMD save error: ${e.message}`);
        }
        logger.info(`[${sessionId}] AMD guard → ${disposition}. Closing.`);
        try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { }
        return;
      }
    }

    const data = await this.campaignService.getCampaignWithPrompt(callLog.campaign._id);
    if (!data) { logger.error(`[${sessionId}] Campaign not found`); return; }

    const { campaign, openingLine, agentName } = data;
    const existing = this.sessions.get(sessionId);
    const session  = existing || this.createEmptySession(sessionId, ws);

    session.ws         = ws;
    session.callLog    = callLog;
    session.campaign   = campaign;
    session.openingLine = openingLine;
    session.agentName  = agentName || "Candice";
    session.direction  = String(callLog.direction || callLog.Direction || "").toLowerCase().trim();
    session.firstName  = String(
      callLog.firstName ||
      callLog.contact?.firstName || callLog.contact?.first_name ||
      callLog.lead?.firstName || ""
    ).trim();

    this.sessions.set(sessionId, session);

    const greetingText = this._buildGreetingText(session);
    if (greetingText && campaign?.voiceId) {
      session._prewarmedGreetingStream = this.elevenlabsService
        .streamTextToSpeechFast(greetingText, campaign.voiceId, campaign.voiceSettings || {})
        .catch(() => null);
      logger.info(`[${sessionId}] Pre-warming greeting TTS`);
    }

    // ── DEEPGRAM ── set up in parallel with the pre-warm ────────────────────
    await this.deepgramService.createTranscriptionStream(sessionId, {
      onOpen: () => {
        const s = this.sessions.get(sessionId);
        if (s) s.dgOpenAt = Date.now();
      },
      onSpeechStarted: () => this.onUserSpeechStarted(sessionId),
      onTranscript: ({ text, isFinal, speechFinal }) =>
        this.onDeepgramTranscript(sessionId, text, isFinal, speechFinal),
    });

    logger.info(`[${sessionId}] Session ready`);
    // Attempt greeting immediately in case Twilio "start" already fired
    this.maybePlayInitialGreeting(sessionId).catch(() => { });
  }

  // Build the exact greeting text for Candice (used in both pre-warm and playback)
  _buildGreetingText(session) {
    const DEFAULT =
      `Hi${session.firstName ? ` ${session.firstName}` : ""}, this is Candice calling from the Health Subsidy Center in your state. ` +
      `We were just calling to ask if you are still interested in the health subsidy program?`;

    if (session.openingLine) {
      const rendered = safeTTS(renderTemplate(session.openingLine, {
        agentname: session.agentName,
        first_name: session.firstName || "",
      }));
      return rendered || safeTTS(DEFAULT);
    }
    return safeTTS(DEFAULT);
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
    if (!session || session.initialGreetingSent) return;
    if (!session.campaign || !session.openingLine) return;
    if (!session.isTwilioReady || !session.streamSid) return;

    const greetingText = this._buildGreetingText(session);
    if (!greetingText) return;

    session.initialGreetingSent = true;
    session.currentStage = "greeting";
    session.openingComplete = false;
    session.conversationHistory.push({ role: "assistant", content: greetingText });
    session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
    session.aiChunks.push(greetingText);
    logger.info(`[${sessionId}] Playing greeting`);

    const onGreetingComplete = () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.openingComplete     = true;
      s.currentStage        = "qualification";
      s.currentQuestionNum  = 1;
      s.greetingCompletedAt = Date.now();
      logger.info(`[${sessionId}] Greeting done → Q1`);
      this.armMidCallSilence(sessionId);
    };

    // Use pre-warmed ElevenLabs stream (zero extra latency on first word)
    const prewarmed = session._prewarmedGreetingStream || null;
    session._prewarmedGreetingStream = null;

    if (prewarmed) {
      prewarmed.then((stream) => {
        const s = this.sessions.get(sessionId);
        if (!s || s.isClosing || s.isCleaning) { onGreetingComplete(); return; }
        if (stream) {
          s.ttsQueue.unshift({ text: greetingText, _preloadedStream: stream, onComplete: onGreetingComplete });
          this.runTTSQueue(sessionId).catch(() => { });
        } else {
          this.enqueueTTS(sessionId, greetingText, { flush: true, onComplete: onGreetingComplete });
        }
      }).catch(() => {
        this.enqueueTTS(sessionId, greetingText, { flush: true, onComplete: onGreetingComplete });
      });
    } else {
      this.enqueueTTS(sessionId, greetingText, { flush: true, onComplete: onGreetingComplete });
    }
  }

  // ─── START-SILENCE FALLBACK ────────────────────────────────────────────

  armStartSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.startSilenceFlowArmed) return;
    session.startSilenceFlowArmed = true;

    this._setTimer(sessionId, "startSpeak", 1800, async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.hasUserSpoken || s.initialGreetingSent || s.isSpeaking) return;

      const fallback = this._buildGreetingText(s);
      if (!fallback) return;

      s.initialGreetingSent = true;
      s.currentStage = "greeting";
      s.openingComplete = false;
      s.aiChunks.push(fallback);

      const fallbackOnComplete = () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        ss.openingComplete     = true;
        ss.currentStage        = "qualification";
        ss.currentQuestionNum  = 1;
        ss.greetingCompletedAt = Date.now();
        logger.info(`[${sessionId}] Fallback greeting done → Q1`);
        this.armMidCallSilence(sessionId);
      };

      const prewarmed = s._prewarmedGreetingStream || null;
      s._prewarmedGreetingStream = null;
      if (prewarmed) {
        prewarmed.then((stream) => {
          const sf = this.sessions.get(sessionId);
          if (!sf || sf.isClosing || sf.isCleaning) { fallbackOnComplete(); return; }
          if (stream) {
            sf.ttsQueue.unshift({ text: fallback, _preloadedStream: stream, onComplete: fallbackOnComplete });
            this.runTTSQueue(sessionId).catch(() => { });
          } else {
            this.enqueueTTS(sessionId, fallback, { flush: true, onComplete: fallbackOnComplete });
          }
        }).catch(() => {
          this.enqueueTTS(sessionId, fallback, { flush: true, onComplete: fallbackOnComplete });
        });
      } else {
        this.enqueueTTS(sessionId, fallback, { flush: true, onComplete: fallbackOnComplete });
      }

      this._setTimer(sessionId, "startHangup", 12000, async () => {
        const ss = this.sessions.get(sessionId);
        if (!ss || ss.hasUserSpoken) return;
        const dgAge = ss.dgOpenAt ? Date.now() - ss.dgOpenAt : 0;
        if (!ss.dgOpenAt || dgAge < 1500) {
          this._setTimer(sessionId, "startHangup", 5000, async () => {
            const sss = this.sessions.get(sessionId);
            if (!sss || sss.hasUserSpoken) return;
            if (sss.callLog && !sss.callLog.disposition) sss.callLog.disposition = "NO_ANSWER";
            await this.politeHangup(sessionId, { finalMessage: "Sorry, I can not hear you. Goodbye." });
          });
          return;
        }
        if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "NO_ANSWER";
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
    us.utteranceId += 1;
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
        if (ss.userSpeech.pendingBargeIn && (ss.userSpeech.buffer || "").trim().length < 3) {
          ss.userSpeech.pendingBargeIn = false;
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
      } else if (isStrongInterrupt(trimmed)) {
        logger.info(`[${sessionId}] BARGE-IN`);
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

    if (us.finalizeTimer)      { clearTimeout(us.finalizeTimer);      us.finalizeTimer      = null; }
    if (us.hardMaxTimer)       { clearTimeout(us.hardMaxTimer);        us.hardMaxTimer       = null; }
    if (us.bargeInConfirmTimer){ clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }
    us.pendingBargeIn = false;

    const utterance = (us.buffer || "").trim();
    us.isSpeaking = false;
    us.buffer     = "";
    if (!utterance) return;

    const shortValid = isShortButValidUtterance(utterance);
    if (!shortValid) {
      if (utterance.length < MIN_UTTERANCE_CHARS && wordCount(utterance) < MIN_UTTERANCE_WORDS) {
        logger.info(`[${sessionId}] Drop tiny (${reason}): "${utterance}"`); return;
      }
      if (/^(?:a|h)\.?$/i.test(utterance)) {
        logger.info(`[${sessionId}] Drop noise (${reason}): "${utterance}"`); return;
      }
    }

    logger.info(`[${sessionId}] Finalized (${reason}): "${utterance}"`);
    session.lastProcessedAt = Date.now();
    session.transcriptChunks.push(utterance);
    if (session.transcriptChunks.length > 80) session.transcriptChunks.shift();

    // Suppress echo of our own opening line
    if (!session.openingComplete) {
      const openingNorm = (session.openingLine || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      const utterNorm   = utterance.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      if (openingNorm && utterNorm.length >= 4) {
        const firstWords = openingNorm.split(/\s+/).slice(0, 6).join(" ");
        if (openingNorm.startsWith(utterNorm) || firstWords.startsWith(utterNorm.split(/\s+/).slice(0, 4).join(" "))) {
          logger.info(`[${sessionId}] Echo suppressed: "${utterance}"`); return;
        }
      }
      if (isStrongInterrupt(utterance) && !isFiller(utterance)) {
        logger.info(`[${sessionId}] Strong interrupt during greeting — processing`);
      } else {
        logger.info(`[${sessionId}] Greeting in progress — buffering: "${utterance}"`); return;
      }
    }

    if (session.openingComplete && !session.hasRealInput && isPostGreetingFiller(utterance)) {
      logger.info(`[${sessionId}] Post-greeting filler absorbed: "${utterance}"`); return;
    }

    // Small hold after greeting to collect full first response
    if (session.openingComplete && session.greetingCompletedAt) {
      const sinceGreeting = Date.now() - session.greetingCompletedAt;
      if (sinceGreeting < POST_GREETING_LISTEN_MS && !session.hasRealInput) {
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

    // Classify the turn type to inject the right instruction into the prompt
    session.turnRules.forcedPrefix      = null;
    session.turnRules.disallowAck       = false;
    session.turnRules.disallowSocial    = false;
    session.turnRules.disableBackchannel = false;

    const toneHint = detectToneHint(utterance);

    if (session.openingComplete && (isSocialResponse(utterance) || containsReciprocalQuestion(utterance))) {
      session.lastUserInputType = "social";
      session.turnRules.forcedPrefix      = buildForcedSocialReply(utterance);
      session.turnRules.disallowAck       = true;
      session.turnRules.disallowSocial    = true;
      session.turnRules.disableBackchannel = true;
    } else if (session.openingComplete && isDigression(utterance)) {
      session.lastUserInputType = "digression";
      session.turnRules.disallowAck = true;
      if (session.pausedQuestionNum === null) {
        session.pausedQuestionNum = session.currentQuestionNum;
        session.digressionCount += 1;
      }
    } else {
      session.lastUserInputType = "qualification";
      const longAnswer    = wordCount(utterance) >= 8;
      const emotional     = toneHint === "positive" || toneHint === "negative" || toneHint === "hostile";
      const turnsSinceAck = session.activeTurnId - session.lastAckTurn;
      session.turnRules.disallowAck = !(turnsSinceAck >= 3 && (longAnswer || emotional));
      if (session.pausedQuestionNum !== null) {
        logger.info(`[${sessionId}] Digression resolved → Q${session.currentQuestionNum}`);
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
    if (!session || session.isClosing || session.isCleaning) { if (onComplete) onComplete(); return; }
    const t = safeTTS(text);
    if (!t) { if (onComplete) onComplete(); return; }
    if (flush) session.ttsQueue.length = 0;
    if (session.ttsQueue.length >= TTS_QUEUE_MAX_DEPTH) {
      logger.warn(`[${sessionId}] TTS queue full — dropping`);
      if (onComplete) onComplete(); return;
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

        const textToSpeak    = typeof item === "string" ? item : item.text;
        const onComplete     = typeof item === "string" ? null : item.onComplete;
        const preloadedStream = item._preloadedStream || null;

        if (!textToSpeak) { if (onComplete) onComplete(); continue; }

        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          const waitStart = Date.now();
          while (!s.isTwilioReady || !s.streamSid || !s.ws) {
            if (Date.now() - waitStart > TWILIO_READY_WAIT_MAX_MS) {
              if (onComplete) onComplete(); break;
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

        // Small pause between ack and question for natural rhythm
        {
          const ss = this.sessions.get(sessionId);
          if (ss && !ss.isClosing && !ss.isCleaning && ss.ttsQueue.length > 0) {
            const next = ss.ttsQueue[0];
            const nextText = typeof next === "string" ? next : (next?.text || "");
            if (isAcknowledgmentChunk(textToSpeak) && (nextText || "").includes("?")) {
              await sleep(ACK_TO_QUESTION_PAUSE_MS);
            }
          }
        }

        if (onComplete) { try { onComplete(); } catch { } }
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
      logger.info(`[${sessionId}] TTS latency=${Date.now() - t0}ms`);
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
    session.ttsAbort   = ac;
    session.isSpeaking = true;
    session.lastAiSpokeAt = Date.now();

    const FRAME_BYTES = 160;
    const FRAME_MS    = 20;
    let buffer = Buffer.alloc(0);
    let ended  = false;
    let frameCount = 0;

    const onData  = (chunk) => {
      if (!chunk?.length) return;
      if (buffer.length + chunk.length > AUDIO_BUFFER_MAX_BYTES) {
        const keep = AUDIO_BUFFER_MAX_BYTES - buffer.length;
        if (keep > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, keep)]);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
    };
    const onEnd   = () => { ended = true; };
    const onError = () => { ended = true; };

    audioStream.on("data", onData);
    audioStream.on("end",  onEnd);
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
          } catch { }
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
        audioStream.off("data", onData);
        audioStream.off("end", onEnd);
        audioStream.off("error", onError);
      } catch { }
      try { audioStream.destroy(); } catch { }
      buffer = Buffer.alloc(0);
      session.isSpeaking = false;
      session.ttsAbort   = null;
      logger.info(`[${sessionId}] TTS done frames=${frameCount}`);
    }
  }

  // ─── PROMPT BUILDING ──────────────────────────────────────────────────
  //
  // _buildSystemPrompt = STATIC_SYSTEM_PROMPT + small dynamic state block.
  // Static prompt: never changes. Dynamic state: ~60 tokens per turn.
  // Zero duplication between the two.

  _buildSystemPrompt(session) {
    return STATIC_SYSTEM_PROMPT + "\n" + this._buildRuntimeState(session);
  }

  _buildRuntimeState(session) {
    const st = session.state || {};

    const q1 = st.interestConfirmed === null   ? "pending"
             : st.interestConfirmed === true    ? "pass"
             :                                    "fail";
    const q2 = st.govtCoverageChecked === null  ? "pending"
             : st.govtCoverageChecked === true   ? "pass(no-govt)"
             :                                     "fail(has-govt)";

    // Turn-specific instruction — only present when needed
    let turnInstruction = "";
    if (session.lastUserInputType === "social") {
      if (session.turnRules?.forcedPrefix) {
        turnInstruction =
          `TURN=SOCIAL | Social reply already spoken. Output ONLY: QC block + Q${session.currentQuestionNum}. No ack, no social line.`;
      } else {
        turnInstruction =
          `TURN=SOCIAL | First: warm reaction (1 sentence). Second: Q${session.currentQuestionNum}. Question goes LAST.`;
      }
    } else if (session.lastUserInputType === "digression") {
      const q = session.pausedQuestionNum || session.currentQuestionNum;
      turnInstruction =
        `TURN=DIGRESSION | QC skip q=${q} next=${q}. Answer their question (1 sentence). Re-ask Q${q} at the end. Never advance.`;
    }

    const greetingLine = session.openingComplete
      ? `GREETING_COMPLETE=true | Mid-call. Never re-introduce yourself.`
      : `GREETING_IN_PROGRESS`;

    const wrapupLine = session.currentStage === "wrapup"
      ? `WRAPUP | Transfer in progress. No questions. If they speak: "You will be connected shortly."`
      : "";

    return [
      `\n---`,
      `## LIVE CALL STATE`,
      greetingLine,
      wrapupLine,
      turnInstruction,
      `stage=${session.currentStage} next=Q${session.currentQuestionNum} Q1=${q1} Q2=${q2}`,
      `ack_allowed=${!session.turnRules?.disallowAck}`,
      `RULE: QC block FIRST. Stop after "?". Nothing after the question mark.`,
      `---`,
    ].filter(Boolean).join("\n");
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

    if (session.llmAbort) { try { session.llmAbort.abort(); } catch { } }
    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;
    session.activeTurnId += 1;
    const myTurnId = session.activeTurnId;
    session._lastUtterance = userText;
    const t0 = Date.now();
    let thinkingFillerFired = false;
    let thinkingFillerTimer = null;
    let backchannelTimer    = null;

    try {
      const systemPrompt    = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(
        `[${sessionId}] LLM_START turn=${myTurnId} stage=${session.currentStage}` +
        ` Q=${session.currentQuestionNum} type=${session.lastUserInputType}`
      );

      session._pendingQuestion = false;

      // Forced social prefix (spoken immediately, before LLM)
      if (session.turnRules?.forcedPrefix) {
        const prefix = safeTTS(session.turnRules.forcedPrefix);
        if (prefix) {
          session.lastAckTurn = myTurnId;
          this.enqueueTTS(sessionId, prefix);
        }
      }

      let fullText          = "";
      let firstTokenAt      = 0;
      let firstChunkSent    = false;
      let lastQuestionChunk = null;

      // Backchannel filler if LLM is slow on social turn
      const isSocialTurn = session.lastUserInputType === "social" && !session.turnRules?.disableBackchannel;
      if (isSocialTurn) {
        backchannelTimer = setTimeout(() => {
          const s = this.sessions.get(sessionId);
          if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
          this.enqueueTTS(sessionId, BACKCHANNEL_FILLERS[myTurnId % BACKCHANNEL_FILLERS.length]);
        }, BACKCHANNEL_FILLER_MS);
      }

      // Thinking filler (threshold is very high — effectively off)
      thinkingFillerTimer = setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
        if (s.lastUserInputType === "social") return;
        thinkingFillerFired = true;
        this.enqueueTTS(sessionId, ["mhm.", "right."][myTurnId % 2]);
      }, THINKING_FILLER_MS);

      // Sentence chunker — starts TTS on first sentence immediately
      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || llmController.signal.aborted) return;

        let san = safeTTS(sentence);
        if (!san) return;

        if (s._pendingQuestion && isAckOnlyUtterance(san)) return;
        if (s.turnRules?.disallowSocial) san = stripDisallowedSocial(san);
        if (s.turnRules?.disallowAck)    san = stripLeadingAck(san);

        san = scrubTrailingFillerAfterQuestion(san);
        san = scrubTrailingPoliteTail(san);
        san = scrubTrailingEndFillers(san);
        if (!san) return;

        if (san.includes("?")) s._pendingQuestion = false;
        else if (looksLikeQuestionStart(san)) s._pendingQuestion = true;
        else if (!isAckOnlyUtterance(san)) s._pendingQuestion = false;

        if (san.replace(/\[[^\]]+\]/g, "").trim().length < 3 && san.length < 20) return;

        // Suppress duplicate question in same LLM turn
        if (san.includes("?")) {
          const qNorm = san.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
          if (lastQuestionChunk) {
            const prevNorm  = lastQuestionChunk.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
            const qWords    = qNorm.split(" ").filter(w => w.length > 3);
            const prevWords = new Set(prevNorm.split(" ").filter(w => w.length > 3));
            const overlap   = qWords.filter(w => prevWords.has(w)).length;
            if (Math.max(qWords.length, prevWords.size) > 0 &&
                overlap / Math.max(qWords.length, prevWords.size) >= 0.6) {
              logger.info(`[${sessionId}] Duplicate question suppressed turn=${myTurnId}`);
              return;
            }
          }
          lastQuestionChunk = san;
        }

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}`);

        if (!firstChunkSent) {
          // LATENCY KEY: start ElevenLabs immediately on first sentence — no wait
          clearTimeout(thinkingFillerTimer);
          clearTimeout(backchannelTimer);
          backchannelTimer = null;
          firstChunkSent = true;
          const capturedText   = san;
          const capturedTurnId = myTurnId;
          const fillerFired    = thinkingFillerFired;

          this.getAudioStream(sessionId, capturedText).then((resolvedStream) => {
            if (!resolvedStream) {
              const sf = this.sessions.get(sessionId);
              if (sf && !sf.isClosing && sf.activeTurnId === capturedTurnId)
                this.enqueueTTS(sessionId, capturedText);
              return;
            }
            const sf = this.sessions.get(sessionId);
            if (!sf || sf.isClosing || sf.isCleaning || sf.activeTurnId !== capturedTurnId) return;
            if (fillerFired) {
              sf.ttsQueue.push({ text: capturedText, _preloadedStream: resolvedStream });
            } else {
              sf.ttsQueue.unshift({ text: capturedText, _preloadedStream: resolvedStream });
            }
            this.runTTSQueue(sessionId).catch(() => { });
          }).catch(() => {
            const sf = this.sessions.get(sessionId);
            if (sf && !sf.isClosing && sf.activeTurnId === capturedTurnId)
              this.enqueueTTS(sessionId, capturedText);
          });
        } else {
          this.enqueueTTS(sessionId, san);
        }
      });

      chunker.minChunkLength = 10;
      chunker.maxChunkLength = 400;

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

      clearTimeout(thinkingFillerTimer);
      clearTimeout(backchannelTimer);
      thinkingFillerTimer = null;
      backchannelTimer    = null;
      chunker.end();

      logger.info(`[${sessionId}] LLM_COMPLETE turn=${myTurnId} total=${Date.now() - t0}ms`);

      const aiTextClean = sanitizeForTTS(fullText);
      if (aiTextClean) {
        if (/^(?:\s*(?:oh\s+nice|mhm|mhmm|mm|okay\s+sure|okay,?\s+sure|okay|sure|right)\b)/i.test(aiTextClean.trim()))
          session.lastAckTurn = myTurnId;
      }

      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiTextClean) session.conversationHistory.push({ role: "assistant", content: aiTextClean });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

        this._parseAndUpdateQualificationState(session, userText, fullText);
        this._maybeAdvanceStage(session, fullText);

        if (session.currentStage === "wrapup" && session.state.qualified && !session.transferAttempted) {
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
      if (thinkingFillerTimer) { clearTimeout(thinkingFillerTimer); thinkingFillerTimer = null; }
      if (backchannelTimer)    { clearTimeout(backchannelTimer);    backchannelTimer    = null; }
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        if (s.activeTurnId === myTurnId) s.llmAbort = null;
      }
    }
  }

  // ─── QUALIFICATION STATE ──────────────────────────────────────────────

  _parseAndUpdateQualificationState(session, userText, rawLLMText) {
    const qcMatch = (rawLLMText || "").match(/<QC>([\s\S]*?)<\/QC>/i);
    if (!qcMatch) {
      logger.warn(`[${session.id}] No QC block — using fallback`);
      this._fallbackParseFromAiText(session, userText, rawLLMText);
      return;
    }

    let qc;
    try { qc = JSON.parse(qcMatch[1].trim()); }
    catch (e) {
      logger.warn(`[${session.id}] QC parse error: ${e.message}`);
      this._fallbackParseFromAiText(session, userText, rawLLMText);
      return;
    }

    const st = session.state;
    const { q, result, next } = qc;
    logger.info(`[${session.id}] QC q=${q} result=${result} next=${next}`);

    if (result === "skip") {
      if (typeof next === "number" && next > 0) session.currentQuestionNum = next;
      return;
    }

    if (result === "fail") {
      if (q === 1) {
        st.interestConfirmed = false;
        if (session.callLog) session.callLog.disposition = "NOT_INTERESTED";
      } else if (q === 2) {
        st.govtCoverageChecked = false; // has govt coverage → disqualified
        if (session.callLog) session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
      }
      return;
    }

    if (result === "pass") {
      if (q === 1) {
        st.interestConfirmed = true;
        logger.info(`[${session.id}] Q1 pass → interest confirmed`);
      } else if (q === 2) {
        st.govtCoverageChecked = true; // no govt coverage → qualifies
        st.qualified = true;
        session.currentStage = "wrapup";
        logger.info(`[${session.id}] Q2 pass → QUALIFIED`);
      }
      if (typeof next === "number" && next > 0) session.currentQuestionNum = next;
    }
  }

  _fallbackParseFromAiText(session, userText, aiText) {
    const lower = (aiText || "").toLowerCase();
    const uText = (userText || "").toLowerCase();
    const st    = session.state;
    const q     = session.currentQuestionNum;

    if (q === 1 && st.interestConfirmed === null) {
      const interested    = /yes|yeah|sure|absolutely|interested|go ahead|okay|open/i.test(uText);
      const notInterested = /no|not interested|do not|don.t|remove|stop|leave me/i.test(uText);
      if (interested && /medicaid|medicare|va|one quick question/i.test(lower)) {
        st.interestConfirmed = true;
        session.currentQuestionNum = 2;
        logger.info(`[${session.id}] FALLBACK Q1 pass`);
      } else if (notInterested && /no problem|good day|goodbye/i.test(lower)) {
        st.interestConfirmed = false;
        if (session.callLog) session.callLog.disposition = "NOT_INTERESTED";
        logger.info(`[${session.id}] FALLBACK Q1 fail`);
      }
    }

    if (q === 2 && st.govtCoverageChecked === null) {
      if (/let me get you a licensed agent|assist you with your subsidy/i.test(lower)) {
        st.govtCoverageChecked = true;
        st.qualified = true;
        session.currentStage = "wrapup";
        logger.info(`[${session.id}] FALLBACK Q2 pass → QUALIFIED`);
      } else if (/unfortunately this program|not available.*(?:medicaid|medicare|va)/i.test(lower)) {
        st.govtCoverageChecked = false;
        if (session.callLog) session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
        logger.info(`[${session.id}] FALLBACK Q2 fail → DISQUALIFIED`);
      }
    }
  }

  // ─── STAGE ADVANCEMENT ────────────────────────────────────────────────

  _maybeAdvanceStage(session, rawLLMText) {
    if (session.currentStage !== "qualification") return;
    if (/let me get you a licensed agent|assist you with your subsidy/i.test((rawLLMText || "").toLowerCase())) {
      session.state.qualified = true;
      session.currentStage = "wrapup";
      logger.info(`[${session.id}] Stage → wrapup`);
    }
  }

  // ─── TRANSFER ─────────────────────────────────────────────────────────

  async _maybeTransferCall(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.transferAttempted || !session.state?.qualified) return;

    const callSid  = session.callLog?.callSid;
    const buyerDid = String(session.campaign?.transferSettings?.number || "").trim();

    if (!callSid || !buyerDid) {
      logger.warn(`[${sessionId}] Transfer skipped — missing callSid or buyerDid`);
      return;
    }

    session.transferAttempted = true;
    session.currentStage = "wrapup";
    if (session.callLog) session.callLog.disposition = "TRANSFERRED_TO_AGENT";

    logger.info(`[${sessionId}] TRANSFER → buyerDid=[MASKED]`);
    try {
      await this.twilioService.transferCall(callSid, buyerDid);
      logger.info(`[${sessionId}] Transfer successful`);
    } catch (e) {
      logger.error(`[${sessionId}] Transfer failed: ${e.message}`);
      if (session.callLog) session.callLog.disposition = "TECH_ISSUES";
    }
  }

  // ─── SILENCE MONITORING ───────────────────────────────────────────────

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
      const sinceInterim = s.userSpeech?.lastInterimTime ? Date.now() - s.userSpeech.lastInterimTime : 999999;
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
    const sinceInterim = session.userSpeech?.lastInterimTime ? now - session.userSpeech.lastInterimTime : 999999;

    if (sinceSpeech > 8000 && sinceInterim > 8000) {
      if (st.lastCantHearAt && now - st.lastCantHearAt < CANT_HEAR_COOLDOWN_MS) {
        this.enqueueTTS(sessionId, "hey, are you still with me?", { flush: true });
      } else {
        st.retriesCantHear = (st.retriesCantHear || 0) + 1;
        st.lastCantHearAt  = now;
        if (st.retriesCantHear <= CANT_HEAR_MAX_RETRIES) {
          const phrases = [
            "hey, are you still with me?",
            "hey, can you hear me okay?",
            "hey, I am not able to hear you - are you still there?",
          ];
          this.enqueueTTS(sessionId, phrases[(st.retriesCantHear - 1) % phrases.length], { flush: true });
        } else {
          if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "NO_ANSWER";
          await this.politeHangup(sessionId, {
            finalMessage: "I am not able to hear you. I will try calling back another time. Have a good day.",
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
      const now2         = Date.now();
      const sinceSpeech2 = now2 - (ss.lastSpeechAt || 0);
      const sinceInterim2 = ss.userSpeech?.lastInterimTime ? now2 - ss.userSpeech.lastInterimTime : 999999;
      if (sinceSpeech2 < 3500 || sinceInterim2 < 3500 || ss.isSpeaking || ss.isProcessingUtterance) return;
      if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "NO_ANSWER";
      await this.politeHangup(sessionId, {
        finalMessage: "I am not able to hear you. I will try calling back another time. Have a good day.",
      });
    });
  }

  // ─── STOP + CLEAR ─────────────────────────────────────────────────────

  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttsAbort) { try { session.ttsAbort.abort(); } catch { } session.ttsAbort = null; }
    if (session.llmAbort) { try { session.llmAbort.abort(); } catch { } session.llmAbort = null; }
    session.isSpeaking = false;
    session.ttsQueue.length = 0;
    const us = session.userSpeech;
    if (us?.finalizeTimer)     { clearTimeout(us.finalizeTimer);     us.finalizeTimer     = null; }
    if (us?.hardMaxTimer)      { clearTimeout(us.hardMaxTimer);       us.hardMaxTimer      = null; }
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
    } catch (e) {
      logger.error(`[${sessionId}] clear failed: ${e.message}`);
    }
  }

  async _waitForTTSIdle(sessionId, timeoutMs = 9000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = this.sessions.get(sessionId);
      if (!s || (!s.isSpeaking && !s.ttsQueueRunning && s.ttsQueue.length === 0)) return;
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
    session.isClosing = true;
    session.currentStage = "wrapup";
    this._clearAllTimers(session);
    try {
      if (finalMessage) {
        this.enqueueTTS(sessionId, finalMessage, { flush: true });
        await this._waitForTTSIdle(sessionId, 9000);
      }
    } catch { }
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

    try { this._clearAllTimers(session); this.stopTTS(sessionId); } catch { }
    try { this.deepgramService.closeTranscriptionStream(sessionId); } catch { }

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
        logger.info(`[${sessionId}] Saved disposition=${dispositionObj.status}`);
      }
    } catch (e) {
      logger.error(`[${sessionId}] callLog save failed: ${e.message}`);
    }

    try { if (session.ws?.readyState === WebSocket.OPEN) session.ws.close(); } catch { }
    this.sessions.delete(sessionId);
    logger.info(`Session cleaned: ${sessionId}`);
  }

  cleanupInactiveSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > 300000) {
        logger.warn(`Cleaning inactive: ${sessionId}`);
        if (session.callLog && !session.callLog.disposition)
          session.callLog.disposition = "NO_ANSWER";
        this.cleanupSession(sessionId, { endedBy: "inactive_cleanup" });
      }
    }
  }
}

module.exports = MediaStreamHandler;