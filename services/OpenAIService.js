const { OpenAI } = require("openai");

class OpenAIService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateResponse(transcript, systemPrompt, conversationHistory = []) {
    try {
      const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory.slice(-10),
        { role: "user", content: transcript },
      ];

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        temperature: 0.7,
        max_tokens: 100,
        presence_penalty: 0.6,
        frequency_penalty: 0.3,
      });

      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error("OpenAI API error:", error);
      throw new Error("Failed to generate AI response");
    }
  }

  // Validate prompt content
  async validatePrompt(prompt) {
    try {
      const moderation = await this.openai.moderations.create({
        input: prompt,
      });

      const results = moderation.results[0];

      if (results.flagged) {
        const categories = Object.keys(results.categories).filter(
          (cat) => results.categories[cat],
        );
        throw new Error(
          `Prompt contains prohibited content: ${categories.join(", ")}`,
        );
      }

      return true;
    } catch (error) {
      console.error("Prompt validation error:", error);
      throw error;
    }
  }

  async generateResponseVariations(prompt, numVariations = 3) {
    try {
      const messages = [
        {
          role: "system",
          content:
            "You are a helpful assistant that generates multiple response variations.",
        },
        {
          role: "user",
          content: `Generate ${numVariations} different response variations for this scenario: ${prompt}`,
        },
      ];

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        temperature: 0.9,
        max_tokens: 200,
        n: numVariations,
      });

      return completion.choices.map((choice) => choice.message.content.trim());
    } catch (error) {
      console.error("OpenAI variations error:", error);
      throw error;
    }
  }
}

module.exports = OpenAIService;
