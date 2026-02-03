// services/OpenAIService.js
const { OpenAI } = require("openai");

class OpenAIService {
  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  buildMessages(transcript, systemPrompt, conversationHistory = []) {
    return [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-12),
      { role: "user", content: transcript },
    ];
  }

  // Non-streaming (kept for fallback)
  async generateResponse(transcript, systemPrompt, conversationHistory = []) {
    const messages = this.buildMessages(
      transcript,
      systemPrompt,
      conversationHistory,
    );
    const completion = await this.openai.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.4,
      max_tokens: 120,
      presence_penalty: 0.2,
      frequency_penalty: 0.1,
    });
    return completion.choices?.[0]?.message?.content?.trim() || "";
  }

  /**
   * Streaming: yields text deltas as they arrive.
   * IMPORTANT: caller must handle abortSignal to cancel.
   */
  async *streamResponse(
    transcript,
    systemPrompt,
    conversationHistory = [],
    abortSignal,
  ) {
    const messages = this.buildMessages(
      transcript,
      systemPrompt,
      conversationHistory,
    );

    const stream = await this.openai.chat.completions.create(
      {
        model: this.model,
        messages,
        temperature: 0.4,
        max_tokens: 180,
        stream: true,
      },
      { signal: abortSignal },
    );

    for await (const part of stream) {
      const delta = part?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async validatePrompt(prompt) {
    const moderation = await this.openai.moderations.create({ input: prompt });
    const results = moderation.results[0];
    if (results.flagged) {
      const categories = Object.keys(results.categories).filter(
        (c) => results.categories[c],
      );
      throw new Error(
        `Prompt contains prohibited content: ${categories.join(", ")}`,
      );
    }
    return true;
  }
}

module.exports = OpenAIService;
