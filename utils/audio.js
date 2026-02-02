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
   * Send mulaw @ 8k to Twilio as 20ms frames (160 bytes per frame)
   */
  static async sendMulawFrames({ ws, streamSid, buffer, abortSignal }) {
    const frameSize = 160; // 20ms @ 8k mulaw
    let offset = 0;

    while (offset < buffer.length) {
      if (abortSignal?.aborted) return false;

      const chunk = buffer.slice(offset, offset + frameSize);
      offset += frameSize;

      const padded =
        chunk.length < frameSize
          ? Buffer.concat([chunk, Buffer.alloc(frameSize - chunk.length)])
          : chunk;

      const ok = AudioService.safeSend(ws, {
        event: "media",
        streamSid,
        media: { payload: padded.toString("base64") },
      });

      if (!ok) return false;

      // pace 20ms so Twilio plays smoothly
      await AudioService.sleep(20);
    }

    return true;
  }

  /**
   * REAL-TIME: Convert ElevenLabs MP3 stream -> mulaw 8k and push frames to Twilio
   * WITHOUT waiting for full mp3 to complete.
   */
  static streamElevenLabsToTwilio({
    ws,
    streamSid,
    inputAudioStream,
    abortSignal,
    isStillValid,
  }) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return resolve(false);
      if (!streamSid) return resolve(false);

      const ffmpegOut = new PassThrough();

      // We accumulate ONLY a small rolling buffer and flush frames continuously.
      let pending = Buffer.alloc(0);
      let ended = false;
      let pumping = false;

      const pump = async () => {
        if (pumping) return;
        pumping = true;

        try {
          while (true) {
            if (abortSignal?.aborted) return resolve(false);
            if (typeof isStillValid === "function" && !isStillValid())
              return resolve(false);

            // if we have at least 1 frame, send it immediately
            if (pending.length >= 160) {
              const frame = pending.slice(0, 160);
              pending = pending.slice(160);

              const ok = AudioService.safeSend(ws, {
                event: "media",
                streamSid,
                media: { payload: frame.toString("base64") },
              });

              if (!ok) return resolve(false);

              await AudioService.sleep(20);
              continue;
            }

            // if stream ended and no pending data, we are done
            if (ended && pending.length === 0) return resolve(true);

            // otherwise wait a tiny bit for more data to arrive
            await AudioService.sleep(5);
          }
        } catch (e) {
          reject(e);
        }
      };

      ffmpegOut.on("data", (chunk) => {
        if (abortSignal?.aborted) return;
        pending = Buffer.concat([pending, chunk]);

        // start pumping as soon as first bytes arrive (real-time)
        pump().catch(reject);
      });

      ffmpegOut.on("end", () => {
        ended = true;

        // flush remainder (pad to frame)
        if (pending.length > 0 && pending.length < 160) {
          pending = Buffer.concat([pending, Buffer.alloc(160 - pending.length)]);
        }

        pump().catch(reject);
      });

      ffmpegOut.on("error", reject);

      // Convert MP3 -> mulaw 8k
      ffmpeg(inputAudioStream)
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
