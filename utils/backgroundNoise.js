// utils/backgroundNoise.js
const fs = require("fs");
const path = require("path");
const { ulawToPcm16, pcm16ToUlaw } = require("./mulaw");

const FRAME_BYTES = 160; // 20ms ulaw @ 8kHz

class BackgroundNoise {
  constructor(filePath) {
    this.filePath = filePath;
    this.buf = null;
    this.offset = 0;
  }

  load() {
    const p = path.resolve(this.filePath);
    const fullFile = fs.readFileSync(p);
    
    if (!fullFile || fullFile.length < FRAME_BYTES + 44) {
      throw new Error(`Noise file too small or missing: ${p}`);
    }
    this.buf = fullFile.subarray(44); 
    this.offset = 0;
  }

  nextFrame() {
    if (!this.buf) return Buffer.alloc(FRAME_BYTES, 0xff);

    if (this.offset + FRAME_BYTES > this.buf.length) this.offset = 0;
    const frame = this.buf.subarray(this.offset, this.offset + FRAME_BYTES);
    this.offset += FRAME_BYTES;
    return frame;
  }

  // Mix ulaw TTS frame + ulaw noise frame into ulaw output
  mixUlawFrames(ttsFrameUlaw, noiseGain = 0.12, ttsGain = 1.0) {
    const noiseFrameUlaw = this.nextFrame();
    const out = Buffer.alloc(FRAME_BYTES);

    for (let i = 0; i < FRAME_BYTES; i++) {
      const tts = ulawToPcm16(ttsFrameUlaw[i]);
      const noi = ulawToPcm16(noiseFrameUlaw[i]);

      // Mix (duck noise by lowering noiseGain when needed in caller)
      let mixed = (tts * ttsGain) + (noi * noiseGain);

      // Clip to 16-bit PCM
      if (mixed > 32767) mixed = 32767;
      if (mixed < -32768) mixed = -32768;

      out[i] = pcm16ToUlaw(mixed | 0);
    }

    return out;
  }
}

module.exports = { BackgroundNoise, FRAME_BYTES };
