// utils/SentenceChunker.js — v10

class SentenceChunker {
  constructor(onSentence) {
    this.buffer = "";
    this.onSentence = onSentence;
    this.minChunkLength = 10; 
    this.maxChunkLength = 350;
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
        const sentenceMatch = this.buffer.match(/^(.+?[.!?]+)\s*/);
        if (
          sentenceMatch &&
          sentenceMatch[1].trim().length >= this.minChunkLength
        ) {
          const phrase = sentenceMatch[1].trim();
          this.buffer = this.buffer.slice(sentenceMatch[0].length);
          this.firstChunkSent = true;
          this.onSentence(phrase);
          continue;
        }

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