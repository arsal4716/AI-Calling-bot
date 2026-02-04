// utils/SentenceChunker
class SentenceChunker {
  constructor(onSentence) {
    this.buffer = "";
    this.onSentence = onSentence;
    this.minChunkLength = 15; 
    this.maxChunkLength = 120;  
  }

  add(text) {
    if (!text) return;
    this.buffer += text;
    this._tryFlush(false);
  }
  end() {
    this._tryFlush(true);
  }

  _tryFlush(force) {
    while (this.buffer.length > 0) {
      const sentenceMatch = this.buffer.match(/^(.+?[.!?]+)\s+/);
      
      if (sentenceMatch && sentenceMatch[1].length >= this.minChunkLength) {
        const sentence = sentenceMatch[1].trim();
        this.buffer = this.buffer.slice(sentenceMatch[0].length);
        
        if (sentence) {
          this.onSentence(sentence);
        }
        continue;
      }
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
      break;
    }

    if (force && this.buffer.trim()) {
      this.onSentence(this.buffer.trim());
      this.buffer = "";
    }
  }
  clear() {
    this.buffer = "";
  }
}

module.exports = SentenceChunker;
