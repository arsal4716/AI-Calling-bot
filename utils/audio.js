// utils/audio.js
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { PassThrough } = require("stream");

ffmpeg.setFfmpegPath(ffmpegPath);

class AudioService {
  static sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  static safeSend(ws, obj) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert ElevenLabs MP3 stream -> mulaw 8k and push frames to Twilio in real time.
   * Low-latency ffmpeg flags + event-driven frame flush.
   */
  static streamElevenLabsToTwilio({ ws, streamSid, inputAudioStream, abortSignal, isStillValid }) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return resolve(false);
      if (!streamSid) return resolve(false);

      const ffmpegOut = new PassThrough();
      let pending = Buffer.alloc(0);
      let ended = false;
      let sending = false;

      const trySendFrames = async () => {
        if (sending) return;
        sending = true;

        try {
          while (pending.length >= 160) {
            if (abortSignal?.aborted) return resolve(false);
            if (typeof isStillValid === "function" && !isStillValid()) return resolve(false);

            const frame = pending.slice(0, 160);
            pending = pending.slice(160);

            const ok = AudioService.safeSend(ws, {
              event: "media",
              streamSid,
              media: { payload: frame.toString("base64") },
            });
            if (!ok) return resolve(false);

            // 20ms pacing for Twilio smooth playback
            await AudioService.sleep(20);
          }

          if (ended) {
            // flush remainder (pad to frame)
            if (pending.length > 0 && pending.length < 160) {
              const padded = Buffer.concat([pending, Buffer.alloc(160 - pending.length)]);
              const ok = AudioService.safeSend(ws, {
                event: "media",
                streamSid,
                media: { payload: padded.toString("base64") },
              });
              if (!ok) return resolve(false);
              pending = Buffer.alloc(0);
              await AudioService.sleep(20);
            }
            return resolve(true);
          }
        } catch (e) {
          return reject(e);
        } finally {
          sending = false;
        }
      };

      ffmpegOut.on("data", (chunk) => {
        if (abortSignal?.aborted) return;
        pending = Buffer.concat([pending, chunk]);
        trySendFrames().catch(reject);
      });

      ffmpegOut.on("end", () => {
        ended = true;
        trySendFrames().catch(reject);
      });

      ffmpegOut.on("error", reject);

      ffmpeg(inputAudioStream)
        .inputOptions([
          "-fflags", "nobuffer",
          "-flags", "low_delay",
          "-probesize", "32",
          "-analyzeduration", "0",
        ])
        .audioChannels(1)
        .audioFrequency(8000)
        .audioCodec("pcm_mulaw")
        .format("mulaw")
        .on("error", reject)
        .pipe(ffmpegOut);
    });
  }
}

module.exports = AudioService;
