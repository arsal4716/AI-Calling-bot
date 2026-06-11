"use strict";
// G.711 µ-law <-> 16-bit signed linear PCM (slin) conversion.
//
// Twilio Media Streams carry 8 kHz µ-law audio. Asterisk AudioSocket carries
// 8 kHz 16-bit signed-linear ("slin") audio. The AI pipeline (Deepgram in,
// ElevenLabs out) already speaks µ-law, so when we move off Twilio we only need
// to translate at the AudioSocket boundary:
//
//   inbound : Asterisk slin  -> µ-law -> Deepgram
//   outbound: ElevenLabs µ-law -> slin -> Asterisk
//
// Both directions are cheap table/loop conversions (8 kHz mono = 8 kB/s).

const BIAS = 0x84;
const CLIP = 32635;

// Standard 8-segment exponent table for µ-law encode.
const exponentTable = [
  0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
  4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
];

function linearToUlaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  const exponent = exponentTable[(sample >> 7) & 0xFF];
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

function ulawDecodeSample(uVal) {
  uVal = ~uVal & 0xFF;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0F;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

/** Buffer of µ-law bytes -> Buffer of slin (16-bit LE). */
function ulawBufToSlin(ulawBuf) {
  const out = Buffer.allocUnsafe(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    out.writeInt16LE(ulawDecodeSample(ulawBuf[i]), i * 2);
  }
  return out;
}

/** Buffer of slin (16-bit LE) -> Buffer of µ-law bytes. */
function slinBufToUlaw(slinBuf) {
  const samples = slinBuf.length >> 1;
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = linearToUlaw(slinBuf.readInt16LE(i * 2));
  }
  return out;
}

module.exports = { ulawBufToSlin, slinBufToUlaw, linearToUlaw, ulawDecodeSample };
