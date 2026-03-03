// utils/SentenceChunker.js — v8
//
// KEY CHANGE from v7:
// The first chunk only flushes on a QUESTION MARK (?), not on any period (.).
// Acknowledgments like "[chuckles] mhm." end with a period — they accumulate.
// The following question ends with "?" — that triggers the flush.
// Result: ElevenLabs receives "mhm. And um are you on Medicare?" as ONE utterance.
// Sounds natural. Not two choppy separate audio clips.
//
// Subsequent chunks split on any sentence boundary (.!?) as before.

class SentenceChunker {
  constructor(onSentence) {
    this.buffer = "";
    this.onSentence = onSentence;
    this.minChunkLength = 12;  // caller may override
    this.maxChunkLength = 220; // overflow safety
    this.firstChunkSent = false;
  }

  add(text) {
    if (!text) return;
    this.buffer += text;
    this._tryFlush(false);
  }

  end() {
    this._tryFlush(true);
    this.firstChunkSent = false;
  }

  _tryFlush(force) {
    while (this.buffer.length > 0) {

      if (!this.firstChunkSent) {
        // ── FIRST CHUNK: only flush on a question mark ────────────────────
        // Acks end with "." → they wait. Questions end with "?" → flush together.
        // This keeps "mhm. And um how old are you?" as ONE ElevenLabs request.
        const questionMatch = this.buffer.match(/^(.+?\?)\s*/);
        if (questionMatch && questionMatch[1].trim().length >= this.minChunkLength) {
          const phrase = questionMatch[1].trim();
          this.buffer = this.buffer.slice(questionMatch[0].length);
          this.firstChunkSent = true;
          this.onSentence(phrase);
          continue;
        }
        // Overflow safety — fires only if LLM produces a very long non-question first
        if (this.buffer.length > this.maxChunkLength) {
          const lastSpace = this.buffer.lastIndexOf(" ", this.maxChunkLength);
          if (lastSpace > 5) {
            const chunk = this.buffer.slice(0, lastSpace).trim();
            this.buffer = this.buffer.slice(lastSpace + 1);
            this.firstChunkSent = true;
            this.onSentence(chunk);
            continue;
          }
        }

      } else {
        // ── SUBSEQUENT CHUNKS: any sentence boundary ──────────────────────
        const sentenceMatch = this.buffer.match(/^(.+?[.!?]+)\s+/);
        if (sentenceMatch) {
          const sentence = sentenceMatch[1].trim();
          this.buffer = this.buffer.slice(sentenceMatch[0].length);
          this.onSentence(sentence);
          continue;
        }
        if (this.buffer.length > this.maxChunkLength) {
          const lastSpace = this.buffer.lastIndexOf(" ", this.maxChunkLength);
          if (lastSpace > 5) {
            const chunk = this.buffer.slice(0, lastSpace).trim();
            this.buffer = this.buffer.slice(lastSpace + 1);
            this.onSentence(chunk);
            continue;
          }
        }
      }

      break;
    }

    if (force && this.buffer.trim()) {
      this.onSentence(this.buffer.trim());
      this.buffer = "";
    }
  }

  clear() {
    this.buffer = "";
    this.firstChunkSent = false;
  }
}

module.exports = SentenceChunker;