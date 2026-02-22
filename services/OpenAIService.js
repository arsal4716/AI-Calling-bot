// services/OpenAIService.js
// Production-safe + faster turn-taking
// Fixes:
// - Smaller history + smaller max_tokens for speed
// - Abort signal respected
// - Adds timeout guard (server-side) so requests don't hang
// - Keeps buildMessages compatible with your existing handler

const { OpenAI } = require("openai");

class OpenAIService {
  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // latency knobs
    this.temperature = Number(process.env.OPENAI_TEMP || 0.35);
    this.maxTokensStream = Number(process.env.OPENAI_MAX_TOKENS_STREAM || 160);
    this.maxTokensOnce = Number(process.env.OPENAI_MAX_TOKENS_ONCE || 120);
    this.historyLimit = Number(process.env.OPENAI_HISTORY_LIMIT || 10);
    this.requestTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 9000);
  }

  buildMessages(transcript, systemPrompt, conversationHistory = []) {
    return [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-this.historyLimit),
      { role: "user", content: transcript },
    ];
  }

  async generateResponse(transcript, systemPrompt, conversationHistory = []) {
    const messages = this.buildMessages(transcript, systemPrompt, conversationHistory);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const completion = await this.openai.chat.completions.create(
        {
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokensOnce,
          presence_penalty: 0.15,
          frequency_penalty: 0.1,
        },
        { signal: controller.signal }
      );

      return completion.choices?.[0]?.message?.content?.trim() || "";
    } finally {
      clearTimeout(t);
    }
  }

  async *streamResponse(transcript, systemPrompt, conversationHistory = [], abortSignal) {
    const messages = this.buildMessages(transcript, systemPrompt, conversationHistory);

    // Combine external abort with local timeout
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const onAbort = () => {
      try { controller.abort(); } catch {}
    };
    if (abortSignal) abortSignal.addEventListener?.("abort", onAbort, { once: true });

    try {
      const stream = await this.openai.chat.completions.create(
        {
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokensStream,
          stream: true,
        },
        { signal: controller.signal }
      );

      for await (const part of stream) {
        if (controller.signal.aborted) break;
        const delta = part?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    } finally {
      clearTimeout(t);
      if (abortSignal) {
        try { abortSignal.removeEventListener?.("abort", onAbort); } catch {}
      }
    }
  }

  async validatePrompt(prompt) {
    const moderation = await this.openai.moderations.create({ input: prompt });
    const results = moderation.results[0];
    if (results.flagged) {
      const categories = Object.keys(results.categories).filter((c) => results.categories[c]);
      throw new Error(`Prompt contains prohibited content: ${categories.join(", ")}`);
    }
    return true;
  }
}

module.exports = OpenAIService;