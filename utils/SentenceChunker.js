// utils/SentenceChunker.js

/**
 * Streams LLM tokens and emits complete sentences for TTS.
 * This allows TTS to start on the first sentence while LLM is still generating.
 */
class SentenceChunker {
  constructor(onSentence) {
    this.buffer = "";
    this.onSentence = onSentence;
    this.minChunkLength = 15;   // Don't emit tiny chunks
    this.maxChunkLength = 120;  // Don't wait too long
  }

  /**
   * Add new text from LLM streaming
   */
  add(text) {
    if (!text) return;
    this.buffer += text;
    this._tryFlush(false);
  }

  /**
   * Call when LLM stream ends to flush remaining text
   */
  end() {
    this._tryFlush(true);
  }

  /**
   * Try to extract and emit complete sentences
   */
  _tryFlush(force) {
    while (this.buffer.length > 0) {
      // Look for sentence boundaries
      const sentenceMatch = this.buffer.match(/^(.+?[.!?]+)\s+/);
      
      if (sentenceMatch && sentenceMatch[1].length >= this.minChunkLength) {
        // Found a complete sentence
        const sentence = sentenceMatch[1].trim();
        this.buffer = this.buffer.slice(sentenceMatch[0].length);
        
        if (sentence) {
          this.onSentence(sentence);
        }
        continue;
      }

      // Check for comma/clause breaks for long buffers
      if (this.buffer.length > this.maxChunkLength) {
        const clauseMatch = this.buffer.match(/^(.{20,}?[,;:])\s+/);
        
        if (clauseMatch) {
          const clause = clauseMatch[1].trim();
          this.buffer = this.buffer.slice(clauseMatch[0].length);
          
          if (clause) {
            this.onSentence(clause);
          }
          continue;
        }

        // Force split at last space if buffer too long
        const lastSpace = this.buffer.lastIndexOf(" ", this.maxChunkLength);
        if (lastSpace > this.minChunkLength) {
          const chunk = this.buffer.slice(0, lastSpace).trim();
          this.buffer = this.buffer.slice(lastSpace + 1);
          
          if (chunk) {
            this.onSentence(chunk);
          }
          continue;
        }
      }

      // No complete sentence found
      break;
    }

    // Flush remaining on end
    if (force && this.buffer.trim()) {
      this.onSentence(this.buffer.trim());
      this.buffer = "";
    }
  }

  /**
   * Clear the buffer (for barge-in)
   */
  clear() {
    this.buffer = "";
  }
}

module.exports = SentenceChunker;
