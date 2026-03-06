// MediaStreamHandler.js
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

function scrubTrailingFillerAfterQuestion(text) {
  let t = (text || "").trim();
  if (!t) return t;
  const qm = t.lastIndexOf("?");
  if (qm !== -1) {
    const after = t.slice(qm + 1).trim();
    if (!after) return t;
    const tailIsFiller = /^[\)\]\s.,;:-]*?(?:\(?\s*)?(?:oh|ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|okay|ok|sure|perfect|great|nice|cool)(?:\s*(?:nice|great|good|okay|ok|sure|perfect|right|cool))?(?:[\s,.;:-]+(?:oh|ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|okay|ok|sure|perfect|great|nice|cool)(?:\s*(?:nice|great|good|okay|ok|sure|perfect|right|cool))?)*[.!?\)\]]*\s*$/i.test(after);

    if (tailIsFiller) return t.slice(0, qm + 1).trim();
    return t;
  }
  if (looksLikeQuestionStart(t)) {
    t = t.replace(
      /(?:\s*[,.;-]\s*)(?:oh|ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|okay|ok|sure|perfect|great|nice|cool)(?:\s*(?:nice|great|good|okay|ok|sure|perfect|right|cool))?(?:\s*[,.;-]\s*(?:oh|ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|okay|ok|sure|perfect|great|nice|cool)(?:\s*(?:nice|great|good|okay|ok|sure|perfect|right|cool))?)*\s*$/i,
      ""
    ).trim();
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
        /^[\)\]\s.,-]*(?:\(?\s*)?(?:oh\s+)?(?:thanks?|thank\s+you|got\s+it|okay|ok|sure|right|mhm+|mm+|uh+|um+)[^a-z0-9]*$/i.test(after);
      if (tail) return t.slice(0, qm + 1).trim();
    }
  }
  t = t.replace(
    /(?:\s*[,.-]?\s*)(?:\[?[^\]]*\]?\s*)?(?:oh\s+)?(?:thank\s+you|thanks|got\s+it|okay|ok|sure)\.?\s*$/i,
    ""
  ).trim();

  return t;
}

function scrubTrailingEndFillers(text) {
  let t = (text || "").trim();
  if (!t) return t;

  const hasQuestion = t.includes("?");
  const bare = t.replace(/<[^>]+>/g, "").replace(/\[[^\]]+\]/g, "").trim();
  if (bare && FILLER_REGEX.test(bare)) return t;
  t = t
    .replace(
      hasQuestion
        ? /([?.!])\s*(?:,\s*)?(?:mhm+|mhmm+|mm+|hmm+|uh+|um+|erm+|ah+|oh+|right|okay|ok|sure)\b(?:\s*[?.!])?\s*$/i
        : /([?.!])\s*(?:,\s*)?(?:mhm+|mhmm+|mm+|hmm+|uh+|um+|erm+|ah+|oh+)\b(?:\s*[?.!])?\s*$/i,
      "$1"
    )
    .trim();
  t = t
    .replace(/\s*(?:,\s*)?(?:mhm+|mhmm+|mm+|hmm+|uh+|um+|erm+|ah+)\b\s*$/i, "")
    .trim();
  t = t.replace(/[\s,]+$/g, "").trim();
  return t;
}

function isAckOnlyUtterance(text) {
  const raw = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!raw) return false;
  if (raw.includes("?")) return false; 
  const wc = raw.split(/\s+/).filter(Boolean).length;
  if (wc > 6) return false;

  return /^(?:oh\s+nice|oh\s+yeah|oh\s+okay|oh\s+sure|nice|great|perfect|cool|right|okay|ok|sure|mhm+|mhmm+|mm+|hmm+|uh\s*huh|uh-huh|yeah|yea|yep|yup|alright)(?:\s*[,.;-]\s*(?:oh\s+nice|nice|great|perfect|cool|right|okay|ok|sure|mhm+|mhmm+|mm+|hmm+|uh\s*huh|uh-huh|yeah|yea|yep|yup|alright))*[.!?]*$/i.test(raw);
}
function looksLikeQuestionStart(text) {
  const t = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;
  if (t.includes("?")) return true;
  const start = t.toLowerCase();
  if (/^(?:is|are|was|were|do|does|did|can|could|would|will|have|has|had|may|might|should)\b/.test(start)) return true;
  if (/^(?:what|why|how|when|where|who|which)\b/.test(start)) return true;
  if (/\b(?:how old|zip code|household income|are you currently|do you have)\b/i.test(t)) return true;

  return false;
}

function buildKeyAck(field, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (field === "zip") return `okay, so your zip code is ${v}.`;
  return "";
}

function keyEchoAlreadyPresent(text, field, value) {
  const t = (text || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  if (!t) return false;
  if (field === "zip") {
    if (v && t.includes(v)) return true;
    return /\bzip\b|\bzip\s+code\b/.test(t);
  }
  return false;
}


function stripLeadingAck(text) {
  let t = (text || "").trim();
  if (!t) return t;
  if (/^<QC>/i.test(t)) return t;
  t = t.replace(
    /^(\[[^\]]+\]\s*)?(?:oh\s+nice|oh\s+sure|oh\s+okay|oh\s+yeah|yeah,\s+got\s+it|mhm|mhmm|mm|okay\s+sure|okay|sure|right)\.?\s*/i,
    ""
  ).trim();

  return t;
}
function stripDisallowedSocial(text) {
  let t = (text || "");
  t = t.replace(/\bI am doing well\b[^.?!]*[.?!]?/gi, "").replace(/\bthanks for asking\b[^.?!]*[.?!]?/gi, "");
  t = t.replace(/\bI am well\b[^.?!]*[.?!]?/gi, "");
  return t.trim();
}

function containsReciprocalQuestion(text) {
  const t = (text || "").toLowerCase();
  return /(\band you\b|\bwhat about you\b|\bhow about you\b|\bhow are you\b|\bwhat about yourself\b)/i.test(t);
}
function buildForcedSocialReply(utterance) {
  const asked = containsReciprocalQuestion(utterance);
  if (asked) return "[laughs softly] oh I am doing well, thanks for asking.";
  return "[laughs softly] oh nice, glad to hear that.";
}
function buildOpeningBridgeMessage(utterance) {
  const tone = detectToneHint(utterance);
  const askedBack = containsReciprocalQuestion(utterance) || isSocialResponse(utterance);
  let socialLine = "[laughs softly] ";
  if (askedBack && containsReciprocalQuestion(utterance)) {
    socialLine += "oh I am doing well, thanks for asking.";
  } else if (tone === "negative") {
    socialLine += "oh I am sorry to hear that.";
  } else if (tone === "hostile") {
    socialLine += "okay.";
  } else {
    socialLine += "oh nice, glad to hear that.";
  }
  const reasonAndQ1 =
    "so.. I am calling to offer you a no-obligation, no-cost health insurance plan quote designed for individuals under sixty-five. " +
    "and I just want to let you know so you are aware that some of our premium plans involve a modest low charge. " +
    "In order to activate coverage, the insurance company may require a small binder payment. " +
    "um <break time=\"300ms\"/> I just need to ask a few quick questions to see if you may qualify. " +
    "So uh <break time=\"300ms\"/> just to start - how old are you?";

  return `${socialLine} ${reasonAndQ1}`.trim();
}

function detectToneHint(utterance) {
  const t = (utterance || "").toLowerCase();
  if (!t) return "neutral";
  if (/(hate|stupid|idiot|shut up|fuck|f\*+k|bitch|asshole|scam|lawsuit|report|angry|mad)/i.test(t)) return "hostile";
  if (/(sad|depressed|cry|sick|pain|hospital|broke|lost my job|unemployed|no money|evicted|funeral|died)/i.test(t)) return "negative";
  if (/(good|fine|great|awesome|amazing|happy|doing well|not bad|pretty good|fantastic|love)/i.test(t)) return "positive";
  return "neutral";
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
    capturedAnswers: st.capturedAnswers || {},
    endedBy: endedBy || "unknown",
    durationMs: Date.now() - (session.startTime || Date.now()),
    transcriptSummary: transcript.slice(0, 400),
  };
}

// ─── RUNTIME PROMPT ───────────────────────────────────────────────────────
function buildCompressedRuntimePrompt() {
  return `========================================
ACA QUALIFICATION VOICE AGENT — Matt
========================================

You are Matt - calm, warm, quietly friendly. Never formal. Slight smile in every sentence.
You qualify customers for ACA health insurance and warm-transfer qualified leads to licensed agents.

## MANDATORY: QC BLOCK — ALWAYS FIRST, BEFORE YOUR SPOKEN RESPONSE
Every response MUST begin with a QC block. Token limits cut the END of responses — QC first guarantees capture.
Format: <QC>{"q":<currentQ>,"result":"<pass|fail|skip>","next":<nextQ>,"field":"<zip|fullName|null>","value":"<value or null>"}</QC>
- pass = answered and qualifies → advance
- fail = does not qualify → call ends
- skip = not answered → stay on same Q

Examples:
<QC>{"q":1,"result":"pass","next":2,"field":null,"value":null}</QC> okaaay, so. And uh <break time="300ms"/> is your income over sixteen thousand a year?
<QC>{"q":4,"result":"fail","next":4,"field":null,"value":null}</QC> Since you have coverage through your employer, you are all set. Thank you.
<QC>{"q":2,"result":"skip","next":2,"field":null,"value":null}</QC> okay so, I was asking - is your household income more than sixteen thousand a year?

## HARD RULES (every response, no exceptions)
1. NO exclamation marks. Periods only.
2. NO contractions. Full words: "I am", "do not", "can not", "will not".
3. NO dash symbol —. Use hyphen - instead.
4. NO transition announcements: never say "next question", "moving on".
5. Write numbers as words: "twenty five" not "25".
6. NO square brackets of any kind.
7. Every "um" or "uh" MUST be followed by <break time="300ms"/>.

## GLOBALLY FORBIDDEN WORDS
Affirmations: "I see." / "I understand." / "Got it." / "I got it." / "That makes sense." / "Understood." / "Noted."
Casual dismissals: "My bad." / "No worries."
Enthusiasm words: "Great" / "Perfect" / "Excellent" / "Awesome" / "Amazing"

## VOICE TONE
Maintain one consistent tone: calm, warm, quiet, friendly — from greeting to transfer.
- Energy stays flat and steady. No spikes, no drops, no trailing off.
- Speak like a relaxed, helpful person having a normal conversation.

## STATE MEMORY (CRITICAL)
Track every answer given. Once answered, never re-ask.
- If customer volunteers a future answer early, log it and skip that question when reached.
- After any interruption or tangent, resume from the exact question that was paused. Never restart from Q1. Never skip forward past unanswered questions.

## ANSWER ISOLATION (CRITICAL)
Each question maps to exactly one answer slot. A long answer to Q2 does NOT answer Q3 or Q4.
- If a customer's answer touches multiple topics, confirm each remaining question individually.
- Never infer or carry over an answer to a different question slot. When in doubt, confirm before advancing.

## ACKNOWLEDGMENT + TRANSITION (after every qualifying answer)
Step 1 — Acknowledge using one phrase from the rotation below. Never repeat back-to-back.
Step 2 — Connect into next question using one bridge: "And uh <break time="300ms"/> [Q]" / "So uh <break time="300ms"/> [Q]" / "okay so, [Q]"

ROTATION LIBRARY:
| Type       | Phrases |
|------------|---------|
| Filler     | "mm-hmm." / "uh-huh." / "mm-hmm, mm-hmm." / "uh-huh, mm-hmm." |
| Stretch    | "okaaay." / "suure." / "mm-hmm, okaaay." / "uh-huh, suure." |
| Got-it     | "mm-hmm, got it." / "uh-huh, got it." / "okaaay, got it." / "suure, got it." |
| Filler-first | "mm-hmm, right." / "mm-hmm, suure thing." / "uh-huh, suure." |

Rules: Base on "mm-hmm" / "uh-huh". Always pair "okay" with a filler — never alone. "alright" max once every 4-5 turns.

## INTERRUPTION + CLARIFICATION HANDLING
When customer interrupts, asks a question, or says "what do you mean?":
1. QC block: result=skip, q=<pausedQ>, next=<pausedQ>.
2. Respond briefly (1-2 sentences) — casual, warm.
3. Lead with a hesitation filler: "oh uh <break time="300ms"/> yeah..." or "oh, so..."
4. Re-ask using a CONNECTING BRIDGE. Never restart the question cold.
   WRONG: "How old are you?"
   RIGHT: "okay so, I was asking - how old are you?"
   RIGHT: "mhm, so where I was - is your income more than sixteen thousand a year?"
5. "hold on" / "wait" / "one sec" → "oh suure, take your time." STOP.

CLARIFICATION QUICK ANSWERS (one casual sentence, then bridge back):
- Age: "oh yeah, I just need to know how old you are to make sure the plan fits your age group."
- Income: "oh yeah, just roughly how much money comes in per year for your household - does not have to be exact."
- Government coverage: "oh yeah, I am just asking if you are on any government health programs like Medicare or Medicaid."
- Employer coverage: "oh yeah, I am just asking if your job gives you health insurance as a benefit."
- Subsidy card: "oh yeah, I just want to make sure we are talking about health insurance plans, not gift cards or anything like that."
- AI/robot question: "ha, that is a good one. But let me get back to seeing if you qualify."
- "How to answer": restate in simpler words with one example.

## SILENCE (5-6 full seconds only)
Rotate: "hey, are you still with me?" / "hey, can you hear me okay?" / "hey, I am not able to hear you - are you still there?"
After 2 failed attempts: "I am not able to hear you. I will try calling back another time. Have a good day." END.

## BARGE-IN MID-SENTENCE
If customer cuts in while Matt is mid-word or mid-sentence:
1. Stop speaking immediately.
2. QC block: result=skip, q=<pausedQ>, next=<pausedQ>.
3. Follow INTERRUPTION HANDLING above.

---

## STAGE 1: OPENING (Parts 1, 2, 3 in strict order — never ask Q1 until all three delivered)
Part 1: [Warm greeting]
Part 2: "so.. I am calling to offer you a no-obligation, no-cost health insurance plan quote designed for individuals under sixty-five. and i just wanna let you know so you are aware that some of our premium plans involve a modest low charge. In order to activate coverage, the insurance company may require a small binder payment."

Part 3: "um I just need to ask a few quick questions to see if you may qualify."

POST-GREETING: If customer asks "how are you" or similar —
SENTENCE 1: "oh I am doing well, thanks for asking."
SENTENCE 2: Immediately ask Q1. Never reverse order.
NEVER re-introduce yourself once greeting is complete (GREETING_COMPLETE=true).

---

## STAGE 2: QUALIFICATION (Q1-Q4, strict order)
After each PASS: ack from ROTATION LIBRARY → next question via TRANSITION PATTERN.

Q1 — Age
ASK: "So uh <break time="300ms"/> just to start - how old are you?"
PASS (age 1-64): ack → Q2.
FAIL (65+): "I am sorry, but we can only help individuals under sixty-five. but Thank you for your time." END.

Q2 — Income
ASK: "And uh <break time="300ms"/> is your- yeah, is your household income more than sixteen thousand a year?"
PASS (yes): ack → Q3.
FAIL (no): "Oh, um I am sorry then, but we are not able to assist you at this time. Thank you." END.

Q3 — Government coverage
ASK: "And um <break time="300ms"/> are you currently on Medicare, Medicaid, Tricare, or any VA coverage?"
PASS (no): ack → Q4.
FAIL (yes): "oh Since you are already covered under that program, we will not be able to assist you today. but Thank you for your time." END.

Q4 — Employer coverage
ASK: "And um <break time="300ms"/> do you have health insurance through your employer or your job?"
PASS (no): ack → Q5.
FAIL (yes): "Since you have coverage through your employer, you are all set. Thank you." END.

---

## STAGE 3: PRE-TRANSFER (locked order — never skip any step)

Step 1 — MANDATORY (say word for word):
"okay so, um <break time="300ms"/> it looks like- yeah, it looks like you might qualify for a better health insurance plan under the Affordable CareAct. That is good news. so I just need a two more quick things from you."

Step 2 — Zip code:
ASK: "Um <break time="300ms"/> can you confirm your zip code for me please?"
- Five digits → "okaaay, got that." → Step 3.
- Four digits → "oh, I think I caught four digits there - one digit might be missing. Could you say your zip code one more time?"
- Three digits → "oh, I only caught three digits there - two digits seem to be missing. Could you give me your full zip code again?"
- Any other count → "oh, let me get that again - zip codes are five digits. Could you repeat yours for me?"
Never accept an incomplete zip code.

Step 3 — Full name:
ASK: "Ok Last thing, can i have your full name, please?"
Echo FIRST NAME ONLY immediately: "alright, [FirstName] - thanks, lets keep moving."
NEVER repeat the full name. NEVER skip this echo.

Step 4 — Transition:
SAY: "Okay [FirstName] so, before I connect you to a licensed agent, I just need to quickly read a brief disclaimer."
Immediately move to Stage 4. Do not pause.

---

## STAGE 4: DISCLAIMER (read clean — no fillers, no break tags)
"By moving forward, you are giving electronic consent for marketing purposes, which is the same as written consent. This allows us to share information even if you are on a do-not-call list. Your consent is not required to buy anything, and you can revoke it at any time. Does that make sense?"

If yes: "Okaayyy perfect. So I am connecting you to a licensed expert now. Please remember we are just providing no obligation health insurance quotes. You will be connected in about five seconds."
If customer asks a question during/after disclaimer: answer briefly and warmly, then continue to transfer. Do not restart the disclaimer.

---

## OBJECTION HANDLING

Not Interested: "oh uh <break time="300ms"/> yeah, I totally get that. The only reason I am calling is to check if you qualify for more affordable coverage. Would you be open to just seeing if you might save money?"
  If insists: "okay, no problem. Have a good day." END.

Busy: "oh uh <break time="300ms"/> my bad, sorry to bother you at the wrong time. Let me reach you back some other time - thanks for your time, good bye."

Already insured: "oh uh <break time="300ms"/> yeah, that is great. A lot of people still qualify for more affordable options even if they are already covered. Would you be open to a quick review?"
  If firmly no: "um oh okay, I appreciate your time. Have a good day." END.

Cost concerns: "yeah, there is no cost for this call or the review. The licensed agent will explain any costs before you decide anything. Many people qualify for plans with very low or even zero dollar premiums."

Scam concerns: "oh uh <break time="300ms"/> yeah, that is a fair thing to ask. Well, we are not the government and we are not collecting any payment info. We just connect you with licensed insurance agents. You can ask them for their license number directly when you speak with them."
  If still uncomfortable: "I hear you. We can end the call here - you can always contact a licensed local agent on your own." END.

Send info first: "oh yeah, I can note that, but ACA options depend on your specific details. The best way is to speak briefly with a licensed agent - it only takes a few minutes. Would you be open to that?"

Does not want to give info: "oh yeah, I respect that. We only need basics like age, zip code, and approximate income - no payment details. Without this info the agent will not be able to check your eligibility accurately."

Is this the government: "oh no, we are not a government agency. We work with licensed insurance agents who are authorized to help people enroll in ACA health plans."

What is ACA: "oh suure. So the Affordable Care Act is a federal program that helps people find low cost or no cost health insurance. Depending on your income and household size, you could qualify for a plan with very low monthly premiums - sometimes even zero dollars."

What kind of plans: "oh suure. The licensed agent will go over the specific plan options with you. They cover things like doctor visits, prescriptions, emergency care, and more. The agent will match you with what fits your situation."

How long does this take: "oh it is pretty quick. I just have a couple more questions and then I will connect you to a licensed agent - usually takes just two minutes total." Then continue with the question you were on.

DNC request: "Of course, I will make sure we do not contact you again. Thank you. Have a good day." END IMMEDIATELY.

Wrong person: "oh sorry about that. I will update our records. Have a good day." END.

---

## QC BLOCK REMINDER
QC block goes FIRST in every response — before spoken words.`
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
const THINKING_FILLER_THRESHOLD_MS = 999999;
const TRANSFER_DELAY_MS            = 5500;
const TTS_QUEUE_MAX_DEPTH          = 6;  
const AUDIO_BUFFER_MAX_BYTES       = 200000;
const TWILIO_READY_WAIT_MAX_MS     = 8000;  

const ACK_TO_QUESTION_PAUSE_MS     = 380;
const POST_GREETING_LISTEN_MS      = 600;
const BACKCHANNEL_FILLER_MS        = 300;
const BACKCHANNEL_FILLERS          = ["mm.", "oh.", "mhm.", "right."];

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
    this._cleanupInterval = setInterval(() => this.cleanupInactiveSessions(), 30000);
    this._heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
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
      hasRealInput:          false,  
      _pendingQuestion:      false,  
      greetingCompletedAt:   0,     
      initialGreetingSent:   false,
      needsOpeningBridge: false,
      openingBridgeDone: false,
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
      pausedQuestionNum:     null,   
      digressionCount:       0,     
      state: {
        qualified:                false,
        zip:                      "",
        fullName:                 "",
        retriesCantHear:          0,
        lastCantHearAt:           0,
        capturedAnswers:          {},
        ageQualified:             null,
        incomeQualified:          null,
        zipCollected:             false,
        govCoverageQualified:     null,
        employerCoverageQualified: null,
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
        s.openingComplete = true;
        s.currentStage = "opening_bridge";
        s.currentQuestionNum = 1;
        s.needsOpeningBridge = true;
        s.openingBridgeDone = false;
        s.greetingCompletedAt = Date.now();
        logger.info(`[${sessionId}] Opening done → opening_bridge (reason + Q1 next)`);
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
          ss.openingComplete = true;
          ss.currentStage = "opening_bridge";
          ss.currentQuestionNum = 1;
          ss.needsOpeningBridge = true;
          ss.openingBridgeDone = false;
          ss.greetingCompletedAt = Date.now();
          logger.info(`[${sessionId}] Fallback greeting done → opening_bridge (reason + Q1 next)`);
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
    if (session.openingComplete && session.needsOpeningBridge && !session.openingBridgeDone) {
      const bridge = safeTTS(buildOpeningBridgeMessage(utterance), 720);
      session.needsOpeningBridge = false;
      session.openingBridgeDone = true;

      session.currentStage = "qualification";
      session.currentQuestionNum = 1;
      session.lastUserInputType = "opening_bridge";
      session.conversationHistory.push({ role: "user", content: utterance });
      session.conversationHistory.push({ role: "assistant", content: sanitizeForTTS(bridge) });
      session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

      session.aiChunks.push(sanitizeForTTS(bridge));
      if (session.aiChunks.length > 120) session.aiChunks.shift();

      session.hasRealInput = true;

      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
      this.enqueueTTS(sessionId, bridge, { flush: true });

      logger.info(`[${sessionId}] OPENING_BRIDGE spoken → awaiting Q1(age) answer`);
      this.armMidCallSilence(sessionId);
      return;
    }

    // Classify input type + per-turn flow rules (v21)
    session.turnRules = session.turnRules || {};
    session.turnRules.forcedPrefix = null;
    session.turnRules.disallowAck = false;
    session.turnRules.disallowSocial = false;
    session.turnRules.disableBackchannel = false;

    const toneHint = detectToneHint(utterance);
    if (session.openingComplete && (isSocialResponse(utterance) || containsReciprocalQuestion(utterance))) {
      session.lastUserInputType = "social";
      session.turnRules.forcedPrefix = buildForcedSocialReply(utterance);
      session.turnRules.disallowAck = true;      
      session.turnRules.disallowSocial = true;   
      session.turnRules.disableBackchannel = true;
      logger.info(`[${sessionId}] Social/reciprocal detected. Forced prefix: "${session.turnRules.forcedPrefix}" | utterance="${utterance}"`);
    } else if (session.openingComplete && isDigression(utterance)) {
      session.lastUserInputType = "digression";
      session.turnRules.disallowAck = true; 
      if (session.pausedQuestionNum === null) {
        session.pausedQuestionNum = session.currentQuestionNum;
        session.digressionCount += 1;
        logger.info(`[${sessionId}] Digression detected — pausing at Q${session.pausedQuestionNum}: "${utterance}"`);
      }
    } else {
      session.lastUserInputType = "qualification";
      const words = utterance ? utterance.trim().split(/\s+/).filter(Boolean).length : 0;
      const longAnswer = words >= 8;
      const emotional = toneHint === "positive" || toneHint === "negative" || toneHint === "hostile";
      const lastAckTurn = session.lastAckTurn || 0;
      const turnsSinceAck = session.activeTurnId - lastAckTurn;

      const allowAck = (turnsSinceAck >= 3) && (longAnswer || emotional);

      session.turnRules.disallowAck = !allowAck;
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
    if (st.zip)
      answeredQs.push(`Q3(zip):${st.zip}`);
    if (st.govCoverageQualified !== null)
      answeredQs.push(`Q4(govCoverage):${st.govCoverageQualified ? "pass" : "fail"}`);
    if (st.employerCoverageQualified !== null)
      answeredQs.push(`Q5(employerCoverage):${st.employerCoverageQualified ? "pass" : "fail"}`);
    if (st.fullName)
      answeredQs.push(`fullName:${st.fullName}`);

    const awaitLabel = session.awaitingAnswerFor ? `;collecting=${session.awaitingAnswerFor}` : "";

    let inputInstruction = "";
    if (session.lastUserInputType === "social") {
      const forced = session.turnRules && session.turnRules.forcedPrefix;

      if (forced) {
        inputInstruction = [
          `INPUT_TYPE=SOCIAL_RESPONSE`,
          `SOCIAL_REPLY_ALREADY_SPOKEN=true`,
          `DO NOT include any social reply like "I am well" or "thanks for asking".`,
          `DO NOT include any acknowledgment like "oh nice" or "mhm".`,
          `ONLY output: <QC>...</QC> then the CURRENT qualification question.`,
          `Customer said: "${session._lastUtterance || ""}"`,
        ].join("\n");
      } else {
        inputInstruction = [
          `INPUT_TYPE=SOCIAL_RESPONSE — Customer gave a warm social reply.`,
          `MANDATORY SENTENCE ORDER:`,
          `  1. Social reply FIRST (react to what they said).`,
          `  2. Question SECOND (ask the CURRENT qualification question).`,
          `NEVER put the question before the social reply. Nothing after the question.`,
          `Customer said: "${session._lastUtterance || ""}"`,
        ].join("\n");
      }
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
      `questionsAnswered: [${answeredQs.length ? answeredQs.join(", ") : "none yet"}]`,
      `qualified: ${Boolean(st.qualified)}${awaitLabel}`,
      `ACK_ALLOWED: ${!session?.turnRules?.disallowAck}`,
      `SOCIAL_ALLOWED: ${!session?.turnRules?.disallowSocial}`,
      `INSTRUCTION: Stage="${session.currentStage}". Next Q=Q${session.currentQuestionNum}. Never re-ask answered Qs. Never skip Qs. START your response with the QC block first, then speak.`,
      `---`,
    ]
      .filter(Boolean)
      .join("\n");

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
    let thinkingFillerTimer = null;
    let backchannelTimer = null;
    let qcParsedForTurn = null;
    let keyAckForTurn = null;
    let keyAckInjected = false;

    try {
      const systemPrompt    = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(
        `[${sessionId}] LLM_START turn=${myTurnId} stage=${session.currentStage}` +
        ` Q=${session.currentQuestionNum} inputType=${session.lastUserInputType}`
      );

      session._pendingQuestion = false;
      if (session.turnRules && session.turnRules.forcedPrefix) {
        const prefix = safeTTS(session.turnRules.forcedPrefix);
        if (prefix) {
          logger.info(`[${sessionId}] Forced social prefix → "${prefix}"`);
          session.lastAckTurn = myTurnId;
          this.enqueueTTS(sessionId, prefix);
        }
      }

      let fullText        = "";
      let firstTokenAt    = 0;
      let firstChunkSent  = false;
      let firstTTSPromise = null;
      let firstTTSText    = null;
      if (llmController.signal.aborted) return;
      const isSocialTurn = (session.lastUserInputType === "social") && !(session.turnRules && session.turnRules.disableBackchannel);
      if (isSocialTurn) {
        backchannelTimer = setTimeout(() => {
          const s = this.sessions.get(sessionId);
          if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
          const bc = BACKCHANNEL_FILLERS[myTurnId % BACKCHANNEL_FILLERS.length];
          logger.info(`[${sessionId}] BACKCHANNEL turn=${myTurnId}: "${bc}"`);
          this.enqueueTTS(sessionId, bc);
        }, BACKCHANNEL_FILLER_MS);
      }

      thinkingFillerTimer = setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
        if (s.lastUserInputType === "social") return;
        const q = s.currentQuestionNum;
        const fillers = q <= 2
          ? ["mhm.", "right."]
          : q <= 5
          ? ["mhm.", "okay."]
          : ["mhm.", "sure."];
        if (!fillers.length) return;
        const filler = fillers[myTurnId % fillers.length];

        thinkingFillerFired = true;
        logger.info(`[${sessionId}] THINKING_FILLER turn=${myTurnId}`);
        this.enqueueTTS(sessionId, filler);
      }, THINKING_FILLER_THRESHOLD_MS);

      const chunker = new SentenceChunker((sentence) => {
        const s = this.sessions.get(sessionId);
        if (!s || s.activeTurnId !== myTurnId || llmController.signal.aborted) return;

        let sanitized = safeTTS(sentence);
        if (!sanitized) return;
        const s0 = this.sessions.get(sessionId);
        if (s0 && s0._pendingQuestion && isAckOnlyUtterance(sanitized)) return;

        if (s0 && s0.turnRules && s0.turnRules.disallowSocial) sanitized = stripDisallowedSocial(sanitized);
        if (s0 && s0.turnRules && s0.turnRules.disallowAck) sanitized = stripLeadingAck(sanitized);

        sanitized = scrubTrailingFillerAfterQuestion(sanitized);
        sanitized = scrubTrailingPoliteTail(sanitized);
        sanitized = scrubTrailingEndFillers(sanitized);
        if (!sanitized) return;
        if (s0) {
          if (sanitized.includes("?")) s0._pendingQuestion = false;
          else if (looksLikeQuestionStart(sanitized)) s0._pendingQuestion = true;
          else if (!isAckOnlyUtterance(sanitized)) s0._pendingQuestion = false;
        }        if (!keyAckInjected && keyAckForTurn && !keyEchoAlreadyPresent(sanitized, keyAckForTurn.field, keyAckForTurn.value)) {
          const ack = safeTTS(buildKeyAck(keyAckForTurn.field, keyAckForTurn.value), 220);
          if (ack) {
            sanitized = `${ack} ${sanitized}`.trim();
            sanitized = scrubTrailingFillerAfterQuestion(sanitized);
            sanitized = scrubTrailingPoliteTail(sanitized);
            sanitized = scrubTrailingEndFillers(sanitized);
          }
          keyAckInjected = true;
        }
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

      chunker.minChunkLength = 10;  
      chunker.maxChunkLength = 300;

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
        if (!qcParsedForTurn && fullText.includes("</QC>")) {
          const m = fullText.match(/<QC>([\s\S]*?)<\/QC>/i);
          if (m) {
            try {
              const qcObj = JSON.parse(String(m[1] || "").trim());
              qcParsedForTurn = qcObj;
              const field = qcObj?.field;
              const value = qcObj?.value;
              if (field === "zip" && value && value !== "null") {
                keyAckForTurn = { field, value: String(value).trim() };
              }
            } catch {}
          }
        }

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
      if (aiTextClean) {
        const startsWithAck = /^(?:\s*(?:oh\s+nice|mhm|mhmm|mm|okay\s+sure|okay,?\s+sure|okay|sure|right)\b)/i.test(aiTextClean.trim());
        if (startsWithAck) session.lastAckTurn = myTurnId;
      }

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
    if (field && value && value !== "null" && value !== null) {
      const cleanValue = String(value).trim();

      if (field === "zip" && /^\d{5}$/.test(cleanValue)) {
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

    if (result === "fail") {
      logger.info(`[${session.id}] Q${q} FAIL — NOT_QUALIFIED`);
      if (q === 1) st.ageQualified               = false;
      if (q === 2) st.incomeQualified             = false;
      if (q === 4) st.govCoverageQualified        = false;
      if (q === 5) st.employerCoverageQualified   = false;
      if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      return;
    }

    // ── pass ──────────────────────────────────────────────────────────────
    if (result === "pass") {
      if (q === 1) { st.ageQualified             = true; }
      if (q === 2) { st.incomeQualified           = true; }
      if (q === 3) { st.zipCollected              = true; }
      if (q === 4) { st.govCoverageQualified      = true; }
      if (q === 5) {
        st.employerCoverageQualified = true;
        st.qualified             = true;
        session.currentStage     = "preTransfer";
        logger.info(`[${session.id}] Q5 pass → QUALIFIED → preTransfer`);
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
      if (/zip code|zip/i.test(lower)) {
        st.incomeQualified = true; session.currentQuestionNum = 3;
        logger.info(`[${session.id}] FALLBACK Q2 → Q3`);
      } else if (/not able to assist|cannot assist/i.test(lower)) {
        st.incomeQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }

    if (q === 3 && !st.zipCollected) {
      if (/medicare|medicaid|tricare|va coverage/i.test(lower)) {
        st.zipCollected = true; session.currentQuestionNum = 4;
        logger.info(`[${session.id}] FALLBACK Q3 → Q4`);
      }
    }

    if (q === 4 && st.govCoverageQualified === null) {
      if (/employer|through.*job|through.*work|health insurance.*job/i.test(lower)) {
        st.govCoverageQualified = true; session.currentQuestionNum = 5;
        logger.info(`[${session.id}] FALLBACK Q4 → Q5`);
      } else if (/already covered|not able to assist/i.test(lower)) {
        st.govCoverageQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }

    if (q === 5 && st.employerCoverageQualified === null) {
      if (/it looks like.*qualify|affordable care act/i.test(lower)) {
        st.employerCoverageQualified = true;
        st.qualified             = true;
        session.currentStage     = "preTransfer";
        logger.info(`[${session.id}] FALLBACK Q5 → QUALIFIED`);
      } else if (/coverage through your employer|you are all set/i.test(lower)) {
        st.employerCoverageQualified = false;
        if (session.callLog) session.callLog.disposition = "NOT_QUALIFIED";
      }
    }
  }

  _detectAndSetQuestionLock(session, rawLLMText) {
    const qcMatch = (rawLLMText || "").match(/<QC>([\s\S]*?)<\/QC>/i);
    if (!qcMatch) return;
    let qc;
    try { qc = JSON.parse(qcMatch[1].trim()); } catch { return; }

    const { field, value } = qc;
    const st = session.state;

    if (field === "zip" && !st.zip && !session.awaitingAnswerFor) {
      session.awaitingAnswerFor = "zip";
      logger.info(`[${session.id}] Question lock → zip`);
    } else if (field === "fullName" && !st.fullName && !session.awaitingAnswerFor) {
      session.awaitingAnswerFor = "fullName";
      logger.info(`[${session.id}] Question lock → fullName`);
    }

    if (field && value && value !== "null") {
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
      const now2          = Date.now();
      const sinceSpeech2  = now2 - (ss.lastSpeechAt || 0);
      const sinceInterim2 = ss.userSpeech?.lastInterimTime
        ? now2 - ss.userSpeech.lastInterimTime : 999999;
      if (sinceSpeech2 < 3500 || sinceInterim2 < 3500 || ss.isSpeaking || ss.isProcessingUtterance) return;
      if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "UNRESPONSIVE";
      await this.politeHangup(sessionId, {
        finalMessage: "I am not able to hear you. I will try calling back another time. Have a good day.",
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