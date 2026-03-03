// utils/SentenceChunker.js — 

class SentenceChunker {
  constructor(onSentence) {
    this.buffer = "";
    this.onSentence = onSentence;
    this.minChunkLength = 12; 
    this.maxChunkLength = 130;
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
      // ── D) FAST FIRST CHUNK: send first natural pause point immediately ──
      if (!this.firstChunkSent) {
        // Match first clause ending at comma, semicolon, or sentence-end punctuation
        const fastMatch = this.buffer.match(/^(.{3,35}?[,;!?.:])\s+/);
        if (fastMatch) {
          const phrase = fastMatch[1].trim();
          this.buffer = this.buffer.slice(fastMatch[0].length);
          this.firstChunkSent = true;
          this.onSentence(phrase);
          continue;
        }
        // If buffer already long enough even without punctuation — flush early
        if (this.buffer.length >= this.minChunkLength) {
          const spaceIdx = this.buffer.indexOf(" ", this.minChunkLength);
          if (spaceIdx !== -1 && spaceIdx <= this.maxChunkLength) {
            const chunk = this.buffer.slice(0, spaceIdx).trim();
            this.buffer = this.buffer.slice(spaceIdx + 1);
            this.firstChunkSent = true;
            this.onSentence(chunk);
            continue;
          }
        }
      }

      // Full sentence match (after first chunk sent)
      const sentenceMatch = this.buffer.match(/^(.+?[.!?]+)\s+/);
      if (sentenceMatch) {
        const sentence = sentenceMatch[1].trim();
        if (this.firstChunkSent || sentence.length >= this.minChunkLength) {
          this.buffer = this.buffer.slice(sentenceMatch[0].length);
          this.firstChunkSent = true;
          this.onSentence(sentence);
          continue;
        }
      }

      // Buffer overflow — split at word boundary
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