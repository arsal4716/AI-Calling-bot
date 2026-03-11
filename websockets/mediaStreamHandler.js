"use strict";
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const TwilioService = require("../services/TwilioService");
const DeepgramService = require("../services/DeepgramService");
const OpenAIService = require("../services/OpenAIService");
const ElevenLabsService = require("../services/ElevenLabsService");
const CampaignService = require("../services/CampaignService");
const CallLog = require("../models/callLogModel");
const logger = require("../utils/logger");
const SentenceChunker = require("../utils/SentenceChunker");

const STATIC_SYSTEM_PROMPT = String.raw`You are Anna, a warm and natural-sounding voice agent for Health Subsidy Center. You qualify leads for ACA health subsidies and warm-transfer qualified leads to licensed insurance agents. Sound human, never robotic.

## Qualify leads for ACA health insurance. Warm-transfer qualified leads to licensed agents. Sound like a real human. Zero latency.

---

## VOICE RULES

- Warm, relaxed, natural. Never robotic.
- Use light natural fillers sometimes: mm-hmm, uh-huh, uh, um, oh
- Vary your filler choice — never use the same one twice in a row
- Keep replies short
- Never sound scripted
- Never repeat the exact same sentence twice in one conversation - always rephrase
- Before asking a question, always use a 1-3 word natural bridge: "okay,", "mm-hmm,", "oh sure,", "and uh,"
- If ending the call, keep the closing message short and polite
- If transferring the call, keep the transfer line short and clear
- Vary your pacing — short sentences land harder than long ones
- Let silence breathe for a beat before your question — do not rush

---

## FORBIDDEN

- Words: I see / I understand / That makes sense / No worries / Great / Perfect / Excellent / Amazing
- No exclamation marks
- No contractions - use: I am, do not, can not, you are
- No em dash - use hyphen
- Numbers as words
- Never say "next question" or "moving on"
- Never argue with the customer
- Never pressure the customer
- Never rebut "not interested"
- Questions must end clean - no trailing filler after the question

---

## QC BLOCK - ALWAYS FIRST, BEFORE SPOKEN WORDS

Every single response MUST start with a QC block.

Format:
\`<QC>{"q":<currentQ>,"result":"<pass|fail|skip>","next":<nextQ>,"field":null,"value":null}</QC>\`

Definitions:
- pass = answered in a way that advances the call flow
- fail = answered in a way that ends the call
- skip = unclear / not answered / off-topic, so stay on same question

Examples:
\`\`\`
<QC>{"q":1,"result":"pass","next":2,"field":null,"value":null}</QC> mm-hmm, okay. and just to confirm, are you currently on Medicaid, Medicare, Tricare, or VA coverage?
<QC>{"q":1,"result":"fail","next":1,"field":null,"value":null}</QC> Thank you for your time. Have a great day.
<QC>{"q":2,"result":"pass","next":2,"field":null,"value":null}</QC> Okay, thank you. Let me connect you with a licensed specialist now.
<QC>{"q":2,"result":"fail","next":2,"field":null,"value":null}</QC> Thank you for your time. Have a great day.
<QC>{"q":2,"result":"skip","next":2,"field":null,"value":null}</QC> uh <break time="300ms"/> sorry, I was just asking - are you currently on Medicaid, Medicare, Tricare, or VA coverage?
\`\`\`

---

## ANSWERING MACHINE DETECTION

If you detect one-way monologue, voicemail beep, pre-recorded message, or no live human voice:
- END immediately
- No questions
- No response

---

## CORE CALL FLOW

This call has a maximum of only 2 qualification questions.

### QUESTION 1 - INTEREST

This is the opening qualification question.

Ask:
> um hi, this is Anna calling from uh <break time="200ms"/> Health Subsidy Center. and um <break time="200ms"/> I am just calling to make sure you are not missing out on any extra health benefits.
 soo um <break time="200ms"/> would you be open to a quick twenty second review for a health subsidy program?

Interpret Q1 like this:
- Positive responses:
  yes / yeah / sure / okay / go ahead / maybe / uh-huh / mm-hmm / tell me more / what is this
  -> PASS Q1
  -> go to Q2

- Negative responses:
  no / nope / nah / not interested / no thanks / busy / not now / stop calling / remove me / do not call / wrong person
  -> FAIL Q1
  -> immediately end the call politely

If Q1 is unclear:
- re-ask Q1 once in different wording
- do not ask more than once again

Varied Q1 re-ask examples:
- uh <break time="300ms"/> sorry, I was just asking if you would be open to a quick review of your health subsidy options?
- oh uh <break time="300ms"/> I was just wondering if you would like a quick check to see whether you may qualify for extra health benefits?
- mm-hmm, uh <break time="300ms"/> so I was just asking whether you would be open to a short review of subsidy options in your state?

Important:
- If the customer gives a negative or not-interested answer at Q1, end the call immediately
- Do not rebut
- Do not ask another question
- Do not repeat Q1 after a negative answer

---

### QUESTION 2 - GOVERNMENT COVERAGE

Ask only if Q1 was positive.

Ask:
> okay, and just to confirm, are you currently on Medicaid, Medicare, Tricare, or VA coverage?

Interpret Q2 exactly like this:

- If customer says NO
  -> PASS Q2
  -> customer qualifies
  -> prepare transfer to buyer

- If customer says YES
  -> FAIL Q2
  -> customer does not qualify
  -> politely end the call

If Q2 is unclear:
- re-ask Q2 once in different wording
- do not ask more than once again

Varied Q2 re-ask examples:
- uh <break time="300ms"/> sorry, I was just asking whether you are currently on Medicaid, Medicare, Tricare, or VA coverage?
- oh uh <break time="300ms"/> I just need to confirm whether you have any government health coverage like Medicaid or Medicare right now?
- mm-hmm, so uh <break time="300ms"/> just to check, are you on Medicaid, Medicare, Tricare, or VA coverage at the moment?

Important:
- Q2 NO = qualifies = transfer
- Q2 YES = does not qualify = end call
- Do not ask anything after Q2
- Maximum 2 questions total

---

## TRANSFER RULE

Transfer only when:
- Q1 = positive
- Q2 = no

Before transfer, say a short line like:
> okay, thank you. let me connect you with a licensed specialist now.

Then transfer the call.

Do not add extra questions before transfer.

---

## POLITE END CALL RULE

If customer is not interested at any stage, or does not qualify, say a short polite line and end the call.

Preferred closing:
> Thank you for your time. Have a great day.

Allowed variations:
- Thank you for your time. Take care.
- Okay, thank you for your time. Have a great day.

Rules:
- keep it short
- no rebuttal
- no extra explanation
- end immediately after the closing

---

## OBJECTION AND INTENT RULES

### Not interested / no / no thanks / busy / not now

If customer says any of these:
- no
- not interested
- no thanks
- busy
- not now
- stop calling
- remove me
- do not call
- wrong person
- leave me alone

Then:
- end the call politely
- do not continue
- do not rebut
- do not repeat the question

Say:
> Thank you for your time. Have a great day.

### What is this / tell me more / what is the subsidy program

Answer briefly in one short sentence, then return to the current question.

Example:
> oh uh <break time="300ms"/> this is just a quick review to see whether you may qualify for health subsidy options in your state.

Then continue with the current question.

### Is this government

Answer briefly:
> oh no, we are not a government agency - we connect people with licensed insurance specialists who review subsidy options.

Then continue with the current question.

### Cost concerns

Answer briefly:
> uh no, there is no cost for this call or review.

Then continue with the current question.

### Scam concerns

Answer briefly:
> oh uh <break time="300ms"/> we are not asking for payment information - this is just to check whether you may qualify and connect you with a licensed specialist.

If still resistant or uncomfortable:
- end politely

### Hold on / wait / one second

Say:
> oh sure, take your time.

Then stop and wait.

### DNC request

If customer says do not call, remove me, stop calling:
- end politely immediately
- do not continue

### Wrong person

If customer says wrong person:
- end politely immediately
- do not continue

### Abusive language

If the customer uses abusive or clearly hostile language:
- end immediately
- do not continue
- no rebuttal

---

## INTERRUPTION HANDLING

When the customer interrupts with a question:
1. answer briefly in one short sentence
2. re-ask the current question in different wording
3. do not advance unless they actually answered the current question

Example:
> oh yeah uh <break time="300ms"/> this is just to check whether you may qualify for subsidy options. so, are you currently on Medicaid, Medicare, Tricare, or VA coverage?

Rules:
- never re-ask in the exact same words
- never ask more than 2 qualification questions total
- do not add a third qualification question

---

## UNRESPONSIVE

If the same question has already been asked twice and there is still no real answer:
> okay, I think this might not be a good time. Thank you for your time. Have a great day.

Then end the call.

---

## SILENCE

If there is silence, you may use a short prompt:
- hey, are you still with me?
- hey, can you hear me?
- hey, are you still there?

After 2 attempts with no response:
- end the call politely

Say:
> Thank you for your time. Have a great day.

---

## INTELLIGENCE RULES

- Detect intent before responding
- Voicemail or answering machine or no live human voice -> END immediately
- Customer filler sounds like uh, um, hmm, oh -> wait, do not interrupt
- Background noise only or TV or no real speech -> wait silently
- Never ask the same question again after a negative response
- Never continue after a negative response
- Never rebut a negative response
- Never go beyond 2 qualification questions
- Wait for the customer to finish before responding
- Keep responses short and natural
- Match the customer energy
- Sound like a real human phone agent

---

## QC BLOCK REMINDER

QC block is ALWAYS the first thing in every response - before any spoken words.`;

// ─────────────────────────── TUNING CONSTANTS ────────────────────────────────

const UTTERANCE_HARD_MAX_MS = 1800;
const MIN_UTTERANCE_CHARS = 3;
const MIN_UTTERANCE_WORDS = 1;
const ECHO_GUARD_MS = 1200;
const BARGEIN_CONFIRM_MS = 180;
const MID_SILENCE_CHECK_MS = 11000;
const MID_SILENCE_HANGUP_MS = 7000;
const CANT_HEAR_COOLDOWN_MS = 9000;
const CANT_HEAR_MAX_RETRIES = 2;
const HISTORY_LIMIT = 14;
const HISTORY_FOR_MODEL = 6;
const THINKING_FILLER_MS = 800; // fire a thinking filler if LLM hasn't responded within 800ms
const TRANSFER_DELAY_MS = 5500;
const TTS_QUEUE_MAX_DEPTH = 6;
const AUDIO_BUFFER_MAX_BYTES = 200000;
const TWILIO_READY_WAIT_MAX_MS = 8000;
const ACK_TO_QUESTION_PAUSE_MS = 380;
const POST_GREETING_LISTEN_MS = 600;
const BACKCHANNEL_FILLER_MS = 300;
const BACKCHANNEL_FILLERS = [
  "mm.",
  "oh.",
  "mhm.",
  "right.",
  "uh huh.",
  "yeah.",
  "okay.",
  "got it.",
  "oh yeah.",
  "sure.",
];
const BARGEIN_MIN_WORDS = 3;

// ─────────────────────────── VOICEMAIL DETECTION ─────────────────────────────

const VOICEMAIL_REGEX =
  /(leave (your )?message|after the tone|voicemail|mailbox|not available|cannot take your call|press 1 for more options|unavailable|record your message|the person you are trying to reach|is not accepting calls)/i;

// ─────────────────────────── HELPERS ─────────────────────────────────────────

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
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!raw || raw.includes("?") || raw.split(/\s+/).filter(Boolean).length > 6) {
    return false;
  }

  return /^(?:oh\s+nice|oh\s+yeah|oh\s+okay|oh\s+sure|nice|great|perfect|cool|right|okay|ok|sure|mhm+|mhmm+|mm+|hmm+|uh\s*huh|uh-huh|yeah|yea|yep|yup|alright)(?:\s*[,.;-]\s*(?:oh\s+nice|nice|great|perfect|cool|right|okay|ok|sure|mhm+|mm+|hmm+|yeah|yea|yep|yup|alright))*[.!?]*$/i.test(
    raw
  );
}

function isAcknowledgmentChunk(text) {
  const t = (text || "").replace(/\[[^\]]+\]/g, "").replace(/<[^>]+>/g, "").trim();
  if (!t || t.includes("?") || t.split(/\s+/).length > 12) return false;
  return true;
}

function looksLikeQuestionStart(text) {
  const t = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;
  if (t.includes("?")) return true;

  const s = t.toLowerCase();
  if (/^(?:is|are|was|were|do|does|did|can|could|would|will|have|has|had|may|might|should)\b/.test(s)) return true;
  if (/^(?:what|why|how|when|where|who|which)\b/.test(s)) return true;
  return false;
}

const FILLER_REGEX =
  /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo|hmm|hm|mmm|mm|mhm|mhmm|uh huh|uh-huh|uhhuh|uh|um|erm|go ahead|please|continue|and|so|well|but|okay go ahead|sure go ahead|go on|keep going|i'm here|im here|still here|i hear you|i got you|gotcha)\.?\s*$/i;

function isFiller(text) {
  return FILLER_REGEX.test((text || "").trim());
}

function normalizeIntentText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DNC_REGEX =
  /\b(do not call|don't call|dnc|remove me|remove my number|take me off|stop calling|stop calling me|quit calling|leave me alone)\b/i;

const HARD_STOP_REGEX =
  /\b(not interested|no thanks|not now|i am busy|i'm busy|busy right now|not a good time|call me later|wrong person|wrong number|goodbye|bye)\b/i;

const YES_INTENT_REGEX =
  /^(yes|yeah|yep|yup|sure|okay|ok|alright|all right|maybe|possibly|go ahead|go on|continue|that is fine|sounds good|correct|tell me more|what is this)$/i;

const NO_INTENT_REGEX =
  /^(no|nope|nah|not really|incorrect)$/i;

function detectDncIntent(text) {
  const t = normalizeIntentText(text);
  return DNC_REGEX.test(t);
}

function detectHardStopIntent(text) {
  const t = normalizeIntentText(text);
  return DNC_REGEX.test(t) || HARD_STOP_REGEX.test(t);
}

function detectYesIntent(text) {
  const t = normalizeIntentText(text);
  return YES_INTENT_REGEX.test(t);
}

function detectNoIntent(text) {
  const t = normalizeIntentText(text);
  return NO_INTENT_REGEX.test(t);
}

function detectQ1NegativeIntent(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (detectDncIntent(t)) return true;
  if (detectHardStopIntent(t)) return true;
  if (detectNoIntent(t)) return true;
  return false;
}

const POST_GREETING_FILLER_REGEX =
  /^(?:hello[?!.]?|hi[?!.]?|hey[?!.]?|can you hear me[?!.]?|are you there[?!.]?|is anyone there[?!.]?|are you still there[?!.]?|can you hear me now[?!.]?|testing[?!.]?|hello[?!.]?\s+hello[?!.]?)$/i;

function isPostGreetingFiller(text) {
  return POST_GREETING_FILLER_REGEX.test((text || "").trim());
}

const SOCIAL_RESPONSE_REGEX =
  /^(?:(?:(?:hi|hey|hello)[,.]?\s+)?(?:[a-z]+[,.]?\s+)?(?:what about you|how about you|and you|what about yourself)[?!.]?|(?:(?:hi|hey|hello)[,.]?\s+)?(?:i(?:'m| am)\s+)?(?:doing\s+)?(?:good|fine|great|okay|well|not bad|pretty good|alright|doing well|doing good)(?:\s+(?:thanks?|thank you))?[.!?]?(?:[,.]?\s*(?:and\s+)?(?:you|yourself|what about you)[?!.]?)?|(?:good|fine|great|not bad|okay)[,.]?\s+how\s+(?:are\s+you|about\s+you)[?!.]?|how\s+are\s+you[?!.]?)$/i;

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

const DIGRESSION_REGEX =
  /^(?:why|what|how|who|when|where|can you|could you|do you|are you|is this|what do you mean|i don.?t understand|explain|tell me more|what.?s this about|say that again|repeat that|can you repeat|didn.?t catch|sorry what|sorry could you|huh|pardon|what did you say|hold on|one second|one sec|wait|hang on|i.?m (?:driving|busy|at work|in a meeting|eating|walking)|not a good time|can i ask you something|i have a question|question for you|actually|never mind|forget it|just wondering|curious(?:ly)?)\b/i;

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

const INTERRUPT_REGEX =
  /^(?:stop|wait|hold on|hang on|one sec|one second|listen|excuse me|shut up|pause|cancel|quiet|i have a question|can i ask|let me ask|actually|wait wait)\b/i;

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
  return t.replace(
    /^(\[[^\]]+\]\s*)?(?:oh\s+nice|oh\s+sure|oh\s+okay|oh\s+yeah|yeah,\s+got\s+it|mhm|mhmm|mm|okay\s+sure|okay|sure|right)\.?\s*/i,
    ""
  ).trim();
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
    const tailIsFiller =
      /^[\)\]\s.,;:-]*?(?:\(?\s*)?(?:oh\s+)?(?:ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|alright|okay|ok|sure|perfect|great|nice|cool|got\s+it|sounds\s+good|will\s+do|noted|understood|I\s+see|I\s+got\s+it|thank\s+you|thanks)(?:\s*[,.]?\s*(?:got\s+it|sounds\s+good|will\s+do|noted|understood|nice|great|good|okay|ok|sure|perfect|right|cool|alright))?(?:[\s,.;:-]+(?:oh\s+)?(?:ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|alright|okay|ok|sure|perfect|great|nice|cool|got\s+it|sounds\s+good|will\s+do|noted|understood)(?:\s*[,.]?\s*(?:nice|great|good|okay|ok|sure|perfect|right|cool|alright|got\s+it))?)*[.!?\)\]]*\s*$/i.test(
        after
      );
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
      const tail =
        /^[\)\]\s.,-]*(?:\(?\s*)?(?:oh\s+)?(?:thanks?|thank\s+you|got\s+it|okay|ok|alright|sure|right|sounds\s+good|will\s+do|noted|understood|I\s+see|mhm+|mm+|uh+|um+|yeah|yep|yup)[^a-z0-9]*$/i.test(
          after
        );
      if (tail) return t.slice(0, qm + 1).trim();
    }
  }
  return t.replace(
    /(?:\s*[,.-]?\s*)(?:\[?[^\]]*\]?\s*)?(?:oh\s+)?(?:thank\s+you|thanks|got\s+it|okay|ok|alright|sure|sounds\s+good|noted|understood)\.?\s*$/i,
    ""
  ).trim();
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
  if (/\b(medicaid|medicare|va benefits|va coverage|tricare)\b/.test(s) && /\b(not available|unfortunately|disqualif|enrolled)\b/.test(s)) {
    return "DISQUALIFIED_GOVT_COVERAGE";
  }
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

// ─────────────────────────── BACKGROUND NOISE ────────────────────────────────

const BG_NOISE_PATH = path.join(__dirname, "../assets/noise/bg_noise.raw");
const BG_NOISE_TARGET_PEAK = 50;
const BG_NOISE_VOLUME = 1.0;
const BG_NOISE_GATE_MIN = 200;

let _bgNoiseLinear = null;
let _bgNoiseOffset = 0;
let _bgNoiseMixCount = 0;

const KB_NOISE_PATH = path.join(__dirname, "../assets/noise/keyboard_8k.raw");
const KB_NOISE_TARGET_PEAK = 900;
const KB_BURST_FRAMES = 18;

let _kbNoiseLinear = null;
let _kbNoiseOffset = 0;
let _kbActiveFrames = 0;

function _mulawDecode(ulawbyte) {
  ulawbyte = (~ulawbyte) & 0xff;
  const sign = ulawbyte & 0x80;
  const exp = (ulawbyte >> 4) & 0x07;
  const mant = ulawbyte & 0x0f;
  let sample = ((mant << 3) + 0x84) << exp;
  sample -= 0x84;
  return sign ? -sample : sample;
}

const _MULAW_EXP_LUT = new Uint8Array([
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
]);

function _mulawEncode(sample) {
  const BIAS = 0x84;
  let sign;
  if (sample >= 0) {
    sign = 0;
  } else {
    sign = 0x80;
    sample = -sample - 1;
  }
  if (sample > 32767) sample = 32767;
  sample += BIAS;
  const exp = _MULAW_EXP_LUT[(sample >> 7) & 0xff];
  const mantissa = (sample >> (exp + 3)) & 0x0f;
  return (~(sign | (exp << 4) | mantissa)) & 0xff;
}

function _verifyMulawCodec() {
  let failures = 0;
  for (let b = 0; b < 256; b++) {
    const rt = _mulawEncode(_mulawDecode(b));
    if (rt !== b) failures++;
  }
  if (failures > 0) {
    logger.error(`[BgNoise] CODEC SELF-TEST FAILED: ${failures}/256 bytes do not round-trip! Voice will be distorted.`);
  } else {
    logger.info(`[BgNoise] Codec self-test passed: all 256 µ-law bytes round-trip correctly.`);
  }
  return failures === 0;
}

function _wavToLinear8k(raw) {
  if (raw.length < 44) throw new Error(`Too short to be WAV (${raw.length} bytes)`);

  const riff = raw.toString("ascii", 0, 4);
  const wave = raw.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(
      `Not a WAV file (header="${riff}...${wave}"). File size=${raw.length}. Ensure bg_noise.raw is actually a WAV PCM file.`
    );
  }

  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;

  while (pos + 8 <= raw.length) {
    const id = raw.toString("ascii", pos, pos + 4);
    const size = raw.readUInt32LE(pos + 4);
    if (id === "fmt ") fmtOffset = pos + 8;
    if (id === "data") {
      dataOffset = pos + 8;
      dataSize = size;
      break;
    }
    pos += 8 + size + (size & 1);
  }

  if (fmtOffset === -1) throw new Error("WAV missing 'fmt ' chunk");
  if (dataOffset === -1) throw new Error("WAV missing 'data' chunk");

  const audioFormat = raw.readUInt16LE(fmtOffset);
  const numChannels = raw.readUInt16LE(fmtOffset + 2);
  const sampleRate = raw.readUInt32LE(fmtOffset + 4);
  const bitsPerSample = raw.readUInt16LE(fmtOffset + 14);

  logger.info(
    `[BgNoise] WAV header: audioFormat=${audioFormat} channels=${numChannels} sampleRate=${sampleRate}Hz bits=${bitsPerSample} dataBytes=${dataSize} duration=${(dataSize / (sampleRate * numChannels * (bitsPerSample >> 3))).toFixed(2)}s`
  );

  if (audioFormat !== 1) throw new Error(`WAV audioFormat=${audioFormat} — must be 1 (PCM).`);
  if (bitsPerSample !== 8 && bitsPerSample !== 16) throw new Error(`WAV bitsPerSample=${bitsPerSample} — only 8 or 16 bit supported.`);
  if (numChannels < 1 || numChannels > 2) throw new Error(`WAV channels=${numChannels} — only mono or stereo supported.`);

  const bytesPerSample = bitsPerSample >> 3;
  const frameSize = bytesPerSample * numChannels;
  const numFrames = Math.floor(dataSize / frameSize);
  const ratio = sampleRate / 8000;
  const outFrames = Math.floor(numFrames / ratio);

  const out = new Int16Array(outFrames);

  for (let o = 0; o < outFrames; o++) {
    const srcPos = o * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const base0 = dataOffset + srcIdx * frameSize;
    const base1 = dataOffset + Math.min(srcIdx + 1, numFrames - 1) * frameSize;

    let left0, right0, left1, right1;
    if (bitsPerSample === 16) {
      left0 = raw.readInt16LE(base0);
      right0 = numChannels === 2 ? raw.readInt16LE(base0 + 2) : left0;
      left1 = raw.readInt16LE(base1);
      right1 = numChannels === 2 ? raw.readInt16LE(base1 + 2) : left1;
    } else {
      left0 = (raw[base0] - 128) << 8;
      right0 = numChannels === 2 ? ((raw[base0 + 1] - 128) << 8) : left0;
      left1 = (raw[base1] - 128) << 8;
      right1 = numChannels === 2 ? ((raw[base1 + 1] - 128) << 8) : left1;
    }

    const mono0 = numChannels === 2 ? Math.round((left0 + right0) / 2) : left0;
    const mono1 = numChannels === 2 ? Math.round((left1 + right1) / 2) : left1;
    out[o] = Math.round(mono0 + frac * (mono1 - mono0));
  }

  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i] < 0 ? -out[i] : out[i];
    if (a > peak) peak = a;
  }

  logger.info(
    `[BgNoise] Resampled to 8kHz: ${outFrames} samples (~${(outFrames / 8000).toFixed(1)}s) peak_linear=${peak} (${((peak / 32767) * 100).toFixed(1)}% of full scale)`
  );

  return out;
}

function _rawMulawToLinear(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = _mulawDecode(buf[i]);

  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i] < 0 ? -out[i] : out[i];
    if (a > peak) peak = a;
  }

  logger.info(
    `[BgNoise] Raw µ-law decoded: ${out.length} samples (~${(out.length / 8000).toFixed(1)}s) peak_linear=${peak} (${((peak / 32767) * 100).toFixed(1)}% of full scale)`
  );

  return out;
}

function _loadBgNoise() {
  if (_bgNoiseLinear !== null) return;

  _verifyMulawCodec();

  try {
    const raw = fs.readFileSync(BG_NOISE_PATH);
    if (raw.length === 0) throw new Error("file is empty");

    logger.info(`[BgNoise] Loading: path=${BG_NOISE_PATH} size=${raw.length} bytes`);

    const isWav =
      raw.length >= 12 &&
      raw.toString("ascii", 0, 4) === "RIFF" &&
      raw.toString("ascii", 8, 12) === "WAVE";

    if (isWav) {
      logger.info(`[BgNoise] Detected WAV container — parsing PCM...`);
      _bgNoiseLinear = _wavToLinear8k(raw);
    } else {
      logger.info(`[BgNoise] No RIFF header — treating as raw µ-law 8 kHz`);
      _bgNoiseLinear = _rawMulawToLinear(raw);
    }

    let sourcePeak = 0;
    for (let i = 0; i < _bgNoiseLinear.length; i++) {
      const a = _bgNoiseLinear[i] < 0 ? -_bgNoiseLinear[i] : _bgNoiseLinear[i];
      if (a > sourcePeak) sourcePeak = a;
    }

    if (sourcePeak === 0) {
      logger.warn(`[BgNoise] WARNING — noise file decoded to all-zero samples. Mixing disabled.`);
      _bgNoiseLinear = new Int16Array(0);
    } else {
      const normFactor = BG_NOISE_TARGET_PEAK / sourcePeak;
      for (let i = 0; i < _bgNoiseLinear.length; i++) {
        _bgNoiseLinear[i] = Math.round(_bgNoiseLinear[i] * normFactor);
      }
      logger.info(
        `[BgNoise] Normalized: source_peak=${sourcePeak} → target_peak=${BG_NOISE_TARGET_PEAK} norm_factor=${normFactor.toFixed(6)} | noise_at_mix_time=${Math.round(BG_NOISE_TARGET_PEAK * BG_NOISE_VOLUME)} linear units`
      );
    }

    logger.info(
      `[BgNoise] Ready: ${_bgNoiseLinear.length} samples (~${(_bgNoiseLinear.length / 8000).toFixed(1)}s) | target_peak=${BG_NOISE_TARGET_PEAK} vol=${BG_NOISE_VOLUME}`
    );
  } catch (e) {
    logger.error(
      `[BgNoise] LOAD FAILED — noise mixing DISABLED.\n  Error: ${e.message}\n  Path: ${BG_NOISE_PATH}`
    );
    _bgNoiseLinear = new Int16Array(0);
  }
}

function _loadKbNoise() {
  if (_kbNoiseLinear !== null) return;

  try {
    const raw = fs.readFileSync(KB_NOISE_PATH);
    if (raw.length === 0) throw new Error("file is empty");

    logger.info(`[KbNoise] Loading: path=${KB_NOISE_PATH} size=${raw.length} bytes`);

    const isWav =
      raw.length >= 12 &&
      raw.toString("ascii", 0, 4) === "RIFF" &&
      raw.toString("ascii", 8, 12) === "WAVE";

    _kbNoiseLinear = isWav ? _wavToLinear8k(raw) : _rawMulawToLinear(raw);

    let sourcePeak = 0;
    for (let i = 0; i < _kbNoiseLinear.length; i++) {
      const a = _kbNoiseLinear[i] < 0 ? -_kbNoiseLinear[i] : _kbNoiseLinear[i];
      if (a > sourcePeak) sourcePeak = a;
    }

    if (sourcePeak === 0) {
      logger.warn(`[KbNoise] File decoded to silence — keyboard mixing disabled`);
      _kbNoiseLinear = new Int16Array(0);
    } else {
      const normFactor = KB_NOISE_TARGET_PEAK / sourcePeak;
      for (let i = 0; i < _kbNoiseLinear.length; i++) {
        _kbNoiseLinear[i] = Math.round(_kbNoiseLinear[i] * normFactor);
      }
      logger.info(
        `[KbNoise] Ready: ${_kbNoiseLinear.length} samples (~${(_kbNoiseLinear.length / 8000).toFixed(2)}s) | source_peak=${sourcePeak} → target_peak=${KB_NOISE_TARGET_PEAK} | burst_duration=${KB_BURST_FRAMES * 20}ms`
      );
    }
  } catch (e) {
    logger.warn(`[KbNoise] DISABLED — ${e.message} | path=${KB_NOISE_PATH}`);
    _kbNoiseLinear = new Int16Array(0);
  }
}

function _triggerKeyboardBurst() {
  if (_kbNoiseLinear && _kbNoiseLinear.length > 0) {
    _kbNoiseOffset = 0;
    _kbActiveFrames = KB_BURST_FRAMES;
  }
}

function _mixNoiseIntoUlawFrame(voiceFrame) {
  const bgActive = _bgNoiseLinear && _bgNoiseLinear.length > 0;
  const kbActive = _kbActiveFrames > 0 && _kbNoiseLinear && _kbNoiseLinear.length > 0;
  if (!bgActive && !kbActive) return voiceFrame;

  const out = Buffer.allocUnsafe(voiceFrame.length);
  const bgSamples = bgActive ? _bgNoiseLinear.length : 0;
  const kbSamples = kbActive ? _kbNoiseLinear.length : 0;
  let peakVoice = 0;
  let peakNoise = 0;
  let peakMixed = 0;
  let clipCount = 0;
  const useKbThisFrame = kbActive;

  for (let i = 0; i < voiceFrame.length; i++) {
    const voiceLinear = _mulawDecode(voiceFrame[i]);
    const voiceAbs = voiceLinear < 0 ? -voiceLinear : voiceLinear;

    if (voiceAbs < BG_NOISE_GATE_MIN && !useKbThisFrame) {
      out[i] = voiceFrame[i];
      if (bgActive) _bgNoiseOffset = (_bgNoiseOffset + 1) % bgSamples;
      if (voiceAbs > peakVoice) peakVoice = voiceAbs;
      continue;
    }

    let bgLinear = 0;
    if (bgActive) {
      if (voiceAbs >= BG_NOISE_GATE_MIN) bgLinear = _bgNoiseLinear[_bgNoiseOffset % bgSamples];
      _bgNoiseOffset = (_bgNoiseOffset + 1) % bgSamples;
    }

    let kbLinear = 0;
    if (useKbThisFrame) {
      kbLinear = _kbNoiseLinear[_kbNoiseOffset % kbSamples];
      _kbNoiseOffset = (_kbNoiseOffset + 1) % kbSamples;
    }

    const mixed = voiceLinear + Math.round(bgLinear * BG_NOISE_VOLUME) + kbLinear;

    let clamped;
    if (mixed > 32767) {
      clamped = 32767;
      clipCount++;
    } else if (mixed < -32767) {
      clamped = -32767;
      clipCount++;
    } else {
      clamped = mixed;
    }

    out[i] = _mulawEncode(clamped);

    const an = (bgLinear < 0 ? -bgLinear : bgLinear) + (kbLinear < 0 ? -kbLinear : kbLinear);
    const am = clamped < 0 ? -clamped : clamped;
    if (voiceAbs > peakVoice) peakVoice = voiceAbs;
    if (an > peakNoise) peakNoise = an;
    if (am > peakMixed) peakMixed = am;
  }

  if (useKbThisFrame) _kbActiveFrames--;

  _bgNoiseMixCount++;
  if (_bgNoiseMixCount % 250 === 0) {
    const effectiveNoisePeak = Math.round(peakNoise * BG_NOISE_VOLUME);
    const ratio = peakVoice > 0 ? ((effectiveNoisePeak / peakVoice) * 100).toFixed(2) : "n/a";
    const clipWarn = clipCount > 0 ? ` ⚠ CLIPS=${clipCount}` : "";
    logger.info(
      `[BgNoise] mix#${_bgNoiseMixCount} | voice_peak=${peakVoice} noise_peak_normalized=${peakNoise} effective_noise=${effectiveNoisePeak} noise/voice=${ratio}% mixed_peak=${peakMixed}${clipWarn}`
    );
  }

  return out;
}

// ─────────────────────────── MAIN CLASS ──────────────────────────────────────

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

    logger.info(
      `MediaStreamHandler initialized. Static prompt ~${Math.round(STATIC_SYSTEM_PROMPT.length / 4)} tokens`
    );

    _loadBgNoise();
    _loadKbNoise();

    this.setupWebSocket();
    this._cleanupInterval = setInterval(() => this.cleanupInactiveSessions(), 30000);
    this._heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch { }
      });
    }, 30000);
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    clearInterval(this._heartbeatInterval);
  }

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const sessionId = req.url.split("/").pop();
      logger.info(`[${sessionId}] WS CONNECTED`);
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });

      this.initializeSession(sessionId, ws).catch((err) =>
        logger.error(`[${sessionId}] Session init failed: ${err.message}`)
      );

      ws.on("message", async (msg) => {
        let data;
        try {
          data = JSON.parse(msg.toString());
        } catch (e) {
          logger.error(`[${sessionId}] Parse error: ${e.message}`);
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
            logger.info(`[${sessionId}] Twilio START streamSid=${session.streamSid}`);

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

  createEmptySession(sessionId, ws) {
    return {
      id: sessionId,
      ws,
      callLog: null,
      campaign: null,
      openingLine: null,
      agentName: "Anna",
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
      _finalHangupInProgress: false,
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
      transferPending: false,
      lastProcessedAt: 0,
      lastAiAudioSentAt: 0,
      lastAckTurn: 0,
      transferAttempted: false,
      timers: {
        startSpeak: null,
        startHangup: null,
        midCheck: null,
        midHangup: null,
      },
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
        interestConfirmed: null,
        govtCoverageChecked: null,
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

    const answeredBy = String(callLog.answeredBy || callLog.amd || callLog.AMD || "")
      .toLowerCase()
      .trim();

    if (answeredBy && answeredBy !== "human") {
      let disposition = null;

      if (
        answeredBy === "machine_end_beep" ||
        answeredBy === "machine_end_silence" ||
        answeredBy === "machine_end_other" ||
        answeredBy.includes("voicemail") ||
        answeredBy.includes("beep")
      ) {
        disposition = "VOICEMAIL";
      } else if (answeredBy === "fax" || answeredBy.includes("fax")) {
        disposition = "FAX";
      } else if (answeredBy === "unknown") {
        disposition = "AMD_UNKNOWN";
      } else if (answeredBy === "machine_start" || answeredBy.includes("machine")) {
        disposition = "ANSWERING_MACHINE";
      } else {
        disposition = "NON_HUMAN";
      }

      callLog.disposition = callLog.disposition || disposition;
      callLog.endTime = new Date();
      callLog.status = "completed";

      try {
        await callLog.save();
      } catch (e) {
        logger.error(`[${sessionId}] AMD save error: ${e.message}`);
      }

      logger.info(`[${sessionId}] AMD guard → ${callLog.disposition}. Closing.`);
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      } catch { }
      return;
    }

    const data = await this.campaignService.getCampaignWithPrompt(callLog.campaign._id);
    if (!data) {
      logger.error(`[${sessionId}] Campaign not found`);
      return;
    }

    const { campaign, openingLine, agentName } = data;
    const existing = this.sessions.get(sessionId);
    const session = existing || this.createEmptySession(sessionId, ws);

    session.ws = ws;
    session.callLog = callLog;
    session.campaign = campaign;
    session.openingLine = openingLine;
    session.agentName = agentName || "Anna";
    session.direction = String(callLog.direction || callLog.Direction || "").toLowerCase().trim();
    session.firstName = String(
      callLog.firstName ||
      callLog.contact?.firstName ||
      callLog.contact?.first_name ||
      callLog.lead?.firstName ||
      ""
    ).trim();

    this.sessions.set(sessionId, session);

    const greetingText = this._buildGreetingText(session);
    if (greetingText && campaign?.voiceId) {
      session._prewarmedGreetingStream = this.elevenlabsService
        .streamTextToSpeechFast(greetingText, campaign.voiceId, campaign.voiceSettings || {})
        .catch(() => null);
      logger.info(`[${sessionId}] Pre-warming greeting TTS`);
    }

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
    this.maybePlayInitialGreeting(sessionId).catch(() => { });
  }

  _buildGreetingText(session) {
    const agent = session.agentName || "Anna";
    const DEFAULT =
      `um hi, this is Anna calling from uh <break time="200ms"/> Health Subsidy Center.` +
      `and um uh <break time="200ms"/> I am just calling to make sure you are not missing out on any extra health benefits. soo um <break time="200ms"/>would you be open to a quick twenty second review for a health subsidy program`;

    if (session.openingLine) {
      const rendered = safeTTS(
        renderTemplate(session.openingLine, {
          agentname: agent,
          first_name: session.firstName || "",
        })
      );
      return rendered || safeTTS(DEFAULT);
    }

    return safeTTS(DEFAULT);
  }

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

  async maybePlayInitialGreeting(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.initialGreetingSent) return;
    if (!session.campaign) return;
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

      s.openingComplete = true;
      s.currentStage = "qualification";
      s.currentQuestionNum = 1;
      s.greetingCompletedAt = Date.now();
      logger.info(`[${sessionId}] Greeting done → Q1`);

      this.armMidCallSilence(sessionId);

      if (!s.hasUserSpoken) {
        this._clearTimer(s, "startHangup");
        this._setTimer(sessionId, "startHangup", 15000, async () => {
          const ss = this.sessions.get(sessionId);
          if (!ss || ss.hasUserSpoken || ss.isClosing || ss.isCleaning) return;

          logger.warn(`[${sessionId}] startHangup fired after completed greeting: no user response`);

          if (ss.callLog && !ss.callLog.disposition) {
            ss.callLog.disposition = "NO_ANSWER";
          }

          await this.politeHangup(sessionId, {
            finalMessage: "Sorry, I can not hear you. Goodbye.",
          });
        });
      }
    };

    const prewarmed = session._prewarmedGreetingStream || null;
    session._prewarmedGreetingStream = null;

    if (prewarmed) {
      prewarmed
        .then((stream) => {
          const s = this.sessions.get(sessionId);
          if (!s || s.isClosing || s.isCleaning) {
            onGreetingComplete();
            return;
          }

          if (stream) {
            s.ttsQueue.unshift({
              text: greetingText,
              _preloadedStream: stream,
              onComplete: onGreetingComplete,
            });
            this.runTTSQueue(sessionId).catch(() => { });
          } else {
            this.enqueueTTS(sessionId, greetingText, {
              flush: true,
              onComplete: onGreetingComplete,
            });
          }
        })
        .catch(() => {
          this.enqueueTTS(sessionId, greetingText, {
            flush: true,
            onComplete: onGreetingComplete,
          });
        });
    } else {
      this.enqueueTTS(sessionId, greetingText, {
        flush: true,
        onComplete: onGreetingComplete,
      });
    }
  }

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

      logger.info(`[${sessionId}] Start-silence fallback greeting triggered`);

      const fallbackOnComplete = () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;

        ss.openingComplete = true;
        ss.currentStage = "qualification";
        ss.currentQuestionNum = 1;
        ss.greetingCompletedAt = Date.now();
        logger.info(`[${sessionId}] Fallback greeting done → Q1`);

        this.armMidCallSilence(sessionId);

        if (!ss.hasUserSpoken) {
          this._clearTimer(ss, "startHangup");
          this._setTimer(sessionId, "startHangup", 15000, async () => {
            const sss = this.sessions.get(sessionId);
            if (!sss || sss.hasUserSpoken || sss.isClosing || sss.isCleaning) return;

            logger.warn(`[${sessionId}] fallback startHangup fired after completed greeting: no user response`);

            if (sss.callLog && !sss.callLog.disposition) {
              sss.callLog.disposition = "NO_ANSWER";
            }

            await this.politeHangup(sessionId, {
              finalMessage: "Sorry, I can not hear you. Goodbye.",
            });
          });
        }
      };

      const prewarmed = s._prewarmedGreetingStream || null;
      s._prewarmedGreetingStream = null;

      if (prewarmed) {
        prewarmed
          .then((stream) => {
            const sf = this.sessions.get(sessionId);
            if (!sf || sf.isClosing || sf.isCleaning) {
              fallbackOnComplete();
              return;
            }

            if (stream) {
              sf.ttsQueue.unshift({
                text: fallback,
                _preloadedStream: stream,
                onComplete: fallbackOnComplete,
              });
              this.runTTSQueue(sessionId).catch(() => { });
            } else {
              this.enqueueTTS(sessionId, fallback, {
                flush: true,
                onComplete: fallbackOnComplete,
              });
            }
          })
          .catch(() => {
            this.enqueueTTS(sessionId, fallback, {
              flush: true,
              onComplete: fallbackOnComplete,
            });
          });
      } else {
        this.enqueueTTS(sessionId, fallback, {
          flush: true,
          onComplete: fallbackOnComplete,
        });
      }
    });
  }
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

    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }
    if (us.hardMaxTimer) {
      clearTimeout(us.hardMaxTimer);
      us.hardMaxTimer = null;
    }

    us.hardMaxTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, {
        reason: "hard_max",
        utteranceId: us.utteranceId,
      });
    }, UTTERANCE_HARD_MAX_MS);

    if (session.isSpeaking) {
      const sinceAiAudio = Date.now() - (session.lastAiAudioSentAt || 0);
      if (sinceAiAudio < ECHO_GUARD_MS) return;

      us.pendingBargeIn = true;
      if (us.bargeInConfirmTimer) {
        clearTimeout(us.bargeInConfirmTimer);
        us.bargeInConfirmTimer = null;
      }

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

    if (VOICEMAIL_REGEX.test(trimmed)) {
      logger.info(`[${sessionId}] Voicemail detected — hanging up`);
      const vmSess = this.sessions.get(sessionId);
      if (vmSess && vmSess.callLog && !vmSess.callLog.disposition) {
        vmSess.callLog.disposition = "VOICEMAIL";
      }
      this.endTwilioCall(sessionId).catch(() => { });
      this.cleanupSession(sessionId, { endedBy: "voicemail_detected" }).catch(() => { });
      return;
    }

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
      if (us.finalizeTimer) {
        clearTimeout(us.finalizeTimer);
        us.finalizeTimer = null;
      }
      return;
    }

    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }

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

    if (us.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }
    if (us.hardMaxTimer) {
      clearTimeout(us.hardMaxTimer);
      us.hardMaxTimer = null;
    }
    if (us.bargeInConfirmTimer) {
      clearTimeout(us.bargeInConfirmTimer);
      us.bargeInConfirmTimer = null;
    }

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
      const openingNorm = (session.openingLine || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      const utterNorm = utterance.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();

      if (openingNorm && utterNorm.length >= 4) {
        const firstWords = openingNorm.split(/\s+/).slice(0, 6).join(" ");
        if (
          openingNorm.startsWith(utterNorm) ||
          firstWords.startsWith(utterNorm.split(/\s+/).slice(0, 4).join(" "))
        ) {
          logger.info(`[${sessionId}] Echo suppressed: "${utterance}"`);
          return;
        }
      }

      if (isStrongInterrupt(utterance) && !isFiller(utterance)) {
        logger.info(`[${sessionId}] Strong interrupt during greeting — processing`);
      } else {
        logger.info(`[${sessionId}] Greeting in progress — buffering: "${utterance}"`);
        return;
      }
    }

    if (session.openingComplete && !session.hasRealInput && isPostGreetingFiller(utterance)) {
      logger.info(`[${sessionId}] Post-greeting filler absorbed: "${utterance}"`);
      return;
    }

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
    if (session.transferPending || session._finalHangupInProgress) return;

    session.turnRules.forcedPrefix = null;
    session.turnRules.disallowAck = false;
    session.turnRules.disallowSocial = false;
    session.turnRules.disableBackchannel = false;

    session.hasRealInput = true;

    if (session.openingComplete && detectDncIntent(utterance)) {
      logger.info(`[${sessionId}] DNC detected: "${utterance}"`);
      if (session.callLog) session.callLog.disposition = "DNC";
      session.state.interestConfirmed = false;
      this.politeHangup(sessionId, {
        finalMessage: "Thank you for your time. Have a great day.",
      }).catch(() => { });
      return;
    }

    if (session.openingComplete && session.currentStage === "qualification") {
      if (session.currentQuestionNum === 1) {
        this._handleDirectQ1(sessionId, utterance)
          .then((handled) => {
            if (!handled) this._processWithLLM(sessionId, utterance);
          })
          .catch((e) => {
            logger.error(`[${sessionId}] _handleDirectQ1 error: ${e.message}`);
          });
        return;
      }

      if (session.currentQuestionNum === 2) {
        this._handleDirectQ2(sessionId, utterance)
          .then((handled) => {
            if (!handled) this._processWithLLM(sessionId, utterance);
          })
          .catch((e) => {
            logger.error(`[${sessionId}] _handleDirectQ2 error: ${e.message}`);
          });
        return;
      }
    }

    const toneHint = detectToneHint(utterance);

    if (session.openingComplete && (isSocialResponse(utterance) || containsReciprocalQuestion(utterance))) {
      session.lastUserInputType = "social";
      session.turnRules.forcedPrefix = buildForcedSocialReply(utterance);
      session.turnRules.disallowAck = true;
      session.turnRules.disallowSocial = true;
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
      const longAnswer = wordCount(utterance) >= 8;
      const emotional =
        toneHint === "positive" || toneHint === "negative" || toneHint === "hostile";
      const turnsSinceAck = session.activeTurnId - session.lastAckTurn;
      session.turnRules.disallowAck = !(turnsSinceAck >= 3 && (longAnswer || emotional));

      if (session.pausedQuestionNum !== null) {
        logger.info(`[${sessionId}] Digression resolved → Q${session.currentQuestionNum}`);
        session.pausedQuestionNum = null;
      }
    }

    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
      }
    });
  }

  enqueueTTS(sessionId, text, { flush = false, onComplete = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isCleaning) {
      if (onComplete) onComplete();
      return;
    }

    const t = safeTTS(text);
    if (!t) {
      if (onComplete) onComplete();
      return;
    }

    if (flush) session.ttsQueue.length = 0;

    if (session.ttsQueue.length >= TTS_QUEUE_MAX_DEPTH) {
      logger.warn(`[${sessionId}] TTS queue full — dropping`);
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
        if (!s || s.isCleaning) return;

        const item = s.ttsQueue.shift();
        if (!item) continue;

        const textToSpeak = typeof item === "string" ? item : item.text;
        const onComplete = typeof item === "string" ? null : item.onComplete;
        const preloadedStream = item._preloadedStream || null;

        if (!textToSpeak) {
          if (onComplete) onComplete();
          continue;
        }

        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          const waitStart = Date.now();
          while (!s.isTwilioReady || !s.streamSid || !s.ws) {
            if (Date.now() - waitStart > TWILIO_READY_WAIT_MAX_MS) {
              if (onComplete) onComplete();
              break;
            }
            await sleep(35);
            const ss = this.sessions.get(sessionId);
            if (!ss || ss.isCleaning) return;
          }
          const ss = this.sessions.get(sessionId);
          if (!ss || !ss.isTwilioReady || !ss.streamSid || !ss.ws) continue;
        }

        const audioStream = preloadedStream || (await this.getAudioStream(sessionId, textToSpeak));
        if (!audioStream) {
          if (onComplete) onComplete();
          continue;
        }

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

        {
          const ss = this.sessions.get(sessionId);
          if (ss && !ss.isClosing && !ss.isCleaning && ss.ttsQueue.length > 0) {
            const next = ss.ttsQueue[0];
            const nextText = typeof next === "string" ? next : next?.text || "";
            if (isAcknowledgmentChunk(textToSpeak) && nextText.includes("?")) {
              await sleep(ACK_TO_QUESTION_PAUSE_MS);
            }
          }
        }

        if (onComplete) {
          try {
            onComplete();
          } catch { }
        }

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
    session.ttsAbort = ac;
    session.isSpeaking = true;
    session.lastAiSpokeAt = Date.now();
    const streamStartAt = Date.now();

    const FRAME_BYTES = 160;
    const FRAME_MS = 20;
    let buffer = Buffer.alloc(0);
    let ended = false;
    let frameCount = 0;
    let firstFrameLogged = false;

    const onData = (chunk) => {
      if (!chunk?.length) return;
      if (buffer.length + chunk.length > AUDIO_BUFFER_MAX_BYTES) {
        const keep = AUDIO_BUFFER_MAX_BYTES - buffer.length;
        if (keep > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, keep)]);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
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
      while (!ac.signal.aborted) {
        if (buffer.length >= FRAME_BYTES) {
          const frame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);

          try {
            const mixedFrame = _mixNoiseIntoUlawFrame(frame);
            session.ws.send(
              JSON.stringify({
                event: "media",
                streamSid: session.streamSid,
                media: { payload: mixedFrame.toString("base64") },
              })
            );

            if (!firstFrameLogged) {
              firstFrameLogged = true;
              _triggerKeyboardBurst();
              logger.info(`[${sessionId}] TTS first-frame-to-caller: ${Date.now() - streamStartAt}ms`);
            }
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
      try {
        audioStream.destroy();
      } catch { }

      buffer = Buffer.alloc(0);
      session.isSpeaking = false;
      session.ttsAbort = null;

      logger.info(
        `[${sessionId}] TTS done frames=${frameCount} audio_ms=${frameCount * FRAME_MS} stream_to_done_ms=${Date.now() - streamStartAt}`
      );
    }
  }

  _buildSystemPrompt(session) {
    return STATIC_SYSTEM_PROMPT + "\n" + this._buildRuntimeState(session);
  }

  _buildRuntimeState(session) {
    const st = session.state || {};

    const q1 =
      st.interestConfirmed === null ? "pending" : st.interestConfirmed === true ? "pass" : "fail";
    const q2 =
      st.govtCoverageChecked === null
        ? "pending"
        : st.govtCoverageChecked === true
          ? "pass(no-govt)"
          : "fail(has-govt)";

    let turnInstruction = "";
    if (session.lastUserInputType === "social") {
      if (session.turnRules?.forcedPrefix) {
        turnInstruction = `TURN=SOCIAL | Social reply already spoken. Output ONLY: QC block + Q${session.currentQuestionNum}. No ack, no social line.`;
      } else {
        turnInstruction = `TURN=SOCIAL | First: warm reaction (1 sentence). Second: Q${session.currentQuestionNum}. Question goes LAST.`;
      }
    } else if (session.lastUserInputType === "digression") {
      const q = session.pausedQuestionNum || session.currentQuestionNum;
      turnInstruction = `TURN=DIGRESSION | QC skip q=${q} next=${q}. Answer their question (1 sentence). Re-ask Q${q} at the end. Never advance.`;
    }

    const greetingLine = session.openingComplete
      ? `GREETING_COMPLETE=true | Mid-call. Never re-introduce yourself.`
      : `GREETING_IN_PROGRESS`;

    const wrapupLine =
      session.currentStage === "wrapup"
        ? `WRAPUP | Transfer or call closing in progress. No new questions.`
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
    ]
      .filter(Boolean)
      .join("\n");
  }

  _askQuestionTwoText(session) {
    const variants = [
      "Okay, and just to confirm, are you currently on Medicaid, Medicare, Tricare, or VA coverage?",
      "And uh, just to check - are you currently on Medicaid, Medicare, Tricare, or VA coverage?",
      "mm-hmm, and are you currently on Medicaid, Medicare, Tricare, or VA coverage?",
      "okay, and just one quick thing - are you on Medicaid, Medicare, Tricare, or VA coverage right now?",
    ];
    const idx = (session?.activeTurnId || 0) % variants.length;
    return variants[idx];
  }

  async _speakThenTransfer(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    session.currentStage = "wrapup";
    session.transferPending = true;
    this._clearAllTimers(session);

    if (message) {
      this.enqueueTTS(sessionId, message, { flush: true });
      await this._waitForTTSIdle(sessionId, 12000);
    }

    session.transferPending = false;
    await this._maybeTransferCall(sessionId);
  }

  async _handleDirectQ1(sessionId, utterance) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return false;

    if (detectDncIntent(utterance)) {
      session.state.interestConfirmed = false;
      if (session.callLog) session.callLog.disposition = "DNC";
      await this.politeHangup(sessionId, {
        finalMessage: "Thank you for your time. Have a great day.",
      });
      return true;
    }

    if (detectQ1NegativeIntent(utterance)) {
      session.state.interestConfirmed = false;
      if (session.callLog) session.callLog.disposition = "NOT_INTERESTED";
      await this.politeHangup(sessionId, {
        finalMessage: "Thank you for your time. Have a great day.",
      });
      return true;
    }

    if (detectYesIntent(utterance)) {
      session.state.interestConfirmed = true;
      session.state.capturedAnswers.q1 = "yes";
      session.currentStage = "qualification";
      session.currentQuestionNum = 2;

      // Natural ack bridges — a human agent never jumps cold into Q2
      const ackBridges = [
        "oh okay,",
        "mm-hmm,",
        "oh sure,",
        "okay,",
        "yeah,",
      ];
      const ack = ackBridges[session.activeTurnId % ackBridges.length];

      const q2 = this._askQuestionTwoText(session);
      const fullQ2 = `${ack} ${q2}`;

      session.conversationHistory.push({ role: "assistant", content: fullQ2 });
      session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

      this.enqueueTTS(sessionId, fullQ2, { flush: true });
      return true;
    }

    return false;
  }

  async _handleDirectQ2(sessionId, utterance) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return false;

    if (detectDncIntent(utterance)) {
      session.state.qualified = false;
      if (session.callLog) session.callLog.disposition = "DNC";
      await this.politeHangup(sessionId, {
        finalMessage: "Thank you for your time. Have a great day.",
      });
      return true;
    }

    if (detectHardStopIntent(utterance) && !detectNoIntent(utterance)) {
      session.state.qualified = false;
      if (session.callLog && !session.callLog.disposition) {
        session.callLog.disposition = "NOT_INTERESTED";
      }
      await this.politeHangup(sessionId, {
        finalMessage: "Thank you for your time. Have a great day.",
      });
      return true;
    }

    if (detectNoIntent(utterance)) {
      session.state.govtCoverageChecked = true;
      session.state.qualified = true;
      session.state.capturedAnswers.q2 = "no";
      session.currentStage = "wrapup";

      if (session.callLog) {
        session.callLog.disposition = "TRANSFERRED_TO_AGENT";
      }

      const transferLines = [
        "Okay, thank you. Let me connect you with a licensed specialist now.",
        "mm-hmm, okay. let me go ahead and connect you with a licensed specialist.",
        "oh great, let me put you through to a licensed specialist right now.",
        "okay, one moment - let me connect you with someone who can help.",
      ];
      const transferMsg = transferLines[session.activeTurnId % transferLines.length];

      await this._speakThenTransfer(
        sessionId,
        transferMsg
      );
      return true;
    }

    if (detectYesIntent(utterance)) {
      session.state.govtCoverageChecked = false;
      session.state.qualified = false;
      session.state.capturedAnswers.q2 = "yes";
      session.currentStage = "wrapup";

      if (session.callLog) {
        session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
      }

      await this.politeHangup(sessionId, {
        finalMessage: "Thank you for your time. Have a great day.",
      });
      return true;
    }

    return false;
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;
    if (
      session.currentStage === "wrapup" &&
      (session.transferAttempted || session.transferPending || session._finalHangupInProgress)
    ) {
      logger.info(`[${sessionId}] Wrapup active — ignoring input`);
      return;
    }

    await this._processWithLLM(sessionId, userText);
  }

  async _processWithLLM(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    if (
      session.currentStage === "wrapup" &&
      (session.transferAttempted || session.transferPending || session._finalHangupInProgress)
    ) {
      logger.info(`[${sessionId}] Wrapup active — ignoring input`);
      return;
    }

    this.stopTTS(sessionId);
    this.sendClearToTwilio(sessionId);

    if (session.llmAbort) {
      try {
        session.llmAbort.abort();
      } catch { }
    }

    const llmController = new AbortController();
    session.llmAbort = llmController;

    session.isProcessingUtterance = true;
    session.activeTurnId += 1;
    const myTurnId = session.activeTurnId;
    session._lastUtterance = userText;
    const t0 = Date.now();

    let thinkingFillerFired = false;
    let thinkingFillerTimer = null;
    let backchannelTimer = null;

    try {
      const systemPrompt = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(
        `[${sessionId}] LLM_START turn=${myTurnId} stage=${session.currentStage} Q=${session.currentQuestionNum} type=${session.lastUserInputType}`
      );

      session._pendingQuestion = false;

      if (session.turnRules?.forcedPrefix) {
        const prefix = safeTTS(session.turnRules.forcedPrefix);
        if (prefix) {
          session.lastAckTurn = myTurnId;
          this.enqueueTTS(sessionId, prefix);
        }
      }

      let fullText = "";
      let firstTokenAt = 0;
      let firstChunkSent = false;
      let lastQuestionChunk = null;

      const isSocialTurn =
        session.lastUserInputType === "social" && !session.turnRules?.disableBackchannel;

      if (isSocialTurn) {
        backchannelTimer = setTimeout(() => {
          const s = this.sessions.get(sessionId);
          if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
          this.enqueueTTS(sessionId, BACKCHANNEL_FILLERS[myTurnId % BACKCHANNEL_FILLERS.length]);
        }, BACKCHANNEL_FILLER_MS);
      }

      thinkingFillerTimer = setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
        if (s.lastUserInputType === "social") return;
        const THINKING_POOL = ["mhm.", "right.", "uh huh.", "mm.", "okay.", "yeah."];
        thinkingFillerFired = true;
        this.enqueueTTS(sessionId, THINKING_POOL[myTurnId % THINKING_POOL.length]);
      }, THINKING_FILLER_MS);

      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || llmController.signal.aborted) return;

        let san = safeTTS(sentence);
        if (!san) return;

        if (s._pendingQuestion && isAckOnlyUtterance(san)) return;
        if (s.turnRules?.disallowSocial) san = stripDisallowedSocial(san);
        if (s.turnRules?.disallowAck) san = stripLeadingAck(san);

        san = scrubTrailingFillerAfterQuestion(san);
        san = scrubTrailingPoliteTail(san);
        san = scrubTrailingEndFillers(san);
        if (!san) return;

        if (san.includes("?")) s._pendingQuestion = false;
        else if (looksLikeQuestionStart(san)) s._pendingQuestion = true;
        else if (!isAckOnlyUtterance(san)) s._pendingQuestion = false;

        if (san.replace(/\[[^\]]+\]/g, "").trim().length < 3 && san.length < 20) return;

        if (san.includes("?")) {
          const qNorm = san.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
          if (lastQuestionChunk) {
            const prevNorm = lastQuestionChunk.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
            const qWords = qNorm.split(" ").filter((w) => w.length > 3);
            const prevWords = new Set(prevNorm.split(" ").filter((w) => w.length > 3));
            const overlap = qWords.filter((w) => prevWords.has(w)).length;
            if (
              Math.max(qWords.length, prevWords.size) > 0 &&
              overlap / Math.max(qWords.length, prevWords.size) >= 0.6
            ) {
              logger.info(`[${sessionId}] Duplicate question suppressed turn=${myTurnId}`);
              return;
            }
          }
          lastQuestionChunk = san;
        }

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}`);

        if (!firstChunkSent) {
          clearTimeout(thinkingFillerTimer);
          clearTimeout(backchannelTimer);
          backchannelTimer = null;
          firstChunkSent = true;

          const capturedText = san;
          const capturedTurnId = myTurnId;
          const fillerFired = thinkingFillerFired;

          this.getAudioStream(sessionId, capturedText)
            .then((resolvedStream) => {
              if (!resolvedStream) {
                const sf = this.sessions.get(sessionId);
                if (sf && !sf.isClosing && sf.activeTurnId === capturedTurnId) {
                  this.enqueueTTS(sessionId, capturedText);
                }
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
            })
            .catch(() => {
              const sf = this.sessions.get(sessionId);
              if (sf && !sf.isClosing && sf.activeTurnId === capturedTurnId) {
                this.enqueueTTS(sessionId, capturedText);
              }
            });
        } else {
          this.enqueueTTS(sessionId, san);
        }
      });

      chunker.minChunkLength = 10;
      chunker.maxChunkLength = 400;

      for await (const delta of this.openaiService.streamResponse(
        userText,
        systemPrompt,
        historyForModel,
        llmController.signal
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

      const aiTextClean = sanitizeForTTS(fullText);
      if (aiTextClean) {
        if (/^(?:\s*(?:oh\s+nice|mhm|mhmm|mm|okay\s+sure|okay,?\s+sure|okay|sure|right)\b)/i.test(aiTextClean.trim())) {
          session.lastAckTurn = myTurnId;
        }
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

        if (session._shouldHangupAfterTTS) {
          session._shouldHangupAfterTTS = false;
          this._hangupAfterTTSIdle(sessionId);
        }

        session.lastUserInputType = "qualification";
      }

      session.state.retriesCantHear = 0;
    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] _processWithLLM error: ${e.message}`);
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "TECH_ISSUES";
        }
      }
    } finally {
      if (thinkingFillerTimer) clearTimeout(thinkingFillerTimer);
      if (backchannelTimer) clearTimeout(backchannelTimer);

      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        if (s.activeTurnId === myTurnId) s.llmAbort = null;
      }
    }
  }

  async _hangupAfterTTSIdle(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isCleaning) return;

    session._finalHangupInProgress = true;
    session.currentStage = "wrapup";
    this._clearAllTimers(session);

    logger.info(`[${sessionId}] _hangupAfterTTSIdle — waiting for TTS to drain`);
    try {
      await this._waitForTTSIdle(sessionId, 10000);
    } catch { }

    logger.info(`[${sessionId}] _hangupAfterTTSIdle — TTS drained, ending call`);
    session.isClosing = true;
    await this.endTwilioCall(sessionId);
    await this.cleanupSession(sessionId, { endedBy: "negative_response" });
  }

  _parseAndUpdateQualificationState(session, userText, rawLLMText) {
    const qcMatch = (rawLLMText || "").match(/<QC>([\s\S]*?)<\/QC>/i);
    if (!qcMatch) {
      logger.warn(`[${session.id}] No QC block — using fallback parse`);
      this._fallbackParseFromAiText(session, userText, rawLLMText);
      return;
    }

    let qc;
    try {
      qc = JSON.parse(qcMatch[1].trim());
    } catch (e) {
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
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "NOT_INTERESTED";
        }
      } else if (q === 2) {
        st.govtCoverageChecked = false;
        st.qualified = false;
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
        }
      }

      session._shouldHangupAfterTTS = true;
      logger.info(`[${session.id}] QC fail q=${q} — hangup scheduled after TTS`);
      return;
    }

    if (result === "pass") {
      if (q === 1) {
        st.interestConfirmed = true;
        if (typeof next === "number" && next > 0) {
          session.currentQuestionNum = next;
        } else {
          session.currentQuestionNum = 2;
        }
        logger.info(`[${session.id}] Q1 pass`);
        return;
      }

      if (q === 2) {
        st.govtCoverageChecked = true;
        st.qualified = true;
        session.currentStage = "wrapup";
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "TRANSFERRED_TO_AGENT";
        }
        logger.info(`[${session.id}] Q2 pass → qualified`);
      }
    }
  }

  _fallbackParseFromAiText(session, userText, aiText) {
    const lower = String(aiText || "").toLowerCase();
    const uText = String(userText || "").toLowerCase();
    const st = session.state;
    const q = session.currentQuestionNum;

    if (q === 1 && st.interestConfirmed === null) {
      if (detectYesIntent(uText)) {
        st.interestConfirmed = true;
        session.currentQuestionNum = 2;
        logger.info(`[${session.id}] FALLBACK Q1 pass`);
        return;
      }

      if (detectQ1NegativeIntent(uText)) {
        st.interestConfirmed = false;
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "NOT_INTERESTED";
        }
        session._shouldHangupAfterTTS = true;
        logger.info(`[${session.id}] FALLBACK Q1 fail`);
        return;
      }
    }

    if (q === 2 && st.govtCoverageChecked === null) {
      if (/connect you|licensed specialist|licensed agent|transfer/i.test(lower)) {
        st.govtCoverageChecked = true;
        st.qualified = true;
        session.currentStage = "wrapup";
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "TRANSFERRED_TO_AGENT";
        }
        logger.info(`[${session.id}] FALLBACK Q2 pass → qualified`);
        return;
      }

      if (/thank you for your time|have a great day|do not qualify|not qualify/i.test(lower)) {
        st.govtCoverageChecked = false;
        st.qualified = false;
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
        }
        session._shouldHangupAfterTTS = true;
        logger.info(`[${session.id}] FALLBACK Q2 fail`);
      }
    }
  }

  _maybeAdvanceStage(session, rawLLMText) {
    if (session.currentStage !== "qualification") return;

    const lower = String(rawLLMText || "").toLowerCase();

    if (/connect you|licensed specialist|licensed agent|transfer/i.test(lower)) {
      session.state.qualified = true;
      session.currentStage = "wrapup";
      if (session.callLog && !session.callLog.disposition) {
        session.callLog.disposition = "TRANSFERRED_TO_AGENT";
      }
      logger.info(`[${session.id}] Stage → wrapup`);
    }
  }

  async _maybeTransferCall(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.transferAttempted || !session.state?.qualified) return;

    const callSid = session.callLog?.callSid;
    const buyerDid = String(session.campaign?.transferSettings?.number || "").trim();

    if (!callSid || !buyerDid) {
      logger.warn(`[${sessionId}] Transfer skipped — missing callSid or buyerDid`);
      if (session.callLog && !session.callLog.disposition) {
        session.callLog.disposition = "TECH_ISSUES";
      }
      return;
    }

    session.transferAttempted = true;
    session.transferPending = false;
    session.currentStage = "wrapup";

    if (session.callLog) {
      session.callLog.disposition = "TRANSFERRED_TO_AGENT";
    }

    logger.info(`[${sessionId}] TRANSFER → buyerDid=[MASKED]`);

    try {
      await this.twilioService.transferCall(callSid, buyerDid);
      logger.info(`[${sessionId}] Transfer successful`);
    } catch (e) {
      logger.error(`[${sessionId}] Transfer failed: ${e.message}`);
      if (session.callLog) session.callLog.disposition = "TECH_ISSUES";
    }
  }

  armMidCallSilence(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    this._clearTimer(session, "midCheck");
    this._clearTimer(session, "midHangup");

    this._setTimer(sessionId, "midCheck", MID_SILENCE_CHECK_MS, async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.isClosing || s.isCleaning || s.isSpeaking || s.isProcessingUtterance) return;
      if (s.currentStage === "wrapup" && s.transferAttempted) return;

      const sinceSpeech = Date.now() - (s.lastSpeechAt || 0);
      const sinceInterim = s.userSpeech?.lastInterimTime
        ? Date.now() - s.userSpeech.lastInterimTime
        : 999999;

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
    const sinceInterim = session.userSpeech?.lastInterimTime
      ? now - session.userSpeech.lastInterimTime
      : 999999;

    if (sinceSpeech > 8000 && sinceInterim > 8000) {
      if (st.lastCantHearAt && now - st.lastCantHearAt < CANT_HEAR_COOLDOWN_MS) {
        this.enqueueTTS(sessionId, "hey, are you still with me?", { flush: true });
      } else {
        st.retriesCantHear = (st.retriesCantHear || 0) + 1;
        st.lastCantHearAt = now;

        if (st.retriesCantHear <= CANT_HEAR_MAX_RETRIES) {
          const phrases = [
            "hey, are you still with me?",
            "hey, can you hear me okay?",
            "hey, I am not able to hear you - are you still there?",
          ];
          this.enqueueTTS(sessionId, phrases[(st.retriesCantHear - 1) % phrases.length], {
            flush: true,
          });
        } else {
          if (session.callLog && !session.callLog.disposition) {
            session.callLog.disposition = "NO_ANSWER";
          }
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

      const now2 = Date.now();
      const sinceSpeech2 = now2 - (ss.lastSpeechAt || 0);
      const sinceInterim2 = ss.userSpeech?.lastInterimTime
        ? now2 - ss.userSpeech.lastInterimTime
        : 999999;

      if (sinceSpeech2 < 3500 || sinceInterim2 < 3500 || ss.isSpeaking || ss.isProcessingUtterance) return;

      if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "NO_ANSWER";
      await this.politeHangup(sessionId, {
        finalMessage: "I am not able to hear you. I will try calling back another time. Have a good day.",
      });
    });
  }

  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

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

    session.isSpeaking = false;
    session.ttsQueue.length = 0;

    const us = session.userSpeech;
    if (us?.finalizeTimer) {
      clearTimeout(us.finalizeTimer);
      us.finalizeTimer = null;
    }
    if (us?.hardMaxTimer) {
      clearTimeout(us.hardMaxTimer);
      us.hardMaxTimer = null;
    }
    if (us?.bargeInConfirmTimer) {
      clearTimeout(us.bargeInConfirmTimer);
      us.bargeInConfirmTimer = null;
    }
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

  async endTwilioCall(sessionId) {
    const session = this.sessions.get(sessionId);
    const callSid = session?.callLog?.callSid;
    if (!callSid) return;
    await this.twilioService.endCallHard(callSid);
  }

  async politeHangup(sessionId, { finalMessage } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    session.currentStage = "wrapup";
    session.transferPending = false;
    session._finalHangupInProgress = true;
    this._clearAllTimers(session);

    try {
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);

      if (finalMessage) {
        this.enqueueTTS(sessionId, finalMessage, { flush: true });
        await this._waitForTTSIdle(sessionId, 12000);
      }
    } catch { }

    session.isClosing = true;
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

    try {
      this._clearAllTimers(session);
      this.stopTTS(sessionId);
    } catch { }

    try {
      this.deepgramService.closeTranscriptionStream(sessionId);
    } catch { }

    try {
      if (session.callLog) {
        const now = Date.now();

        if (!session.callLog.duration || session.callLog.duration === 0) {
          session.callLog.duration = Math.floor((now - session.startTime) / 1000);
        }
        session.callLog.endTime = session.callLog.endTime || new Date(now);

        const transcript = this._buildTranscriptForLog(session);
        if (transcript) session.callLog.transcript = transcript;

        if (Array.isArray(session.aiChunks) && session.aiChunks.length) {
          session.callLog.aiResponses = session.aiChunks.slice(-50);
        }

        const dispositionObj = buildDispositionObject(session, endedBy);

        if (!session.callLog.disposition) {
          session.callLog.disposition = dispositionObj.status;
        }

        session.callLog.dispositionDetail = {
          ...(session.callLog.dispositionDetail || {}),
          ...dispositionObj,
          status: session.callLog.disposition || dispositionObj.status,
        };

        if (session.state?.capturedAnswers) {
          session.callLog.capturedAnswers = session.state.capturedAnswers;
        }

        await session.callLog.save();
        logger.info(`[${sessionId}] Saved disposition=${dispositionObj.status}`);
      }
    } catch (e) {
      logger.error(`[${sessionId}] callLog save failed: ${e.message}`);
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
        logger.warn(`Cleaning inactive: ${sessionId}`);
        if (session.callLog && !session.callLog.disposition) {
          session.callLog.disposition = "NO_ANSWER";
        }
        this.cleanupSession(sessionId, { endedBy: "inactive_cleanup" });
      }
    }
  }
}

module.exports = MediaStreamHandler;