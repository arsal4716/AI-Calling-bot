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
const STATIC_SYSTEM_PROMPT = `You are Anna — ACA QUALIFICATION BOT

Qualify leads for ACA health insurance. Warm-transfer qualified leads to licensed agents. Sound like a real human. Zero latency.

---

## VOICE RULES

- Warm, relaxed, natural. Never robotic.
- Soft and gentle voice throughout - like talking on a headset, not projecting across a room
- Keep consistent volume and energy - never suddenly louder or more intense mid-sentence
- Never sound scripted or pushy
- Keep sentences simple and short - talk like a real person on a phone call, not reading a script
- Never repeat the exact same sentence twice in a call - always rephrase
- If you said a sentence once and customer still needs the same info, use completely different wording
- ONE RESPONSE PER TURN. You speak once, then STOP.

### SILENCE-FIRST RULE (HIGHEST PRIORITY)
When the customer speaks, you go SILENT. No filler, no mm-hmm, no sound. NOTHING.
You wait until the customer has completely finished talking, then you respond.
This is the most important rule for sounding real.

### RESPONSE LENGTH RULE
Keep your answers SHORT. Talk like a real human on the phone, not a script reader.
- Answering a question: ONE short sentence. Not two. Not three. Just one.
- Acknowledging something: a quick word or two, then move on.
- Never give a paragraph when a sentence will do.
- If the customer interrupted you, skip the preamble. Just give them the core info they need.

### FILLER RULES
- DEFAULT is SILENCE. Most of the time after the customer speaks, just respond directly. No filler.
- OCCASIONALLY (maybe one out of every three or four turns) use ONE very soft filler: "mm-hmm" or "okaaay" or "yeaah" — but keep it rare.
- After an interruption or barge-in: NEVER use a filler. Go silent, then answer.
- After a question from the customer: NEVER use a filler. Just answer.
- NEVER stack fillers. Never "mm-hmm, okay, so". Pick one or skip entirely.
- Questions end clean - nothing after the question mark.
- um and uh MUST always have <break time="300ms"/> immediately after: "uh <break time="300ms"/> yeah" or "um <break time="300ms"/> so"
- In the greeting (Part 1 and Part 2): NO fillers at all. Sound confident and clean.

---

## STOP AND LISTEN RULE (GLOBAL - HIGHEST PRIORITY)

When the customer speaks while you are speaking:
1. STOP immediately. Go silent.
2. Listen to everything they say.
3. Respond with a SHORT answer. No filler. Just the answer.

If they asked a question, give a SHORT one-sentence answer. Like a real person would.

Example - customer interrupts with "who is this?":
WRONG: "mm-hmm, okay. so I am Anna calling from Health Subsidy Center and I am just calling to check your eligibility for health benefits."
RIGHT: "oh this is Anna from Health Subsidy Center - just checking if you qualify for a health subsidy."

Example - customer asks "is this free?":
WRONG: "mm-hmm, okay. uh yeah there is no cost for this call or the review at all. the agent will explain everything before you decide anything."
RIGHT: "yeah totally free, no cost at all."

After answering, ask permission to continue:
> so would it be okay if I ask you one quick question?

Do NOT jump back into the qualification flow without asking.

---

## HELLO INTERRUPTION RULE

If the customer says "hello" or "hey" while you are speaking at ANY point in the call:
1. Stop immediately
2. Greet back: "oh hi, hello"
3. Restart whatever you were saying in different words

---

## FORBIDDEN

- Words: I see / I understand / That makes sense / No worries / Great / Perfect / Excellent / Amazing
- No exclamation marks
- No contractions - use: I am, do not, can not, you are
- No em dash - use hyphen
- Numbers as words
- Never say "next question" or "moving on"
- um and uh MUST always have <break time="300ms"/> immediately after: "uh <break time="300ms"/> yeah" or "um <break time="300ms"/> so"
- Questions end clean - no trailing filler after the question mark
- NEVER output more than one response per turn. If you catch yourself about to say two things, delete the second one.

---

## QC BLOCK - ALWAYS FIRST, BEFORE SPOKEN WORDS

Every single response MUST start with a QC block. Token limits cut the END - QC first guarantees capture.

Format:
\`<QC>{"q":<currentQ>,"result":"<pass|fail|skip>","next":<nextQ>,"field":null,"value":null}</QC>\`

- pass = qualifies - advance
- fail = does not qualify - end call
- skip/unclear = not answered / off-topic - stay on same question, re-ask with DIFFERENT wording
- skip/repeat  = customer asked to repeat - re-speak LAST_QUESTION_TEXT exactly (see REPEAT REQUEST rule below)

Examples:
\`\`\`
<QC>{"q":1,"result":"pass","next":2,"field":null,"value":null}</QC> mm-hmm, okay. and uh <break time="300ms"/> are you currently on Medicare, Medicaid, Tricare, or any VA coverage?
<QC>{"q":1,"result":"fail","next":1,"field":null,"value":null}</QC> oh, I am sorry - sounds like you are not interested. you have a good day. END
<QC>{"q":2,"result":"skip","next":2,"field":null,"value":null}</QC> uh <break time="300ms"/> sorry, I was asking - are you on Medicare, Medicaid, Tricare, or VA coverage?
\`\`\`

---

## REPEAT REQUEST — EXACT REPLAY RULE (HIGHEST PRIORITY AFTER STOP-AND-LISTEN)

A REPEAT REQUEST is when the customer says any of:
- repeat that / say that again / say it again / can you repeat / could you repeat
- what did you say / what was that / what was the question
- sorry / pardon / huh / I did not catch that / come again
- I did not hear you / can you say that again

When you detect a REPEAT REQUEST:
1. QC block: result=skip, q=<currentQ>, next=<currentQ>
2. Re-speak the LAST_QUESTION_TEXT from LIVE CALL STATE - word for word, no changes
3. Do NOT explain the question
4. Do NOT rephrase or use varied wording
5. Add only one short filler bridge before it

This is NOT a digression. Do not treat a repeat request as a digression.

Example - LAST_QUESTION_TEXT is "are you currently on Medicare, Medicaid, Tricare, or any VA coverage?":
WRONG: uh sure - I was asking whether you have any government health coverage like Medicaid.
RIGHT: uh <break time="300ms"/> sure - are you currently on Medicare, Medicaid, Tricare, or any VA coverage?

NOTE: The backend handles most repeat requests before they reach you. If one reaches you anyway, use LAST_QUESTION_TEXT exactly.

---

## ANSWERING MACHINE DETECTION

If you detect: one-way monologue / voicemail beep / pre-recorded message / no live human voice - END immediately. No questions. No response.

## BACKGROUND NOISE AND TV VOICE FILTERING (CRITICAL)

You MUST distinguish between direct human speech and ambient audio. ONLY respond to clear, close-to-phone human voice that is directly addressing you.

IGNORE completely - do not respond, do not acknowledge, produce zero output for:
- TV or radio voices playing in the background
- Distant conversations between other people
- Pre-recorded messages, commercials, or announcements
- Music, news broadcasts, or any media audio
- Muffled or distant speech that is clearly not directed at you
- Answering machine greetings or voicemail prompts

HOW TO TELL THE DIFFERENCE:
- Direct speech: clear, close-mic quality, addressing you or responding to your question
- Background noise: different voice quality, ongoing monologue, unrelated topic, TV-style cadence, multiple voices overlapping

When in doubt: WAIT and stay silent. Do not respond to anything that could be ambient audio. Only respond when you hear clear, direct, close-to-phone speech that is a response to what you said or is clearly addressed to you.

---

## GREETING

Strict order. No small talk. No "how are you."

**Part 1 - say exactly:**
> hi, this is Anna calling from Health Subsidy Center in your state.

**Customer response to Part 1:**
- Hello / yes / acknowledgment - go to Part 2
- Question or off-topic - answer briefly (one sentence), then go to Part 2
- Interrupts mid-Part 1 with "hello" or "hey" - say "oh hi, hello" then restart Part 1 in different words
- Other interruption mid-Part 1 - stop, listen, answer, then go to Part 2

**Part 2 - say exactly:**
> and I am just calling to make sure you are not missing out on any extra health benefits. so would you be open to a quick twenty second review for a health subsidy program?

**Wait for answer:**
- Yes / mm-hmm / okay / go on / uh-huh / what is that / sure - treat as YES - say "mm-hmm, okay" - go to Q2
- No / not interested - go to NOT INTERESTED rebuttal
- "what subsidy program?" / "what do you mean?" / confused - explain simply in different words each time, then re-ask Part 2
- Unclear / silence - re-ask Part 2 in different words (skip)

**If GREETING_COMPLETE = true - never re-introduce yourself.**

**Varied Part 2 re-ask examples (rotate):**
> sorry - I was just asking if you would be open to a quick check on your health subsidy options?
> yeah I was just wondering - would you want to take a few seconds to see if you qualify?
> I was asking - would you be open to a quick review to see what benefits you might be missing?

---

## QUALIFICATION

Only begin after interest is confirmed. Strict order. Maximum 2 questions total.

### Q2 - GOVERNMENT COVERAGE

**Ask:**
> okay so are you currently on Medicare, Medicaid, Tricare, or any VA coverage?

**Interpret Q2:**
- NO - does not have government coverage - PASS - go to PRE-TRANSFER
- YES - has government coverage - FAIL - end call politely

**If Q2 answer is unclear:**
Re-ask once using different wording.

**Q2 = NO (qualifies):**
> okay it looks like you might qualify. I am connecting you to a licensed expert who can walk you through your options. just hold on one moment.

Then go to PRE-TRANSFER.

**Q2 = YES (does not qualify):**
> oh okay - unfortunately that means you would not qualify for this program. but I appreciate your time, you have a good day. END

---

## PRE-TRANSFER

Say:
> alright, let me get you connected. just hold on one moment.

[TRANSFER CALL]

---

## OBJECTIONS

### Not interested

ONE rebuttal only - rotate:
> oh well I was just going to check if you qualify - it is completely free and just one quick question. would you still want to pass on that?
> okay but it is just one question and no cost at all. worth a quick check?
> no pressure at all - just want to make sure you are not missing out on free benefits. would you be open to just one question?

CRITICAL: ONE rebuttal per call. If customer says ANYTHING negative after - acknowledge warmly and END:
> okay, I appreciate your time. you have a good day. END

If okay / sure after rebuttal - go to Q2.

### How did you get my number

> oh your number came through a health benefits directory - you probably opted in at some point.

Then continue or ask permission.

### Are you AI / you sound like a robot

> yeah I am actually an AI assistant - my job is just to see if you qualify and then connect you with a real licensed agent. would it be okay if I ask you one quick question?

Do NOT deny being AI.

### I am good / already covered

> yeah a lot of people still qualify even with coverage. worth a quick look?

If insists: acknowledge and END.

### Busy

> oh sorry to bother you - I will try you another time. you have a good day. END

### Cost concerns

> yeah no cost at all. totally free.

Then continue.

### Scam concerns

> we are not the government and not collecting any payment info - we just connect you with licensed agents who check your eligibility.

If still uncomfortable:
> I hear you. you can always contact a licensed local agent on your own. you have a good day. END

### Send info first

> oh yeah subsidy options depend on your details - quickest way is a brief call with a licensed agent. would you be open to that?

### Is this government

> oh no, we are not a government agency - we work with licensed insurance agents who help people get ACA plans.

### What is the subsidy program

> oh sure. it is part of the Affordable Care Act - helps people get low-cost or free health insurance based on income.

### How long

> oh pretty quick - just one question and I connect you to a licensed agent. about a minute total.

Then continue.

### Not decision-maker

> oh okay no problem - maybe I can call back when they are available. you have a good day. END

### DNC request

> of course, I will make sure we do not contact you again. you have a good day. END

### Wrong person

> oh sorry about that. I will update our records. you have a good day. END

### Abusive language

END IMMEDIATELY. No response. Say nothing. Just hang up.

---

## INTERRUPTION HANDLING

When customer interrupts or asks a question mid-flow:
1. Go SILENT immediately
2. Listen to what they say
3. Answer SHORT - one sentence max, like a real person would
4. Then ask to continue: "so can I ask you one quick question?"

WRONG way to answer "is this free?":
> mm-hmm, okay. uh yeah there is no cost for this call or the review at all. the agent will explain everything before you decide.
RIGHT way:
> yeah no cost at all.

WRONG way to answer "who is this?":
> mm-hmm, okay. so I am Anna from Health Subsidy Center and I am just calling to check if you might qualify for a health subsidy.
RIGHT way:
> this is Anna from Health Subsidy Center. would it be okay if I ask you a quick question?

Rules:
- Never re-ask in the exact same words as before
- "hold on / wait / one sec" → say "oh suure, take your time." then STOP and wait

---

## DELAY-AWARE LISTENING

Customer responses can be delayed. Always respond to what you actually hear, not what you expect. If a response arrives late or partially:
- Process what was said
- Respond to the actual content
- Do not repeat your previous message if they already answered it

---

## UNRESPONSIVE

If same question asked twice with no real answer:
> okay, um <break time="200ms"/> I think this might not be a good time. but I appreciate your time - you have a good day. END

---

## SILENCE (5-6 seconds)

Rotate - never repeat same line:
> hey, are you still with me?
> hey, can you hear me?
> hey, I am not able to hear you - are you still there?

After two attempts with no response - end the call without saying anything.

---

## INTELLIGENCE RULES

- Detect intent before responding - understand WHAT the customer means, not just the words
- Voicemail / answering machine / no live voice - END immediately
- Customer filler sounds (uh, um, hmm, oh) - wait, do not interrupt
- Background noise only / TV / radio / distant voices - IGNORE completely, produce zero output, wait for direct speech
- If you hear a long monologue that does not address you or respond to your question - it is TV or background. Ignore it.
- Match customer energy - calm if they are calm, warmer if they are friendly
- Always wait for customer to FULLY finish before responding - no overlapping
- Never repeat the same sentence wording twice in one call
- Keep all sentences simple - if customer sounds confused, use even simpler words
- Listen carefully to the FULL utterance before deciding how to respond - do not react to partial words
- If customer answer is ambiguous, ask for clarification rather than guessing

---

## QC BLOCK REMINDER

QC block is ALWAYS the first thing in every response - before any spoken words.`;

const GREETING_FULL = [
  `hi, this is Anna calling from Health Subsidy Center in your state.`,
  `and I am just calling to make sure you are not missing out on any extra health benefits.`,
  `so would you be open to a quick twenty second review for a health subsidy program?`,
].join(" ");


// Q1 YES → transition to Q2 (from prompt ## QUALIFICATION Q2 ask)
const Q1_YES_TO_Q2 = [
  `okay so are you currently on Medicare, Medicaid, Tricare, or any VA coverage?`,
  `mm-hmm. so can I just ask - are you on Medicare, Medicaid, Tricare, or any VA coverage?`,
  `okaaay. are you currently on Medicare, Medicaid, Tricare, or any VA coverage?`,
];

// Q1 NO / not interested → rebuttal (from prompt ## OBJECTIONS Not interested)
const Q1_NOT_INTERESTED_REBUTTAL = [
  `oh well I was just going to check if you qualify - it is completely free and just one quick question. would you still want to pass on that?`,
  `okay but it is just one question and no cost at all. worth a quick check?`,
  `no pressure at all - just want to make sure you are not missing out on free benefits. would you be open to just one question?`,
];

// Q1 insist no → polite goodbye (from prompt ## OBJECTIONS If insists no)
const Q1_INSIST_NO_GOODBYE = `okay, no problem. you have a good day.`;

// Q2 NO (qualifies) → pre-transfer (from prompt ## QUALIFICATION Q2=NO + PRE-TRANSFER)
const Q2_NO_QUALIFIES = [
  `okay it looks like you might qualify. I am connecting you to a licensed expert who can walk you through your options. just hold on one moment.`,
  `mm-hmm okay so it looks like you could qualify. let me get you connected to a licensed agent. just hold on one moment.`,
];

// Q2 YES (disqualifies) → polite end (from prompt ## QUALIFICATION Q2=YES)
const Q2_YES_DISQUALIFIES = [
  `oh okay - unfortunately that means you would not qualify for this program. but I appreciate your time, you have a good day.`,
  `oh I am sorry - then you do not qualify for this one. but thank you for your time, you have a good day.`,
];

// Q2 re-ask (from prompt ## QUALIFICATION Varied Q2 re-ask)
const Q2_REASK = [
  `I was just asking - do you have Medicare, Medicaid, Tricare, or VA coverage right now?`,
  `sorry, just to check - are you currently on Medicare, Medicaid, Tricare, or the VA?`,
  `I just need to know if you are on any government health coverage like Medicare or Medicaid?`,
];

// Q1 re-ask / Part 2 varied (from prompt ## GREETING Varied Part 2 re-ask)
const Q1_REASK = [
  `sorry - I was just asking if you would be open to a quick check on your health subsidy options?`,
  `yeah I was just wondering - would you want to take a few seconds to see if you qualify?`,
  `I was asking - would you be open to a quick review to see what benefits you might be missing?`,
];

// Objection: How did you get my number (from prompt ## OBJECTIONS)
const OBJ_HOW_GOT_NUMBER = [
  `oh your number came through a health benefits directory - you probably opted in at some point.`,
  `yeah it came through one of our directories - most likely you signed up for health benefit info before.`,
];

// Objection: Are you AI (from prompt ## OBJECTIONS)
const OBJ_ARE_YOU_AI = `yeah I am actually an AI assistant - my job is just to see if you qualify and then connect you with a real licensed agent. would it be okay if I ask you one quick question?`;

// Objection: Already covered (from prompt ## OBJECTIONS)
const OBJ_ALREADY_COVERED = `yeah a lot of people still qualify even with coverage. worth a quick look?`;

// Objection: Busy (from prompt ## OBJECTIONS)
const OBJ_BUSY = `oh sorry to bother you - I will try you another time. you have a good day.`;

// Objection: Cost concerns (from prompt ## OBJECTIONS)
const OBJ_COST = `yeah no cost at all. totally free.`;

// Objection: Scam (from prompt ## OBJECTIONS)
const OBJ_SCAM = `we are not the government and not collecting any payment info - we just connect you with licensed agents who check your eligibility.`;

// Objection: Send info first (from prompt ## OBJECTIONS)
const OBJ_SEND_INFO = `oh yeah subsidy options depend on your details - quickest way is just a brief call with a licensed agent. would you be open to that?`;

// Objection: Is this government (from prompt ## OBJECTIONS)
const OBJ_IS_GOVT = `oh no, we are not a government agency - we work with licensed insurance agents who help people get ACA plans.`;

// Objection: What is the subsidy program (from prompt ## OBJECTIONS)
const OBJ_WHAT_SUBSIDY = [
  `oh sure. it is part of the Affordable Care Act - helps people get low-cost or free health insurance based on income.`,
  `yeah so basically the government offers subsidies for health insurance - depending on your income you could get coverage for very little or nothing.`,
  `it is a program where you might get health coverage at a reduced cost or even free depending on your situation.`,
];

// Objection: How long (from prompt ## OBJECTIONS)
const OBJ_HOW_LONG = `oh pretty quick - just one question and I connect you to a licensed agent. about a minute total.`;

// Objection: Not decision-maker (from prompt ## OBJECTIONS)
const OBJ_NOT_DECISION_MAKER = `oh okay no problem - maybe I can call back when they are available. you have a good day.`;

// Objection: Wrong person (from prompt ## OBJECTIONS)
const OBJ_WRONG_PERSON = `oh sorry about that. I will update our records. you have a good day.`;

// Hello interruption (from prompt ## HELLO INTERRUPTION RULE)
const HELLO_INTERRUPT_RESPONSE = `oh hi, hello.`;

// Rotation helper — picks from array and advances index
function pickRotation(session, key, pool) {
  if (!Array.isArray(pool)) return pool;
  const idx = (session._rotationCounters || {})[key] || 0;
  if (!session._rotationCounters) session._rotationCounters = {};
  session._rotationCounters[key] = (idx + 1) % pool.length;
  return pool[idx % pool.length];
}

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
const THINKING_FILLER_MS = 800;
const TRANSFER_DELAY_MS = 5500;
const TTS_QUEUE_MAX_DEPTH = 6;
const AUDIO_BUFFER_MAX_BYTES = 200000;
const TWILIO_READY_WAIT_MAX_MS = 8000;
const ACK_TO_QUESTION_PAUSE_MS = 380;
const POST_GREETING_LISTEN_MS = 600;
// BACKCHANNEL_FILLER_MS and BACKCHANNEL_FILLERS REMOVED (v8.4).
// The backchannel timer (300ms) stacked with thinkingFiller (800ms) and forcedPrefix,
// producing triple fillers. Only thinkingFiller is kept as a latency mask.
const BARGEIN_MIN_WORDS = 3;

// ─────────────────────────── VOICEMAIL DETECTION ─────────────────────────────

const VOICEMAIL_REGEX =
  /(leave (your )?message|after the tone|voicemail|mailbox|not available|cannot take your call|press 1 for more options|unavailable|record your message|the person you are trying to reach|is not accepting calls)/i;

// ─────────────────────────── TV / BACKGROUND NOISE DETECTION ────────────────
// Filters out ambient audio that isn't direct human speech addressed to the bot.
// Works in conjunction with Deepgram confidence scores and speech patterns.

const TV_NOISE_INDICATORS = [
  // Long monologues without pause (TV anchors, ads, shows)
  // Detected by: continuous speech > 15 words without a question or direct address
  // News/commercial cadence patterns
  /\b(breaking news|stay tuned|commercial break|brought to you by|subscribe|like and share|click the link|available now|order now|call now|limited time|act now)\b/i,
  // Weather/sports broadcast patterns
  /\b(high of|low of|degrees|forecast|touchdown|field goal|three pointer|home run|penalty|first quarter|halftime)\b/i,
  // Show/movie dialogue patterns (long statements not directed at phone)
  /\b(previously on|next time on|season finale|episode|chapter)\b/i,
];

function looksLikeTVNoise(text, wordCountVal) {
  if (!text) return false;
  // Long continuous monologue with no question marks = likely TV
  if (wordCountVal >= 15 && !text.includes("?")) return true;
  // Known TV/broadcast patterns
  for (const pattern of TV_NOISE_INDICATORS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ─────────────────────────── GENERIC HELPERS ─────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeForTTS(text) {
  return (text || "")
    .replace(/<QC>[\s\S]*?<\/QC>/gi, "")
    .replace(/\(short pause\)/gi, "")
    .replace(/\(pause\)/gi, "")
    .replace(/\[(SYSTEM|SYS|STAGE|QC|SECTION|NOTE|INTERNAL)[^\]]*\]/gi, "")
    .replace(/\[[^\]]*\]/gi, "")
    // Strip literal END signal the LLM writes as a call-termination marker
    .replace(/[.,]?\s*\bEND\b\s*$/gi, "")
    .replace(/\bEND\b/g, "")
    // Stretch words (okaaay, suure, yeaah) are KEPT — ElevenLabs renders them naturally
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
    .replace(/<[^>]+>/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!raw || raw.includes("?") || raw.split(/\s+/).filter(Boolean).length > 6) return false;
  return /^(?:oh\s+nice|oh\s+yeah|oh\s+okay|oh\s+sure|nice|great|perfect|cool|okay|ok|sure|mhm+|mhmm+|mm+|hmm+|uh\s*huh|uh-huh|yeah|yea|yep|yup|alright)(?:\s*[,.;-]\s*(?:oh\s+nice|nice|great|perfect|cool|right|okay|ok|sure|mhm+|mm+|hmm+|yeah|yea|yep|yup|alright))*[.!?]*$/i.test(raw);
}

function isAcknowledgmentChunk(text) {
  const t = (text || "").replace(/\[[^\]]+\]/g, "").replace(/<[^>]+>/g, "").trim();
  if (!t || t.includes("?") || t.split(/\s+/).length > 12) return false;
  return isAckOnlyUtterance(t);
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

const FILLER_REGEX =
  /^(?:y|n|yes|no|yeah|yea|yep|yup|nah|nope|ok|okay|okey|k|kk|kay|sure|alright|all right|right|correct|exactly|true|fine|good|great|perfect|awesome|sounds good|works|got it|understood|i see|maybe|possibly|not really|dont know|don't know|idk|huh|what|pardon|sorry|hello|hi|hey|yo|hmm|hm|mmm|mm|mhm|mhmm|uh huh|uh-huh|uhhuh|uh|um|erm|go ahead|please|continue|and|so|well|but|okay go ahead|sure go ahead|go on|keep going|i'm here|im here|still here|i hear you|i got you|gotcha)\.?\s*$/i;

function isFiller(text) { return FILLER_REGEX.test((text || "").trim()); }

function normalizeIntentText(text) {
  return String(text || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
}

// ─────────────────────────── INTENT DETECTION ────────────────────────────────

const DNC_REGEX =
  /\b(do not call|don't call|dnc|remove me|remove my number|take me off|stop calling|stop calling me|quit calling|leave me alone)\b/i;

const HARD_STOP_REGEX =
  /\b(not interested|no thanks|not now|i am busy|i'm busy|busy right now|not a good time|call me later|wrong person|wrong number|goodbye|bye)\b/i;

const YES_INTENT_REGEX =
  /^(yes|yeah|yep|yup|sure|okay|ok|alright|all right|maybe|possibly|go ahead|go on|continue|that is fine|sounds good|correct|tell me more|what is this)$/i;

const NO_INTENT_REGEX =
  /^(no|nope|nah|not really|incorrect)$/i;

// ─── REPEAT REQUEST DETECTION ─────────────────────────────────────────────────


const REPEAT_REQUEST_REGEX =
  /\b(repeat|repeat that|say that again|say it again|can you repeat|could you repeat|what did you say|what was that|what was the question|i did not catch|i didn.?t catch|didn.?t hear|did not hear|come again|say again|i missed that|missed that|i missed what you said|can you say that again|could you say that again)\b/i;

function detectRepeatRequest(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  // Single-word catch-alls only when the entire utterance is that one word
  if (/^(huh\??|pardon\.?|what\??)$/.test(t)) return true;
  return REPEAT_REQUEST_REGEX.test(t);
}

function detectDncIntent(text) {
  return DNC_REGEX.test(normalizeIntentText(text));
}

function detectHardStopIntent(text) {
  const t = normalizeIntentText(text);
  return DNC_REGEX.test(t) || HARD_STOP_REGEX.test(t);
}

function detectYesIntent(text) {
  return YES_INTENT_REGEX.test(normalizeIntentText(text));
}

function detectNoIntent(text) {
  return NO_INTENT_REGEX.test(normalizeIntentText(text));
}

// ─── OBJECTION DETECTION (hardcoded bypass — no LLM needed) ─────────────────

const ABUSE_REGEX = /\b(fuck|f\*+k|bitch|asshole|shit|scammer|piece of shit|go to hell|eat shit)\b/i;

function detectObjection(text) {
  const t = normalizeIntentText(text);
  if (!t) return null;
  if (ABUSE_REGEX.test(t)) return "ABUSE";
  if (/\b(how did you get my number|where did you get my number|how do you have my number|who gave you my number)\b/i.test(t)) return "HOW_GOT_NUMBER";
  if (/\b(are you a robot|are you ai|are you a bot|you sound like a robot|is this a robot|is this ai|are you real|you sound fake|are you a computer|is this automated)\b/i.test(t)) return "ARE_YOU_AI";
  if (/\b(i.?m good|i am good|already covered|already have insurance|already have coverage|i.?m covered|i have insurance|i have coverage|already enrolled)\b/i.test(t)) return "ALREADY_COVERED";
  if (/\b(i.?m busy|i am busy|busy right now|not a good time|bad time|call me later|call back later|in a meeting|i.?m driving|i am driving|i.?m at work|i am at work|i.?m eating)\b/i.test(t)) return "BUSY";
  if (/\b(how much|cost|is it free|is there a charge|do i have to pay|fee|payment|price)\b/i.test(t)) return "COST";
  if (/\b(scam|fraud|is this legit|is this legitimate|spam|telemarket|robo.?call)\b/i.test(t)) return "SCAM";
  if (/\b(send me info|send me something|send it to my email|mail me|email me|text me the info|send information)\b/i.test(t)) return "SEND_INFO";
  if (/\b(is this the government|government agency|are you government|are you the government|from the government)\b/i.test(t)) return "IS_GOVT";
  if (/\b(what.?s the subsidy|what subsidy|what is the program|what program|what do you mean|what is this about|what are you offering|explain|tell me more about)\b/i.test(t)) return "WHAT_SUBSIDY";
  if (/\b(how long|how much time|how long will this take|how long does it take)\b/i.test(t)) return "HOW_LONG";
  if (/\b(not the decision|not my decision|i.?m not the one|talk to my (husband|wife|spouse)|my (husband|wife|spouse) handles)\b/i.test(t)) return "NOT_DECISION_MAKER";
  if (/\b(wrong number|wrong person|misdial|you have the wrong|that.?s not me)\b/i.test(t)) return "WRONG_PERSON";
  return null;
}

function detectQ1NegativeIntent(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  return detectDncIntent(t) || detectHardStopIntent(t) || detectNoIntent(t);
}

const POST_GREETING_FILLER_REGEX =
  /^(?:hello[?!.]?|hi[?!.]?|hey[?!.]?|can you hear me[?!.]?|are you there[?!.]?|is anyone there[?!.]?|are you still there[?!.]?|can you hear me now[?!.]?|testing[?!.]?|hello[?!.]?\s+hello[?!.]?)$/i;

function isPostGreetingFiller(text) {
  return POST_GREETING_FILLER_REGEX.test((text || "").trim());
}

// Tightened: bare "good"/"fine"/"okay" are qualification answers, not social.
// Requires "thanks"/"thank you" or reciprocal question to trigger.
const SOCIAL_RESPONSE_REGEX =
  /^(?:(?:(?:hi|hey|hello)[,.]?\s+)?(?:[a-z]+[,.]?\s+)?(?:what about you|how about you|and you|what about yourself)[?!.]?|(?:(?:hi|hey|hello)[,.]?\s+)?(?:i(?:'m| am)\s+)?(?:doing\s+)?(?:good|fine|great|okay|well|not bad|pretty good|alright|doing well|doing good)(?:\s+(?:thanks?|thank you))[.!?]?(?:[,.]?\s*(?:and\s+)?(?:you|yourself|what about you)[?!.]?)?|(?:good|fine|great|not bad|okay)[,.]?\s+how\s+(?:are\s+you|about\s+you)[?!.]?|how\s+are\s+you[?!.]?)$/i;

function isSocialResponse(text) {
  return SOCIAL_RESPONSE_REGEX.test((text || "").trim());
}

function containsReciprocalQuestion(text) {
  return /(\band you\b|\bwhat about you\b|\bhow about you\b|\bhow are you\b|\bwhat about yourself\b)/i.test(text || "");
}

function buildForcedSocialReply(utterance) {
  return containsReciprocalQuestion(utterance)
    ? "oh I am doing well, thanks for asking."
    : "oh nice, glad to hear that.";
}

// ─── DIGRESSION REGEX ─────────────────────────────────────────────────────────
// Repeat-related phrases intentionally REMOVED. They live in detectRepeatRequest().
// Mixing them here caused the LLM to rephrase instead of doing an exact replay.

const DIGRESSION_REGEX =
  /^(?:why|what do you mean|how|who|when|where|can you|could you|do you|are you|is this|i don.?t understand|explain|tell me more|what.?s this about|hold on|one second|one sec|wait|hang on|i.?m (?:driving|busy|at work|in a meeting|eating|walking)|not a good time|can i ask you something|i have a question|question for you|actually|never mind|forget it|just wondering|curious(?:ly)?)\b/i;

function isDigression(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.endsWith("?") && !FILLER_REGEX.test(t) && !detectRepeatRequest(t)) return true;
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
    const tailIsFiller =
      /^[\)\]\s.,;:-]*?(?:\(?\s*)?(?:oh\s+)?(?:ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|alright|okay|ok|sure|perfect|great|nice|cool|got\s+it|sounds\s+good|will\s+do|noted|understood|I\s+see|I\s+got\s+it|thank\s+you|thanks)(?:\s*[,.]?\s*(?:got\s+it|sounds\s+good|will\s+do|noted|understood|nice|great|good|okay|ok|sure|perfect|right|cool|alright))?(?:[\s,.;:-]+(?:oh\s+)?(?:ah|um+|uh+|hmm+|mhm+|mhmm+|mm+|yeah|yea|yep|yup|right|alright|okay|ok|sure|perfect|great|nice|cool|got\s+it|sounds\s+good|will\s+do|noted|understood)(?:\s*[,.]?\s*(?:nice|great|good|okay|ok|sure|perfect|right|cool|alright|got\s+it))?)*[.!?\)\]]*\s*$/i.test(after);
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
    const inferred = inferDispositionFromText(`${transcript} ${(session.aiChunks || []).slice(-25).join(" ")}`);
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
const BG_NOISE_TARGET_PEAK = 18;
const BG_NOISE_VOLUME = 0.45;

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
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
]);

function _mulawEncode(sample) {
  const BIAS = 0x84;
  let sign;
  if (sample >= 0) { sign = 0; } else { sign = 0x80; sample = -sample - 1; }
  if (sample > 32767) sample = 32767;
  sample += BIAS;
  const exp = _MULAW_EXP_LUT[(sample >> 7) & 0xff];
  const mantissa = (sample >> (exp + 3)) & 0x0f;
  return (~(sign | (exp << 4) | mantissa)) & 0xff;
}

function _verifyMulawCodec() {
  let failures = 0;
  for (let b = 0; b < 256; b++) { const rt = _mulawEncode(_mulawDecode(b)); if (rt !== b) failures++; }
  if (failures > 0) logger.error(`[BgNoise] CODEC SELF-TEST FAILED: ${failures}/256 bytes do not round-trip!`);
  else logger.info(`[BgNoise] Codec self-test passed.`);
  return failures === 0;
}

function _wavToLinear8k(raw) {
  if (raw.length < 44) throw new Error(`Too short to be WAV (${raw.length} bytes)`);
  const riff = raw.toString("ascii", 0, 4);
  const wave = raw.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error(`Not a WAV file (${riff}...${wave})`);

  let fmtOffset = -1, dataOffset = -1, dataSize = 0, pos = 12;
  while (pos + 8 <= raw.length) {
    const id = raw.toString("ascii", pos, pos + 4);
    const size = raw.readUInt32LE(pos + 4);
    if (id === "fmt ") fmtOffset = pos + 8;
    if (id === "data") { dataOffset = pos + 8; dataSize = size; break; }
    pos += 8 + size + (size & 1);
  }
  if (fmtOffset === -1) throw new Error("WAV missing 'fmt ' chunk");
  if (dataOffset === -1) throw new Error("WAV missing 'data' chunk");

  const audioFormat = raw.readUInt16LE(fmtOffset);
  const numChannels = raw.readUInt16LE(fmtOffset + 2);
  const sampleRate = raw.readUInt32LE(fmtOffset + 4);
  const bitsPerSample = raw.readUInt16LE(fmtOffset + 14);

  logger.info(`[BgNoise] WAV: fmt=${audioFormat} ch=${numChannels} rate=${sampleRate}Hz bits=${bitsPerSample} dataBytes=${dataSize}`);
  if (audioFormat !== 1) throw new Error(`WAV audioFormat=${audioFormat} must be 1 (PCM)`);
  if (bitsPerSample !== 8 && bitsPerSample !== 16) throw new Error(`WAV bitsPerSample=${bitsPerSample} unsupported`);
  if (numChannels < 1 || numChannels > 2) throw new Error(`WAV channels=${numChannels} unsupported`);

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
      left0 = raw.readInt16LE(base0); right0 = numChannels === 2 ? raw.readInt16LE(base0 + 2) : left0;
      left1 = raw.readInt16LE(base1); right1 = numChannels === 2 ? raw.readInt16LE(base1 + 2) : left1;
    } else {
      left0 = (raw[base0] - 128) << 8; right0 = numChannels === 2 ? ((raw[base0 + 1] - 128) << 8) : left0;
      left1 = (raw[base1] - 128) << 8; right1 = numChannels === 2 ? ((raw[base1 + 1] - 128) << 8) : left1;
    }
    const mono0 = numChannels === 2 ? Math.round((left0 + right0) / 2) : left0;
    const mono1 = numChannels === 2 ? Math.round((left1 + right1) / 2) : left1;
    out[o] = Math.round(mono0 + frac * (mono1 - mono0));
  }

  let peak = 0;
  for (let i = 0; i < out.length; i++) { const a = out[i] < 0 ? -out[i] : out[i]; if (a > peak) peak = a; }
  logger.info(`[BgNoise] Resampled: ${outFrames} samples (~${(outFrames / 8000).toFixed(1)}s) peak=${peak}`);
  return out;
}

function _rawMulawToLinear(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = _mulawDecode(buf[i]);
  let peak = 0;
  for (let i = 0; i < out.length; i++) { const a = out[i] < 0 ? -out[i] : out[i]; if (a > peak) peak = a; }
  logger.info(`[BgNoise] Raw µ-law decoded: ${out.length} samples peak=${peak}`);
  return out;
}

function _loadBgNoise() {
  if (_bgNoiseLinear !== null) return;
  _verifyMulawCodec();
  try {
    const raw = fs.readFileSync(BG_NOISE_PATH);
    if (raw.length === 0) throw new Error("file is empty");
    logger.info(`[BgNoise] Loading: ${BG_NOISE_PATH} size=${raw.length} bytes`);
    const isWav = raw.length >= 12 && raw.toString("ascii", 0, 4) === "RIFF" && raw.toString("ascii", 8, 12) === "WAVE";
    _bgNoiseLinear = isWav ? _wavToLinear8k(raw) : _rawMulawToLinear(raw);
    let sourcePeak = 0;
    for (let i = 0; i < _bgNoiseLinear.length; i++) { const a = _bgNoiseLinear[i] < 0 ? -_bgNoiseLinear[i] : _bgNoiseLinear[i]; if (a > sourcePeak) sourcePeak = a; }
    if (sourcePeak === 0) { logger.warn(`[BgNoise] All-zero samples — mixing disabled`); _bgNoiseLinear = new Int16Array(0); }
    else {
      const normFactor = BG_NOISE_TARGET_PEAK / sourcePeak;
      for (let i = 0; i < _bgNoiseLinear.length; i++) _bgNoiseLinear[i] = Math.round(_bgNoiseLinear[i] * normFactor);
      logger.info(`[BgNoise] Ready: ${_bgNoiseLinear.length} samples target_peak=${BG_NOISE_TARGET_PEAK} vol=${BG_NOISE_VOLUME}`);
    }
  } catch (e) {
    logger.error(`[BgNoise] LOAD FAILED — noise mixing DISABLED. ${e.message}`);
    _bgNoiseLinear = new Int16Array(0);
  }
}

function _loadKbNoise() {
  if (_kbNoiseLinear !== null) return;
  try {
    const raw = fs.readFileSync(KB_NOISE_PATH);
    if (raw.length === 0) throw new Error("file is empty");
    const isWav = raw.length >= 12 && raw.toString("ascii", 0, 4) === "RIFF" && raw.toString("ascii", 8, 12) === "WAVE";
    _kbNoiseLinear = isWav ? _wavToLinear8k(raw) : _rawMulawToLinear(raw);
    let sourcePeak = 0;
    for (let i = 0; i < _kbNoiseLinear.length; i++) { const a = _kbNoiseLinear[i] < 0 ? -_kbNoiseLinear[i] : _kbNoiseLinear[i]; if (a > sourcePeak) sourcePeak = a; }
    if (sourcePeak === 0) { logger.warn(`[KbNoise] All-zero — disabled`); _kbNoiseLinear = new Int16Array(0); }
    else {
      const normFactor = KB_NOISE_TARGET_PEAK / sourcePeak;
      for (let i = 0; i < _kbNoiseLinear.length; i++) _kbNoiseLinear[i] = Math.round(_kbNoiseLinear[i] * normFactor);
      logger.info(`[KbNoise] Ready: ${_kbNoiseLinear.length} samples burst=${KB_BURST_FRAMES * 20}ms`);
    }
  } catch (e) { logger.warn(`[KbNoise] DISABLED — ${e.message}`); _kbNoiseLinear = new Int16Array(0); }
}

function _triggerKeyboardBurst() {
  if (_kbNoiseLinear && _kbNoiseLinear.length > 0) { _kbNoiseOffset = 0; _kbActiveFrames = KB_BURST_FRAMES; }
}

function _mixNoiseIntoUlawFrame(voiceFrame) {
  const bgActive = _bgNoiseLinear && _bgNoiseLinear.length > 0;
  const kbActive = _kbActiveFrames > 0 && _kbNoiseLinear && _kbNoiseLinear.length > 0;
  if (!bgActive && !kbActive) return voiceFrame;

  const out = Buffer.allocUnsafe(voiceFrame.length);
  const bgSamples = bgActive ? _bgNoiseLinear.length : 0;
  const kbSamples = kbActive ? _kbNoiseLinear.length : 0;
  let peakVoice = 0, peakNoise = 0, peakMixed = 0, clipCount = 0;
  const useKb = kbActive;

  for (let i = 0; i < voiceFrame.length; i++) {
    const voiceLinear = _mulawDecode(voiceFrame[i]);
    const voiceAbs = voiceLinear < 0 ? -voiceLinear : voiceLinear;

    let bgLinear = 0;
    if (bgActive) { bgLinear = _bgNoiseLinear[_bgNoiseOffset % bgSamples]; _bgNoiseOffset = (_bgNoiseOffset + 1) % bgSamples; }
    let kbLinear = 0;
    if (useKb) { kbLinear = _kbNoiseLinear[_kbNoiseOffset % kbSamples]; _kbNoiseOffset = (_kbNoiseOffset + 1) % kbSamples; }

    const mixed = voiceLinear + Math.round(bgLinear * BG_NOISE_VOLUME) + kbLinear;
    let clamped;
    if (mixed > 32767) { clamped = 32767; clipCount++; }
    else if (mixed < -32767) { clamped = -32767; clipCount++; }
    else { clamped = mixed; }

    out[i] = _mulawEncode(clamped);
    const an = (bgLinear < 0 ? -bgLinear : bgLinear) + (kbLinear < 0 ? -kbLinear : kbLinear);
    const am = clamped < 0 ? -clamped : clamped;
    if (voiceAbs > peakVoice) peakVoice = voiceAbs;
    if (an > peakNoise) peakNoise = an;
    if (am > peakMixed) peakMixed = am;
  }

  if (useKb) _kbActiveFrames--;
  _bgNoiseMixCount++;
  if (_bgNoiseMixCount % 250 === 0) {
    const eff = Math.round(peakNoise * BG_NOISE_VOLUME);
    const ratio = peakVoice > 0 ? ((eff / peakVoice) * 100).toFixed(2) : "n/a";
    logger.info(`[BgNoise] mix#${_bgNoiseMixCount} voice=${peakVoice} noise=${eff} ratio=${ratio}% mixed=${peakMixed}${clipCount > 0 ? ` ⚠CLIPS=${clipCount}` : ""}`);
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
    this.twilioService = new TwilioService({ getActiveSessionCount: () => this.sessions.size });

    logger.info(`MediaStreamHandler v9.7 initialized. Prompt ~${Math.round(STATIC_SYSTEM_PROMPT.length / 4)} tokens`);

    _loadBgNoise();
    _loadKbNoise();
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

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const sessionId = req.url.split("/").pop();
      logger.info(`[${sessionId}] WS CONNECTED`);
      ws.isAlive = true;
      ws.on("pong", () => { ws.isAlive = true; });

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
      id: sessionId, ws,
      callLog: null, campaign: null, openingLine: null,
      agentName: "Anna", firstName: "", direction: "",
      conversationHistory: [],
      lastActivity: Date.now(), isTwilioReady: false, streamSid: null,
      dgOpenAt: 0, twilioStartAt: 0,
      isSpeaking: false, ttsAbort: null, llmAbort: null,
      ttsQueue: [], ttsQueueRunning: false,
      isClosing: false, isCleaning: false,
      isProcessingUtterance: false, _finalHangupInProgress: false,
      lastSpeechAt: Date.now(), lastAiSpokeAt: 0,
      startTime: Date.now(), hasUserSpoken: false, hasRealInput: false,
      _pendingQuestion: false, _lastUtterance: "",
      _prewarmedGreetingStream: null,
      greetingCompletedAt: 0, initialGreetingSent: false,
      lastClearAt: 0, activeTurnId: 0,
      transferPending: false, lastProcessedAt: 0,
      lastAiAudioSentAt: 0, lastAckTurn: 0, transferAttempted: false,
      _wasInterrupted: false,
      _amdCleared: false,
      _rotationCounters: {},
      _q1RebuttalUsed: false,
      _interruptHandled: false,
      timers: { startSpeak: null, startHangup: null, midCheck: null, midHangup: null },
      startSilenceFlowArmed: false,
      currentStage: "greeting", openingComplete: false,
      currentQuestionNum: 1, lastUserInputType: "unknown",
      pausedQuestionNum: null, digressionCount: 0,
      turnRules: { forcedPrefix: null, disallowAck: false, disallowSocial: false, disableBackchannel: false },
      state: {
        qualified: false,
        interestConfirmed: null,
        govtCoverageChecked: null,
        retriesCantHear: 0,
        lastCantHearAt: 0,
        capturedAnswers: {},
        // ── Stores the exact TTS text of the last spoken question.
        // Used by _enqueueQuestion() + repeat-request bypass for word-for-word replay.
        lastAskedQuestionText: "",
      },
      transcriptChunks: [], aiChunks: [],
      userSpeech: {
        utteranceId: 0, isSpeaking: false, buffer: "",
        lastInterimTime: 0, startedAt: 0,
        finalizeTimer: null, hardMaxTimer: null,
        pendingBargeIn: false, bargeInConfirmTimer: null,
      },
    };
  }

  async initializeSession(sessionId, ws) {
    logger.info(`Initializing session: ${sessionId}`);

    const callLog = await CallLog.findById(sessionId).populate("campaign");
    if (!callLog) { logger.error(`[${sessionId}] CallLog not found`); return; }

    const answeredBy = String(callLog.answeredBy || callLog.amd || callLog.AMD || "").toLowerCase().trim();
    if (answeredBy && answeredBy !== "human") {
      let disposition = "NON_HUMAN";
      if (answeredBy.includes("voicemail") || answeredBy.includes("beep") || answeredBy === "machine_end_beep" || answeredBy === "machine_end_silence" || answeredBy === "machine_end_other") disposition = "VOICEMAIL";
      else if (answeredBy === "fax" || answeredBy.includes("fax")) disposition = "FAX";
      else if (answeredBy === "unknown") disposition = "AMD_UNKNOWN";
      else if (answeredBy === "machine_start" || answeredBy.includes("machine")) disposition = "ANSWERING_MACHINE";

      callLog.disposition = callLog.disposition || disposition;
      callLog.endTime = new Date(); callLog.status = "completed";
      try { await callLog.save(); } catch (e) { logger.error(`[${sessionId}] AMD save error: ${e.message}`); }
      logger.info(`[${sessionId}] AMD guard → ${callLog.disposition}. Closing.`);
      try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { }
      return;
    }

    const data = await this.campaignService.getCampaignWithPrompt(callLog.campaign._id);
    if (!data) { logger.error(`[${sessionId}] Campaign not found`); return; }

    const { campaign, openingLine, agentName } = data;
    const existing = this.sessions.get(sessionId);
    const session = existing || this.createEmptySession(sessionId, ws);

    session.ws = ws;
    session.callLog = callLog;
    session.campaign = campaign;
    session.openingLine = openingLine;
    session.agentName = agentName || "Anna";
    session.direction = String(callLog.direction || callLog.Direction || "").toLowerCase().trim();
    session.firstName = String(callLog.firstName || callLog.contact?.firstName || callLog.contact?.first_name || callLog.lead?.firstName || "").trim();

    this.sessions.set(sessionId, session);

    const greetingText = this._buildGreetingText(session);
    if (greetingText && campaign?.voiceId) {
      session._prewarmedGreetingStream = this.elevenlabsService
        .streamTextToSpeechFast(greetingText, campaign.voiceId, campaign.voiceSettings || {})
        .catch(() => null);
      logger.info(`[${sessionId}] Pre-warming greeting TTS`);
    }

    await this.deepgramService.createTranscriptionStream(sessionId, {
      onOpen: () => { const s = this.sessions.get(sessionId); if (s) s.dgOpenAt = Date.now(); },
      onTranscript: ({ text, isFinal, speechFinal }) =>
        this.onDeepgramTranscript(sessionId, text, isFinal, speechFinal),
    });

    logger.info(`[${sessionId}] Session ready`);
    this.maybePlayInitialGreeting(sessionId).catch(() => { });
  }

  // ── _buildGreetingText ───────────────────────────────────────────────────────
  // Single place where greeting audio text is defined.
  // Uses campaign.openingLine if available (custom script), otherwise GREETING_FULL
  // which is the exact wording from the prompt's ## GREETING section.
  // No greeting text exists anywhere else in this file.
  _buildGreetingText(session) {
    if (session.openingLine) {
      const rendered = safeTTS(
        renderTemplate(session.openingLine, { agentname: session.agentName || "Anna", first_name: session.firstName || "" })
      );
      if (rendered) return rendered;
    }
    return safeTTS(GREETING_FULL);
  }

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

  // ── _enqueueQuestion ────────────────────────────────────────────────────────
  // Use this instead of enqueueTTS whenever speaking a question.
  // Records the sanitized text to lastAskedQuestionText so the repeat-request
  // bypass can replay it word-for-word without involving the LLM.
  _enqueueQuestion(sessionId, text, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const clean = sanitizeForTTS(text);
    if (clean) {
      session.state.lastAskedQuestionText = clean;
      logger.info(`[${sessionId}] lastAskedQuestionText set: "${clean.slice(0, 80)}"`);
    }
    this.enqueueTTS(sessionId, text, opts);
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

    // Seed history — LLM knows what Anna said as the opening turn
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

      // Record greeting as last asked question for repeat-request replay
      const cleanGreeting = sanitizeForTTS(greetingText);
      if (cleanGreeting) s.state.lastAskedQuestionText = cleanGreeting;
      logger.info(`[${sessionId}] Greeting done → Q1 | lastAskedQuestionText set`);

      this.armMidCallSilence(sessionId);

      if (!s.hasUserSpoken) {
        this._clearTimer(s, "startHangup");
        this._setTimer(sessionId, "startHangup", 15000, async () => {
          const ss = this.sessions.get(sessionId);
          if (!ss || ss.hasUserSpoken || ss.isClosing || ss.isCleaning) return;
          logger.warn(`[${sessionId}] startHangup fired: no response after greeting`);
          if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "NO_ANSWER";
          await this.politeHangup(sessionId, { finalMessage: "Sorry, I can not hear you. Goodbye." });
        });
      }
    };

    const prewarmed = session._prewarmedGreetingStream || null;
    session._prewarmedGreetingStream = null;

    if (prewarmed) {
      prewarmed
        .then((stream) => {
          const s = this.sessions.get(sessionId);
          if (!s || s.isClosing || s.isCleaning) { onGreetingComplete(); return; }
          if (stream) {
            s.ttsQueue.unshift({ text: greetingText, _preloadedStream: stream, onComplete: onGreetingComplete });
            this.runTTSQueue(sessionId).catch(() => { });
          } else {
            this.enqueueTTS(sessionId, greetingText, { flush: true, onComplete: onGreetingComplete });
          }
        })
        .catch(() => {
          this.enqueueTTS(sessionId, greetingText, { flush: true, onComplete: onGreetingComplete });
        });
    } else {
      this.enqueueTTS(sessionId, greetingText, { flush: true, onComplete: onGreetingComplete });
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
      logger.info(`[${sessionId}] Start-silence fallback greeting`);

      const onFallbackComplete = () => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        ss.openingComplete = true;
        ss.currentStage = "qualification";
        ss.currentQuestionNum = 1;
        ss.greetingCompletedAt = Date.now();
        const c = sanitizeForTTS(fallback);
        if (c) ss.state.lastAskedQuestionText = c;
        logger.info(`[${sessionId}] Fallback greeting done → Q1`);
        this.armMidCallSilence(sessionId);
        if (!ss.hasUserSpoken) {
          this._clearTimer(ss, "startHangup");
          this._setTimer(sessionId, "startHangup", 15000, async () => {
            const sss = this.sessions.get(sessionId);
            if (!sss || sss.hasUserSpoken || sss.isClosing || sss.isCleaning) return;
            if (sss.callLog && !sss.callLog.disposition) sss.callLog.disposition = "NO_ANSWER";
            await this.politeHangup(sessionId, { finalMessage: "Sorry, I can not hear you. Goodbye." });
          });
        }
      };

      const prewarmed = s._prewarmedGreetingStream || null;
      s._prewarmedGreetingStream = null;
      if (prewarmed) {
        prewarmed
          .then((stream) => {
            const sf = this.sessions.get(sessionId);
            if (!sf || sf.isClosing || sf.isCleaning) { onFallbackComplete(); return; }
            if (stream) {
              sf.ttsQueue.unshift({ text: fallback, _preloadedStream: stream, onComplete: onFallbackComplete });
              this.runTTSQueue(sessionId).catch(() => { });
            } else {
              this.enqueueTTS(sessionId, fallback, { flush: true, onComplete: onFallbackComplete });
            }
          })
          .catch(() => { this.enqueueTTS(sessionId, fallback, { flush: true, onComplete: onFallbackComplete }); });
      } else {
        this.enqueueTTS(sessionId, fallback, { flush: true, onComplete: onFallbackComplete });
      }
    });
  }

  onUserSpeechStarted(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._markUserActivity(session);

    const us = session.userSpeech;
    us.utteranceId += 1; us.isSpeaking = true; us.buffer = "";
    us.lastInterimTime = Date.now(); us.startedAt = Date.now();

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    if (us.hardMaxTimer) { clearTimeout(us.hardMaxTimer); us.hardMaxTimer = null; }

    us.hardMaxTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this._finalizeUtterance(sessionId, { reason: "hard_max", utteranceId: us.utteranceId });
    }, UTTERANCE_HARD_MAX_MS);

    if (session.isSpeaking) {
      // Echo guard: ignore speech that starts within ECHO_GUARD_MS of when TTS *began*
      // (not lastAiAudioSentAt which updates every 20ms and would block all barge-ins)
      const sinceAiSpoke = Date.now() - (session.lastAiSpokeAt || 0);
      if (sinceAiSpoke < ECHO_GUARD_MS) return;
      us.pendingBargeIn = true;
      if (us.bargeInConfirmTimer) { clearTimeout(us.bargeInConfirmTimer); us.bargeInConfirmTimer = null; }
      us.bargeInConfirmTimer = setTimeout(() => {
        const ss = this.sessions.get(sessionId);
        if (!ss) return;
        if (ss.userSpeech.pendingBargeIn && (ss.userSpeech.buffer || "").trim().length < 3) ss.userSpeech.pendingBargeIn = false;
      }, BARGEIN_CONFIRM_MS);
    }
  }

  onDeepgramTranscript(sessionId, text, isFinal, speechFinal) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const trimmed = (text || "").trim();
    if (!trimmed) return;

    if (VOICEMAIL_REGEX.test(trimmed)) {
      logger.info(`[${sessionId}] Voicemail detected (regex) — hanging up`);
      if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "VOICEMAIL";
      this.endTwilioCall(sessionId).catch(() => { });
      this.cleanupSession(sessionId, { endedBy: "voicemail_detected" }).catch(() => { });
      return;
    }

    // ── TV / BACKGROUND NOISE FILTER ──────────────────────────────────────
    // Ignore ambient audio: TV voices, radio, distant conversations.
    // Only respond to clear, direct, close-to-phone human speech.
    const wc = wordCount(trimmed);
    if (isFinal && looksLikeTVNoise(trimmed, wc)) {
      logger.info(`[${sessionId}] TV/background noise detected — ignoring: "${trimmed.slice(0, 60)}"`);
      return;
    }

    // ── AUDIO-LEVEL AMD: Long continuous speech in first 8s = likely voicemail greeting
    if (!session.openingComplete && !session._amdCleared) {
      const callAge = Date.now() - session.startTime;
      if (callAge < 8000 && isFinal && wordCount(trimmed) >= 10) {
        logger.info(`[${sessionId}] AMD: long continuous speech in first 8s (${wordCount(trimmed)} words)`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "ANSWERING_MACHINE";
        this.endTwilioCall(sessionId).catch(() => { });
        this.cleanupSession(sessionId, { endedBy: "audio_amd_detected" }).catch(() => { });
        return;
      }
      if (isFinal && wordCount(trimmed) <= 4) session._amdCleared = true;
    }

    this._markUserActivity(session);
    const us = session.userSpeech;
    us.lastInterimTime = Date.now();
    us.buffer = trimmed;

    if (session.isSpeaking && us.pendingBargeIn) {
      if (isFiller(trimmed)) { us.pendingBargeIn = false; }
      else if (isStrongInterrupt(trimmed)) {
        logger.info(`[${sessionId}] BARGE-IN (strong interrupt)`);
        us.pendingBargeIn = false;
        session._wasInterrupted = true;
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
      }
    }

    // ── GREETING INTERRUPT SYSTEM ──────────────────────────────────────────
    // During introduction, customers commonly say short phrases. ALL of these
    // get hardcoded responses — zero LLM. Fires on interim OR final transcripts.
    // Categories:
    //   HELLO: hello, hi, hey, yo → greet back + restart intro
    //   ACK:   yes, yeah, okay, mm-hmm → continue to Part 2 / Q1
    //   QUERY: who is this, what do you want, what's up → explain + ask permission
    //   DNC:   stop calling, not interested → handled by existing DNC/objection path
    //
    // Mid-call: same words → greet/acknowledge + re-ask current question
    // ─────────────────────────────────────────────────────────────────────────

    const GREETING_INTERRUPT_REGEX = /^(hello+|hey+|hi+|yo+|what.?s up|yes|yeah|yep|yup|okay|ok|sure|mm-?hmm|mhm|uh-?huh|who is this|who.?s this|who.?s calling|who are you|what do you (want|need)|what is this|what.?s this about|can you hear me|are you there)\b/i;
    const IS_HELLO_TYPE = /^(hello+|hey+|hi+|yo+|what.?s up)\b/i;
    const IS_ACK_TYPE = /^(yes|yeah|yep|yup|okay|ok|sure|mm-?hmm|mhm|uh-?huh|can you hear me|are you there)\b/i;
    const IS_QUERY_TYPE = /^(who is this|who.?s this|who.?s calling|who are you|what do you (want|need)|what is this|what.?s this about)\b/i;

    if (session.isSpeaking && GREETING_INTERRUPT_REGEX.test(trimmed)) {
      const sinceAiSpoke = Date.now() - (session.lastAiSpokeAt || 0);
      if (sinceAiSpoke >= ECHO_GUARD_MS && !session._interruptHandled) {
        logger.info(`[${sessionId}] GREETING INTERRUPT: "${trimmed}" — stopping TTS + immediate response`);
        session._interruptHandled = true; // Prevent _finalizeUtterance from double-firing
        session._wasInterrupted = true;
        us.pendingBargeIn = false;
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);

        setImmediate(() => {
          const s = this.sessions.get(sessionId);
          if (!s || s.isClosing || s.isCleaning) return;

          let response;

          if (!s.openingComplete) {
            // ── DURING GREETING ──────────────────────────────────────────
            s.openingComplete = true;
            s.currentStage = "qualification";
            s.currentQuestionNum = 1;
            s.greetingCompletedAt = Date.now();
            s.hasRealInput = true;
            s._wasInterrupted = false;

            if (IS_HELLO_TYPE.test(trimmed)) {
              // "hello" / "hey" / "hi" → greet back + SHORT version of why calling
              response = `oh hi. yeah I am just calling to check you do not miss any extra health benefits. would you be open to a quick review?`;
            } else if (IS_ACK_TYPE.test(trimmed)) {
              // "yes" / "yeah" / "okay" → they heard us, SHORT Part 2
              response = `yeah so I am just calling to make sure you are not missing out on any extra health benefits. would you be open to a quick review?`;
            } else if (IS_QUERY_TYPE.test(trimmed)) {
              // "who is this" / "what do you want" → SHORT explain + ask permission
              response = `this is Anna from Health Subsidy Center - just checking if you might qualify for a health subsidy. would it be okay if I ask you one quick question?`;
            } else {
              // Fallback — SHORT restart
              response = `oh hi. I am just calling to check you do not miss any extra benefits. would you be open to a quick review?`;
            }

            logger.info(`[${sessionId}] Greeting interrupt (${trimmed}) → hardcoded response`);
            this._enqueueQuestion(sessionId, response, { flush: true });
            s.conversationHistory.push({ role: "user", content: trimmed });
            s.conversationHistory.push({ role: "assistant", content: response });
            s.conversationHistory = s.conversationHistory.slice(-HISTORY_LIMIT);

          } else {
            // ── MID-CALL ─────────────────────────────────────────────────
            s._wasInterrupted = false;
            const lastQ = s.state?.lastAskedQuestionText;

            if (IS_HELLO_TYPE.test(trimmed)) {
              // Hello mid-call → greet back + re-ask SHORT
              if (lastQ) {
                response = `oh hi. sorry about that - ${lastQ}`;
              } else if (s.currentQuestionNum === 1) {
                response = `oh hi. so would you be open to a quick check on your health subsidy options?`;
              } else if (s.currentQuestionNum === 2) {
                response = `oh hi. ${pickRotation(s, "q2_reask", Q2_REASK)}`;
              } else {
                response = `oh hi. yeah sorry, go ahead.`;
              }
            } else {
              // Other mid-call interrupt — SHORT acknowledge + re-ask
              if (lastQ) {
                response = `sorry about that - ${lastQ}`;
              } else {
                response = `yeah sorry, go ahead.`;
              }
            }

            logger.info(`[${sessionId}] Mid-call interrupt (${trimmed}) → hardcoded response`);
            this._enqueueQuestion(sessionId, response, { flush: true });
            s.conversationHistory.push({ role: "user", content: trimmed });
            s.conversationHistory.push({ role: "assistant", content: response });
            s.conversationHistory = s.conversationHistory.slice(-HISTORY_LIMIT);
          }

          s.transcriptChunks.push(trimmed);
          this.armMidCallSilence(sessionId);
          // Mark utterance as handled so _finalizeUtterance skips it
          us.buffer = "";
          us.isSpeaking = false;
        });
      }
    }

    if (!isFinal && !speechFinal) {
      if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
      return;
    }

    if (us.finalizeTimer) { clearTimeout(us.finalizeTimer); us.finalizeTimer = null; }
    this._finalizeUtterance(sessionId, { reason: speechFinal ? "speech_final" : "is_final", utteranceId: us.utteranceId });
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
    us.isSpeaking = false; us.buffer = "";
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

    if (!session.openingComplete) {
      // If the interim handler in onDeepgramTranscript already handled this interrupt,
      // don't fire again. Reset the flag for next utterance.
      if (session._interruptHandled) {
        session._interruptHandled = false;
        logger.info(`[${sessionId}] Greeting interrupt already handled by interim — skipping finalize`);
        return;
      }

      const openingNorm = (session.openingLine || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      const utterNorm = utterance.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      if (openingNorm && utterNorm.length >= 4) {
        const firstWords = openingNorm.split(/\s+/).slice(0, 6).join(" ");
        if (openingNorm.startsWith(utterNorm) || firstWords.startsWith(utterNorm.split(/\s+/).slice(0, 4).join(" "))) {
          logger.info(`[${sessionId}] Echo suppressed: "${utterance}"`); return;
        }
      }

      // ── GREETING INTERRUPTION — ALL COMMON RESPONSES HARDCODED ────────
      // Same categories as the interim handler in onDeepgramTranscript.
      // This path fires when the interrupt arrives on a final transcript
      // (not interim), or if setImmediate hasn't cleared the buffer yet.
      const GREETING_INT_HELLO = /^(hello+|hey+|hi+|yo+|what.?s up)\b/i;
      const GREETING_INT_ACK = /^(yes|yeah|yep|yup|okay|ok|sure|mm-?hmm|mhm|uh-?huh|can you hear me|are you there)\b/i;
      const GREETING_INT_QUERY = /^(who is this|who.?s this|who.?s calling|who are you|what do you (want|need)|what is this|what.?s this about)\b/i;
      const isGreetingInterrupt = GREETING_INT_HELLO.test(utterance) || GREETING_INT_ACK.test(utterance) || GREETING_INT_QUERY.test(utterance);

      if (isGreetingInterrupt) {
        logger.info(`[${sessionId}] Greeting interrupt (finalize path): "${utterance}"`);
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
        session.openingComplete = true;
        session.currentStage = "qualification";
        session.currentQuestionNum = 1;
        session.greetingCompletedAt = Date.now();
        session.hasRealInput = true;

        let response;
        if (GREETING_INT_HELLO.test(utterance)) {
          response = `oh hi. yeah I am just calling to check you do not miss any extra health benefits. would you be open to a quick review?`;
        } else if (GREETING_INT_ACK.test(utterance)) {
          response = `yeah so I am just calling to make sure you are not missing out on any extra health benefits. would you be open to a quick review?`;
        } else if (GREETING_INT_QUERY.test(utterance)) {
          response = `this is Anna from Health Subsidy Center - just checking if you might qualify for a health subsidy. would it be okay if I ask you one quick question?`;
        } else {
          response = `oh hi. I am just calling to check you do not miss any extra benefits. would you be open to a quick review?`;
        }

        this._enqueueQuestion(sessionId, response, { flush: true });
        session.conversationHistory.push({ role: "user", content: utterance });
        session.conversationHistory.push({ role: "assistant", content: response });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
        this.armMidCallSilence(sessionId);
        return;
      }

      if (isStrongInterrupt(utterance) && !isFiller(utterance)) {
        // Longer interruption during greeting — DNC, objections, questions
        logger.info(`[${sessionId}] Strong interrupt during greeting: "${utterance}"`);
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
        session.openingComplete = true;
        session.currentStage = "qualification";
        session.currentQuestionNum = 1;
        session.greetingCompletedAt = Date.now();
        session.hasRealInput = true;

        if (detectDncIntent(utterance)) {
          if (session.callLog) session.callLog.disposition = "DNC";
          this.politeHangup(sessionId, { finalMessage: "of course, I will make sure we do not contact you again. you have a good day." }).catch(() => { });
          return;
        }

        const objection = detectObjection(utterance);
        if (objection) {
          this._handleObjection(sessionId, objection, 1).then((handled) => {
            if (!handled) this._processWithLLM(sessionId, utterance).catch(() => { });
          }).catch(() => { });
          return;
        }

        this._processWithLLM(sessionId, utterance).catch(() => { });
        return;
      }

      // Not a recognized interrupt — buffer until greeting finishes
      logger.info(`[${sessionId}] Greeting in progress — buffering: "${utterance}"`);
      return;
    }

    if (session.openingComplete && !session.hasRealInput && isPostGreetingFiller(utterance)) {
      logger.info(`[${sessionId}] Post-greeting filler absorbed: "${utterance}"`); return;
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

    // If the interim handler already handled this utterance, skip
    if (session._interruptHandled) {
      session._interruptHandled = false;
      logger.info(`[${sessionId}] Interrupt already handled — skipping _processValidatedUtterance`);
      return;
    }

    session.turnRules.forcedPrefix = null;
    session.turnRules.disallowAck = false;
    session.turnRules.disallowSocial = false;
    session.turnRules.disableBackchannel = false;
    session.hasRealInput = true;

    // ── 0. MID-CALL HELLO INTERRUPT — hardcoded, no LLM ────────────────────
    // Customer says "hello"/"hi"/"hey" while bot was speaking mid-call.
    // Respond immediately: greet back + re-state what we were doing.
    const isHelloMidCall = /^(hello+|hey+|hi+)\b/i.test(utterance.trim());
    if (session.openingComplete && isHelloMidCall && session._wasInterrupted) {
      logger.info(`[${sessionId}] HELLO mid-call interrupt — hardcoded response`);
      this.stopTTS(sessionId);
      this.sendClearToTwilio(sessionId);
      const lastQ = session.state?.lastAskedQuestionText;
      let response;
      if (lastQ) {
        response = `oh hi. sorry about that - ${lastQ}`;
      } else if (session.currentQuestionNum === 1) {
        response = `oh hi. so would you be open to a quick check on your health subsidy options?`;
      } else if (session.currentQuestionNum === 2) {
        const reask = pickRotation(session, "q2_reask", Q2_REASK);
        response = `oh hi. ${reask}`;
      } else {
        response = `oh hi. yeah sorry, go ahead.`;
      }
      this._enqueueQuestion(sessionId, response, { flush: true });
      session.conversationHistory.push({ role: "user", content: utterance });
      session.conversationHistory.push({ role: "assistant", content: response });
      session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
      session._wasInterrupted = false;
      this.armMidCallSilence(sessionId);
      return;
    }
    // Clear the flag if it wasn't a hello (other interruptions flow normally)
    if (session._wasInterrupted && !isHelloMidCall) session._wasInterrupted = false;

    // ── 1. DNC — always first ─────────────────────────────────────────────────
    if (session.openingComplete && detectDncIntent(utterance)) {
      logger.info(`[${sessionId}] DNC: "${utterance}"`);
      if (session.callLog) session.callLog.disposition = "DNC";
      session.state.interestConfirmed = false;
      this.politeHangup(sessionId, { finalMessage: "Thank you for your time. Have a great day." }).catch(() => { });
      return;
    }

    // ── 2. REPEAT REQUEST — bypass LLM, replay exact question ────────────────
    if (session.openingComplete && detectRepeatRequest(utterance)) {
      const lastQ = session.state?.lastAskedQuestionText;
      if (lastQ) {
        logger.info(`[${sessionId}] Repeat request — replaying: "${lastQ.slice(0, 60)}"`);
        this.stopTTS(sessionId);
        this.sendClearToTwilio(sessionId);
        this._enqueueQuestion(sessionId, `uh <break time="300ms"/> sure - ${lastQ}`, { flush: true });
      } else {
        logger.warn(`[${sessionId}] Repeat request but no lastAskedQuestionText — falling through to LLM`);
        this.handleUserUtterance(sessionId, utterance).catch(() => { });
      }
      return;
    }

    // ── 3. Direct Q1 handler — HARDCODED RESPONSES ────────────────────────────
    // YES → speaks Q2 directly (no LLM), returns true
    // NO  → rebuttal or hangup, returns true
    // Objections → hardcoded response, returns true
    // Unclear → returns false → LLM handles
    if (session.openingComplete && session.currentStage === "qualification" && session.currentQuestionNum === 1) {
      this._handleDirectQ1(sessionId, utterance)
        .then((handled) => { if (!handled) this._processWithLLM(sessionId, utterance); })
        .catch((e) => logger.error(`[${sessionId}] _handleDirectQ1 error: ${e.message}`));
      return;
    }

    // ── 4. Direct Q2 handler — HARDCODED RESPONSES ────────────────────────────
    // NO (qualifies) → speaks transfer message directly, returns true
    // YES (disqualifies) → speaks disqualify + hangup, returns true
    // Unclear → returns false → LLM handles re-ask
    if (session.openingComplete && session.currentStage === "qualification" && session.currentQuestionNum === 2) {
      this._handleDirectQ2(sessionId, utterance)
        .then((handled) => { if (!handled) this._processWithLLM(sessionId, utterance); })
        .catch((e) => logger.error(`[${sessionId}] _handleDirectQ2 error: ${e.message}`));
      return;
    }

    // ── 4b. Global objection catch (any stage) ────────────────────────────────
    // Catches objections that arrive outside Q1/Q2 flow (e.g. during wrapup)
    if (session.openingComplete) {
      const objection = detectObjection(utterance);
      if (objection) {
        this._handleObjection(sessionId, objection, session.currentQuestionNum)
          .then((handled) => { if (!handled) this._processWithLLM(sessionId, utterance); })
          .catch((e) => logger.error(`[${sessionId}] _handleObjection error: ${e.message}`));
        return;
      }
    }

    // ── 5. Social / digression / general qualification ────────────────────────
    const toneHint = detectToneHint(utterance);

    if (session.openingComplete && (isSocialResponse(utterance) || containsReciprocalQuestion(utterance))) {
      session.lastUserInputType = "social";
      // No forcedPrefix — LLM handles social replies naturally from the prompt.
      // forcedPrefix was stacking with LLM output ("oh nice, glad to hear that. okay so...")
      session.turnRules.disallowAck = true;
      session.turnRules.disallowSocial = false;
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
      const emotional = toneHint === "positive" || toneHint === "negative" || toneHint === "hostile";
      const turnsSinceAck = session.activeTurnId - session.lastAckTurn;
      session.turnRules.disallowAck = !(turnsSinceAck >= 3 && (longAnswer || emotional));
      if (session.pausedQuestionNum !== null) {
        logger.info(`[${sessionId}] Digression resolved → Q${session.currentQuestionNum}`);
        session.pausedQuestionNum = null;
      }
    }

    this.handleUserUtterance(sessionId, utterance).catch((e) => {
      if (e?.name !== "AbortError") logger.error(`[${sessionId}] handleUserUtterance failed: ${e.message}`);
    });
  }

  // ── _handleDirectQ1 ─────────────────────────────────────────────────────────
  // HARDCODED RESPONSES — bypasses LLM for zero latency.
  // All wording comes from the prompt's ## GREETING and ## OBJECTIONS sections.
  // LLM only called for unclear/unexpected inputs (return false).
  async _handleDirectQ1(sessionId, utterance) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return false;

    // DNC — immediate hangup
    if (detectDncIntent(utterance)) {
      session.state.interestConfirmed = false;
      if (session.callLog) session.callLog.disposition = "DNC";
      await this.politeHangup(sessionId, { finalMessage: "of course, I will make sure we do not contact you again. you have a good day." });
      return true;
    }

    // Objections — handle with hardcoded responses
    const objection = detectObjection(utterance);
    if (objection) {
      const handled = await this._handleObjection(sessionId, objection, 1);
      if (handled) return true;
    }

    // YES — speak Q2 directly, no LLM
    if (detectYesIntent(utterance)) {
      session.state.interestConfirmed = true;
      session.state.capturedAnswers.q1 = "yes";
      session.currentStage = "qualification";
      session.currentQuestionNum = 2;
      const q2Text = pickRotation(session, "q1_yes_to_q2", Q1_YES_TO_Q2);
      logger.info(`[${sessionId}] Q1 YES (direct) → speaking Q2 hardcoded`);
      this._enqueueQuestion(sessionId, q2Text, { flush: true });
      session.conversationHistory.push({ role: "user", content: utterance });
      session.conversationHistory.push({ role: "assistant", content: q2Text });
      session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
      this.armMidCallSilence(sessionId);
      return true;
    }

    // NO / not interested — rebuttal first time, goodbye second time
    if (detectQ1NegativeIntent(utterance)) {
      if (!session._q1RebuttalUsed) {
        session._q1RebuttalUsed = true;
        const rebuttal = pickRotation(session, "q1_rebuttal", Q1_NOT_INTERESTED_REBUTTAL);
        logger.info(`[${sessionId}] Q1 NO (direct) → rebuttal`);
        this._enqueueQuestion(sessionId, rebuttal, { flush: true });
        session.conversationHistory.push({ role: "user", content: utterance });
        session.conversationHistory.push({ role: "assistant", content: rebuttal });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
        this.armMidCallSilence(sessionId);
        return true;
      } else {
        // Insists no — goodbye
        session.state.interestConfirmed = false;
        if (session.callLog) session.callLog.disposition = "NOT_INTERESTED";
        await this.politeHangup(sessionId, { finalMessage: Q1_INSIST_NO_GOODBYE });
        return true;
      }
    }

    return false; // unclear → LLM handles
  }

  // ── _handleDirectQ2 ─────────────────────────────────────────────────────────
  // HARDCODED RESPONSES — bypasses LLM for zero latency.
  // All wording comes from the prompt's ## QUALIFICATION section.
  async _handleDirectQ2(sessionId, utterance) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return false;

    // DNC — immediate hangup
    if (detectDncIntent(utterance)) {
      session.state.qualified = false;
      if (session.callLog) session.callLog.disposition = "DNC";
      await this.politeHangup(sessionId, { finalMessage: "of course, I will make sure we do not contact you again. you have a good day." });
      return true;
    }

    // Hard-stop that is NOT a Q2 answer
    const isHardStop = detectHardStopIntent(utterance);
    const isNoAnswer = detectNoIntent(utterance) ||
      /\b(i do not|i don.?t|not on|no i|not any|none of|none|never|don.?t have|do not have)\b/i.test(normalizeIntentText(utterance));
    if (isHardStop && !isNoAnswer) {
      session.state.qualified = false;
      if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "NOT_INTERESTED";
      await this.politeHangup(sessionId, { finalMessage: "okay, no problem. you have a good day." });
      return true;
    }

    // NO (no govt coverage = QUALIFIES) → speak transfer message directly
    if (isNoAnswer) {
      session.state.govtCoverageChecked = true;
      session.state.qualified = true;
      session.state.capturedAnswers.q2 = "no";
      session.currentStage = "wrapup";
      if (session.callLog) session.callLog.disposition = "TRANSFERRED_TO_AGENT";
      const transferText = pickRotation(session, "q2_no_qualifies", Q2_NO_QUALIFIES);
      logger.info(`[${sessionId}] Q2 NO (direct) → speaking transfer message hardcoded`);
      this.enqueueTTS(sessionId, transferText, { flush: true });
      session.conversationHistory.push({ role: "user", content: utterance });
      session.conversationHistory.push({ role: "assistant", content: transferText });
      session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
      // Transfer after TTS drains
      setTimeout(() => this._speakThenTransfer(sessionId), TRANSFER_DELAY_MS);
      return true;
    }

    // YES (has govt coverage = DISQUALIFIES) → polite end
    const isYesAnswer = detectYesIntent(utterance) ||
      /\b(i am|i.?m on|yes i|yeah i|i have|currently on|enrolled in|i.?ve got)\b/i.test(normalizeIntentText(utterance));
    if (isYesAnswer) {
      session.state.govtCoverageChecked = false;
      session.state.qualified = false;
      session.state.capturedAnswers.q2 = "yes";
      session.currentStage = "closing";
      if (session.callLog) session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
      const disqualifyText = pickRotation(session, "q2_yes_disqualifies", Q2_YES_DISQUALIFIES);
      logger.info(`[${sessionId}] Q2 YES (direct) → speaking disqualify message hardcoded`);
      await this.politeHangup(sessionId, { finalMessage: disqualifyText });
      return true;
    }

    return false; // unclear → LLM handles re-ask
  }

  // ── _handleObjection ────────────────────────────────────────────────────────
  // Hardcoded objection handling — all wording from prompt ## OBJECTIONS.
  // Returns true if fully handled, false to fall through to LLM.
  async _handleObjection(sessionId, objectionType, currentQ) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return false;

    let responseText = null;
    let shouldHangup = false;
    let disposition = null;

    switch (objectionType) {
      case "ABUSE":
        // Abusive language — END immediately, no response
        disposition = "ABUSIVE";
        shouldHangup = true;
        break;

      case "HOW_GOT_NUMBER":
        responseText = pickRotation(session, "obj_how_number", OBJ_HOW_GOT_NUMBER);
        break;

      case "ARE_YOU_AI":
        responseText = OBJ_ARE_YOU_AI;
        break;

      case "ALREADY_COVERED":
        responseText = OBJ_ALREADY_COVERED;
        break;

      case "BUSY":
        responseText = OBJ_BUSY;
        shouldHangup = true;
        disposition = "BUSY";
        break;

      case "COST":
        responseText = OBJ_COST;
        break;

      case "SCAM": {
        responseText = OBJ_SCAM;
        break;
      }

      case "SEND_INFO":
        responseText = OBJ_SEND_INFO;
        break;

      case "IS_GOVT":
        responseText = OBJ_IS_GOVT;
        break;

      case "WHAT_SUBSIDY":
        responseText = pickRotation(session, "obj_what_subsidy", OBJ_WHAT_SUBSIDY);
        break;

      case "HOW_LONG":
        responseText = OBJ_HOW_LONG;
        break;

      case "NOT_DECISION_MAKER":
        responseText = OBJ_NOT_DECISION_MAKER;
        shouldHangup = true;
        disposition = "NOT_DECISION_MAKER";
        break;

      case "WRONG_PERSON":
        responseText = OBJ_WRONG_PERSON;
        shouldHangup = true;
        disposition = "MISDIALED";
        break;

      default:
        return false;
    }

    if (shouldHangup) {
      if (disposition && session.callLog && !session.callLog.disposition) session.callLog.disposition = disposition;
      if (responseText) {
        await this.politeHangup(sessionId, { finalMessage: responseText });
      } else {
        // ABUSE — silent hangup
        await this.politeHangup(sessionId, {});
      }
      return true;
    }

    if (responseText) {
      logger.info(`[${sessionId}] Objection ${objectionType} → hardcoded response`);
      this.enqueueTTS(sessionId, responseText, { flush: true });
      session.conversationHistory.push({ role: "user", content: `[${objectionType}]` });
      session.conversationHistory.push({ role: "assistant", content: responseText });
      session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);
      this.armMidCallSilence(sessionId);
      return true;
    }

    return false;
  }

  async handleUserUtterance(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;
    if ((session.currentStage === "wrapup" || session.currentStage === "closing") && (session.transferAttempted || session.transferPending || session._finalHangupInProgress)) {
      logger.info(`[${sessionId}] Wrapup/closing active — ignoring input`);
      return;
    }
    await this._processWithLLM(sessionId, userText);
  }

  async _processWithLLM(sessionId, userText) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    if ((session.currentStage === "wrapup" || session.currentStage === "closing") && (session.transferAttempted || session.transferPending || session._finalHangupInProgress)) {
      logger.info(`[${sessionId}] Wrapup/closing active — ignoring input`);
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

    try {
      const systemPrompt = this._buildSystemPrompt(session);
      const historyForModel = session.conversationHistory.slice(-HISTORY_FOR_MODEL);

      logger.info(`[${sessionId}] LLM_START turn=${myTurnId} stage=${session.currentStage} Q=${session.currentQuestionNum} type=${session.lastUserInputType}`);
      session._pendingQuestion = false;

      const wasJustInterrupted = !!session._wasInterrupted;
      session._wasInterrupted = false;

      // forcedPrefix: social reply injected before LLM response
      const hasForcedPrefix = !!(session.turnRules?.forcedPrefix);
      if (!wasJustInterrupted && hasForcedPrefix) {
        const prefix = safeTTS(session.turnRules.forcedPrefix);
        if (prefix) { session.lastAckTurn = myTurnId; this.enqueueTTS(sessionId, prefix); }
      }

      let fullText = "", firstTokenAt = 0, firstChunkSent = false, lastQuestionChunk = null;

      const customerGaveLongAnswer = wordCount(userText) >= 4;
      const customerAskedQuestion = userText.includes("?") || isDigression(userText);
      if (!wasJustInterrupted && !hasForcedPrefix && !customerGaveLongAnswer && !customerAskedQuestion) {
        thinkingFillerTimer = setTimeout(() => {
          const s = this.sessions.get(sessionId);
          if (!s || s.activeTurnId !== myTurnId || firstChunkSent || llmController.signal.aborted) return;
          if (s.lastUserInputType === "social") return;
          if (s.ttsQueue.length > 0) return;
          if (myTurnId % 3 !== 0) return;
          const POOL = ["mm-hmm.", "okay.", "mm."];
          thinkingFillerFired = true;
          this.enqueueTTS(sessionId, POOL[myTurnId % POOL.length]);
        }, THINKING_FILLER_MS);
      }

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

        // Deduplicate questions
        if (san.includes("?")) {
          const qNorm = san.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
          if (lastQuestionChunk) {
            const prevNorm = lastQuestionChunk.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
            const qWords = qNorm.split(" ").filter((w) => w.length > 3);
            const prevWords = new Set(prevNorm.split(" ").filter((w) => w.length > 3));
            const overlap = qWords.filter((w) => prevWords.has(w)).length;
            if (Math.max(qWords.length, prevWords.size) > 0 && overlap / Math.max(qWords.length, prevWords.size) >= 0.6) {
              logger.info(`[${sessionId}] Duplicate question suppressed turn=${myTurnId}`); return;
            }
          }
          lastQuestionChunk = san;
          // Record every LLM-generated question for exact repeat replay
          const cleanSan = sanitizeForTTS(san);
          if (cleanSan && s.state) s.state.lastAskedQuestionText = cleanSan;
        }

        logger.info(`[${sessionId}] TTS_CHUNK turn=${myTurnId}: "${san.slice(0, 60)}"`);

        if (!firstChunkSent) {
          if (thinkingFillerTimer) clearTimeout(thinkingFillerTimer);
          firstChunkSent = true;

          const capturedText = san;
          const capturedTurnId = myTurnId;
          const alreadyQueued = thinkingFillerFired || hasForcedPrefix;

          this.getAudioStream(sessionId, capturedText)
            .then((resolvedStream) => {
              if (!resolvedStream) {
                const sf = this.sessions.get(sessionId);
                if (sf && !sf.isClosing && sf.activeTurnId === capturedTurnId) this.enqueueTTS(sessionId, capturedText);
                return;
              }
              const sf = this.sessions.get(sessionId);
              if (!sf || sf.isClosing || sf.isCleaning || sf.activeTurnId !== capturedTurnId) return;
              if (alreadyQueued) { sf.ttsQueue.push({ text: capturedText, _preloadedStream: resolvedStream }); }
              else { sf.ttsQueue.unshift({ text: capturedText, _preloadedStream: resolvedStream }); }
              this.runTTSQueue(sessionId).catch(() => { });
            })
            .catch(() => {
              const sf = this.sessions.get(sessionId);
              if (sf && !sf.isClosing && sf.activeTurnId === capturedTurnId) this.enqueueTTS(sessionId, capturedText);
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

      if (thinkingFillerTimer) clearTimeout(thinkingFillerTimer);
      thinkingFillerTimer = null;
      chunker.end();

      logger.info(`[${sessionId}] LLM_COMPLETE turn=${myTurnId} total=${Date.now() - t0}ms`);

      const aiTextClean = sanitizeForTTS(fullText);
      if (aiTextClean && /^(?:\s*(?:oh\s+nice|mhm|mhmm|mm|okay\s+sure|okay,?\s+sure|okay|sure|right)\b)/i.test(aiTextClean.trim())) {
        session.lastAckTurn = myTurnId;
      }

      if (session.activeTurnId === myTurnId) {
        session.conversationHistory.push({ role: "user", content: userText });
        if (aiTextClean) session.conversationHistory.push({ role: "assistant", content: aiTextClean });
        session.conversationHistory = session.conversationHistory.slice(-HISTORY_LIMIT);

        this._parseAndUpdateQualificationState(session, userText, fullText);
        this._maybeAdvanceStage(session, fullText);

        if (session.currentStage === "wrapup" && session.state.qualified && !session.transferAttempted) {
          setTimeout(() => this._speakThenTransfer(sessionId), TRANSFER_DELAY_MS);
        }
      }

      if (session._shouldHangupAfterTTS) {
        session._shouldHangupAfterTTS = false;
        this._hangupAfterTTSIdle(sessionId);
      }

      session.lastUserInputType = "qualification";
      session.state.retriesCantHear = 0;

    } catch (e) {
      if (e?.name !== "AbortError") {
        logger.error(`[${sessionId}] _processWithLLM error: ${e.message}`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      }
    } finally {
      if (thinkingFillerTimer) clearTimeout(thinkingFillerTimer);
      thinkingFillerTimer = null;
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isProcessingUtterance = false;
        if (s.activeTurnId === myTurnId) s.llmAbort = null;
      }
    }
  }

  async _speakThenTransfer(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing || session.isCleaning) return;

    session.currentStage = "wrapup";
    session.transferPending = true;
    this._clearAllTimers(session);

    await this._waitForTTSIdle(sessionId, 12000);
    session.transferPending = false;
    await this._maybeTransferCall(sessionId);
  }

  async _hangupAfterTTSIdle(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isCleaning) return;
    session._finalHangupInProgress = true;
    session.currentStage = "wrapup";
    this._clearAllTimers(session);
    logger.info(`[${sessionId}] _hangupAfterTTSIdle — waiting for TTS`);
    try { await this._waitForTTSIdle(sessionId, 10000); } catch { }
    session.isClosing = true;
    await this.endTwilioCall(sessionId);
    await this.cleanupSession(sessionId, { endedBy: "negative_response" });
  }

  _buildSystemPrompt(session) {
    return STATIC_SYSTEM_PROMPT + "\n" + this._buildRuntimeState(session);
  }

  _buildRuntimeState(session) {
    const st = session.state || {};

    const q1 = st.interestConfirmed === null ? "pending" : st.interestConfirmed === true ? "pass" : "fail";
    const q2 = st.govtCoverageChecked === null ? "pending" : st.govtCoverageChecked === true ? "pass(no-govt)" : "fail(has-govt)";

    let turnInstruction = "";
    if (session.lastUserInputType === "social") {
      if (session.turnRules?.forcedPrefix) {
        turnInstruction = `TURN=SOCIAL | Social reply already spoken. Output ONLY: QC block + Q${session.currentQuestionNum}. No ack, no social line.`;
      } else {
        turnInstruction = `TURN=SOCIAL | First: warm reaction (1 sentence). Second: Q${session.currentQuestionNum}. Question goes LAST.`;
      }
    } else if (session.lastUserInputType === "digression") {
      const q = session.pausedQuestionNum || session.currentQuestionNum;
      turnInstruction = `TURN=DIGRESSION | QC skip q=${q} next=${q}. Answer their question (1 sentence). Re-ask Q${q} at the end with DIFFERENT wording from the prompt. Never advance.`;
    }

    const greetingLine = session.openingComplete
      ? `GREETING_COMPLETE=true | Mid-call. Never re-introduce yourself.`
      : `GREETING_IN_PROGRESS`;

    const wrapupLine = session.currentStage === "wrapup"
      ? `WRAPUP | Qualified — transfer in progress. No new questions.`
      : session.currentStage === "closing"
        ? `CLOSING | Customer does NOT qualify. End the call politely. NO transfer. NO agent.`
        : "";

    const lastQLine = st.lastAskedQuestionText
      ? `LAST_QUESTION_TEXT: "${st.lastAskedQuestionText}"`
      : `LAST_QUESTION_TEXT: none`;

    return [
      `\n---`,
      `## LIVE CALL STATE`,
      greetingLine,
      wrapupLine,
      turnInstruction,
      `stage=${session.currentStage} next=Q${session.currentQuestionNum} Q1=${q1} Q2=${q2}`,
      lastQLine,
      `ack_allowed=${!session.turnRules?.disallowAck}`,
      `RULE: QC block FIRST. Stop after "?". Nothing after the question mark.`,
      `REPEAT RULE: If user asked to repeat, speak LAST_QUESTION_TEXT exactly. Do not rephrase. QC skip.`,
      `---`,
    ].filter(Boolean).join("\n");
  }

  _parseAndUpdateQualificationState(session, userText, rawLLMText) {
    const qcMatch = (rawLLMText || "").match(/<QC>([\s\S]*?)<\/QC>/i);
    if (!qcMatch) {
      logger.warn(`[${session.id}] No QC block — fallback parse`);
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
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "NOT_INTERESTED";
      } else if (q === 2) {
        st.govtCoverageChecked = false;
        st.qualified = false;
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
      }
      session._shouldHangupAfterTTS = true;
      logger.info(`[${session.id}] QC fail q=${q} — hangup after TTS`);
      return;
    }

    if (result === "pass") {
      if (q === 1) {
        st.interestConfirmed = true;
        session.currentQuestionNum = (typeof next === "number" && next > 0) ? next : 2;
        logger.info(`[${session.id}] QC Q1 pass → Q${session.currentQuestionNum}`);
        return;
      }
      if (q === 2) {
        // Guard: if direct handler already set "closing" (disqualified), never let LLM re-qualify
        if (session.currentStage === "closing") {
          logger.warn(`[${session.id}] QC Q2 pass ignored — already in closing (disqualified by direct handler)`);
          session._shouldHangupAfterTTS = true;
          return;
        }
        st.govtCoverageChecked = true;
        st.qualified = true;
        session.currentStage = "wrapup";
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TRANSFERRED_TO_AGENT";
        logger.info(`[${session.id}] QC Q2 pass → qualified`);
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
        st.interestConfirmed = true; session.currentQuestionNum = 2;
        logger.info(`[${session.id}] FALLBACK Q1 pass`); return;
      }
      if (detectQ1NegativeIntent(uText)) {
        st.interestConfirmed = false;
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "NOT_INTERESTED";
        session._shouldHangupAfterTTS = true;
        logger.info(`[${session.id}] FALLBACK Q1 fail`); return;
      }
    }

    if (q === 2 && st.govtCoverageChecked === null) {
      if (/connect you|licensed specialist|licensed agent|transfer/i.test(lower)) {
        st.govtCoverageChecked = true; st.qualified = true;
        session.currentStage = "wrapup";
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TRANSFERRED_TO_AGENT";
        logger.info(`[${session.id}] FALLBACK Q2 pass → qualified`); return;
      }
      if (/thank you for your time|have a great day|do not qualify|not qualify/i.test(lower)) {
        st.govtCoverageChecked = false; st.qualified = false;
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "DISQUALIFIED_GOVT_COVERAGE";
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
      if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TRANSFERRED_TO_AGENT";
      logger.info(`[${session.id}] Stage → wrapup`);
    }
  }

  async _maybeTransferCall(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.transferAttempted || !session.state?.qualified) return;
    if (session.isClosing || session.isCleaning) return;

    const callSid = session.callLog?.callSid;
    const buyerDid = String(session.campaign?.transferSettings?.number || "").trim();

    // Always reload fromNumber fresh from DB
    // session.callLog may have stale value set by dialer before webhook corrected it
    let customerNum = session.callLog?.fromNumber || null;
    if (callSid) {
      try {
        const freshLog = await CallLog.findOne({ callSid }).select("fromNumber rawFrom").lean();
        if (freshLog?.fromNumber) customerNum = freshLog.fromNumber;
      } catch (e) {
        logger.warn(`[${sessionId}] freshLog lookup failed: ${e.message}`);
      }
    }

    logger.info(`[${sessionId}] TRANSFER_INIT callSid=${callSid} buyerDid=${buyerDid} customerNum=${customerNum}`);

    if (!callSid || !buyerDid) {
      logger.warn(`[${sessionId}] Transfer skipped — missing callSid=${callSid} buyerDid=${buyerDid}`);
      if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "TECH_ISSUES";
      return;
    }

    session.transferAttempted = true;
    session.transferPending = false;
    session.currentStage = "wrapup";
    if (session.callLog) session.callLog.disposition = "TRANSFERRED_TO_AGENT";

    if (session.callLog?._id) {
      await session.callLog.save().catch(e =>
        logger.warn(`[${sessionId}] callLog save failed: ${e.message}`)
      );
    }

    if (customerNum) {
      try {
        const ideUrl = `https://display.ringba.com/enrich/2792900612390389650?callerid=${encodeURIComponent(customerNum)}`;
        const ideRes = await fetch(ideUrl);
        logger.info(`[${sessionId}] Ringba IDE enriched customerNum=${customerNum} status=${ideRes.status}`);
      } catch (e) {
        logger.warn(`[${sessionId}] Ringba IDE failed: ${e.message}`);
      }
    }

    logger.info(`[${sessionId}] TRANSFER → buyerDid=${buyerDid} customerNum=${customerNum}`);
    try {
      await this.twilioService.transferCall(callSid, buyerDid, customerNum);
      logger.info(`[${sessionId}] Transfer successful`);
    } catch (e) {
      logger.error(`[${sessionId}] Transfer FAILED: ${e.message}`);
      if (session.callLog) session.callLog.disposition = "TECH_ISSUES";
    }
  }
  enqueueTTS(sessionId, text, { flush = false, onComplete = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isCleaning) { if (onComplete) onComplete(); return; }

    const t = safeTTS(text);
    if (!t) { if (onComplete) onComplete(); return; }

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

        if (!textToSpeak) { if (onComplete) onComplete(); continue; }

        if (!s.isTwilioReady || !s.streamSid || !s.ws) {
          const waitStart = Date.now();
          while (!s.isTwilioReady || !s.streamSid || !s.ws) {
            if (Date.now() - waitStart > TWILIO_READY_WAIT_MAX_MS) { if (onComplete) onComplete(); break; }
            await sleep(35);
            const ss = this.sessions.get(sessionId);
            if (!ss || ss.isCleaning) return;
          }
          const ss = this.sessions.get(sessionId);
          if (!ss || !ss.isTwilioReady || !ss.streamSid || !ss.ws) continue;
        }

        const audioStream = preloadedStream || (await this.getAudioStream(sessionId, textToSpeak));
        if (!audioStream) { if (onComplete) onComplete(); continue; }

        await this.streamDirectULawToTwilioWithBargeIn(sessionId, audioStream);

        {
          const ss = this.sessions.get(sessionId);
          if (ss && !ss.isClosing && !ss.isCleaning && ss.ttsQueue.length > 0) {
            const next = ss.ttsQueue[0];
            const nextText = typeof next === "string" ? next : next?.text || "";
            if (isAcknowledgmentChunk(textToSpeak) && nextText.includes("?")) await sleep(ACK_TO_QUESTION_PAUSE_MS);
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
      const stream = await this.elevenlabsService.streamTextToSpeechFast(finalText, session.campaign.voiceId, session.campaign.voiceSettings);
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

    const FRAME_BYTES = 160, FRAME_MS = 20;
    let buffer = Buffer.alloc(0), ended = false, frameCount = 0, firstFrameLogged = false;

    const onData = (chunk) => {
      if (!chunk?.length) return;
      if (buffer.length + chunk.length > AUDIO_BUFFER_MAX_BYTES) {
        const keep = AUDIO_BUFFER_MAX_BYTES - buffer.length;
        if (keep > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, keep)]);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
    };
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
            const mixedFrame = _mixNoiseIntoUlawFrame(frame);
            session.ws.send(JSON.stringify({
              event: "media", streamSid: session.streamSid,
              media: { payload: mixedFrame.toString("base64") },
            }));
            if (!firstFrameLogged) {
              firstFrameLogged = true;
              _triggerKeyboardBurst();
              logger.info(`[${sessionId}] TTS first-frame: ${Date.now() - streamStartAt}ms`);
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
      try { audioStream.off("data", onData); audioStream.off("end", onEnd); audioStream.off("error", onError); } catch { }
      try { audioStream.destroy(); } catch { }
      buffer = Buffer.alloc(0);
      session.isSpeaking = false;
      session.ttsAbort = null;
      logger.info(`[${sessionId}] TTS done frames=${frameCount} audio_ms=${frameCount * FRAME_MS}`);
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
          const phrases = [
            "hey, are you still with me?",
            "hey, can you hear me okay?",
            "hey, I am not able to hear you - are you still there?",
          ];
          this.enqueueTTS(sessionId, phrases[(st.retriesCantHear - 1) % phrases.length], { flush: true });
        } else {
          if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "NO_ANSWER";
          await this.politeHangup(sessionId, { finalMessage: "I am not able to hear you. I will try calling back another time. Have a good day." });
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
      const ss2 = now2 - (ss.lastSpeechAt || 0);
      const si2 = ss.userSpeech?.lastInterimTime ? now2 - ss.userSpeech.lastInterimTime : 999999;
      if (ss2 < 3500 || si2 < 3500 || ss.isSpeaking || ss.isProcessingUtterance) return;
      if (ss.callLog && !ss.callLog.disposition) ss.callLog.disposition = "NO_ANSWER";
      await this.politeHangup(sessionId, { finalMessage: "I am not able to hear you. I will try calling back another time. Have a good day." });
    });
  }

  stopTTS(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttsAbort) { try { session.ttsAbort.abort(); } catch { } session.ttsAbort = null; }
    if (session.llmAbort) { try { session.llmAbort.abort(); } catch { } session.llmAbort = null; }
    session.isSpeaking = false;
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
    try { session.ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid })); }
    catch (e) { logger.error(`[${sessionId}] clear failed: ${e.message}`); }
  }

  async _waitForTTSIdle(sessionId, timeoutMs = 12000) {
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
      if (finalMessage) { this.enqueueTTS(sessionId, finalMessage, { flush: true }); await this._waitForTTSIdle(sessionId, 12000); }
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

    try { this._clearAllTimers(session); this.stopTTS(sessionId); } catch { }
    try { this.deepgramService.closeTranscriptionStream(sessionId); } catch { }

    try {
      if (session.callLog) {
        const now = Date.now();
        if (!session.callLog.duration || session.callLog.duration === 0) {
          session.callLog.duration = Math.floor((now - session.startTime) / 1000);
        }
        session.callLog.endTime = session.callLog.endTime || new Date(now);

        const transcript = this._buildTranscriptForLog(session);
        if (transcript) session.callLog.transcript = transcript;
        if (Array.isArray(session.aiChunks) && session.aiChunks.length) session.callLog.aiResponses = session.aiChunks.slice(-50);

        const dispositionObj = buildDispositionObject(session, endedBy);
        if (!session.callLog.disposition) session.callLog.disposition = dispositionObj.status;
        session.callLog.dispositionDetail = {
          ...(session.callLog.dispositionDetail || {}),
          ...dispositionObj,
          status: session.callLog.disposition || dispositionObj.status,
        };
        if (session.state?.capturedAnswers) session.callLog.capturedAnswers = session.state.capturedAnswers;

        await session.callLog.save();
        logger.info(`[${sessionId}] Saved disposition=${dispositionObj.status}`);
      }
    } catch (e) { logger.error(`[${sessionId}] callLog save failed: ${e.message}`); }

    try { if (session.ws?.readyState === WebSocket.OPEN) session.ws.close(); } catch { }
    this.sessions.delete(sessionId);
    logger.info(`Session cleaned: ${sessionId}`);
  }

  cleanupInactiveSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > 300000) {
        logger.warn(`Cleaning inactive: ${sessionId}`);
        if (session.callLog && !session.callLog.disposition) session.callLog.disposition = "NO_ANSWER";
        this.cleanupSession(sessionId, { endedBy: "inactive_cleanup" });
      }
    }
  }
}

module.exports = MediaStreamHandler;