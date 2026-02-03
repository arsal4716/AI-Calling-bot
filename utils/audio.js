// utils/audio.js
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { PassThrough } = require("stream");
const logger = require("../utils/logger");

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

  static isReadableStream(s) {
    return s && typeof s.pipe === "function" && typeof s.on === "function";
  }

  /**
   * Convert ElevenLabs MP3 (Node readable stream) -> mulaw 8k
   * then push 20ms frames (160 bytes) to Twilio smoothly.
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

      if (!AudioService.isReadableStream(inputAudioStream)) {
        logger.error(
          `AudioService: inputAudioStream is not a Node readable stream (got ${typeof inputAudioStream})`,
        );
        return resolve(false);
      }

      let ended = false;
      let pending = Buffer.alloc(0);
      let sending = false;

      let ff = null;
      const out = new PassThrough();

      // For clean shutdown
      const cleanup = () => {
        try {
          out.removeAllListeners();
        } catch {}
        try {
          inputAudioStream.removeAllListeners("error");
        } catch {}
        try {
          if (ff && ff.ffmpegProc && ff.ffmpegProc.stdin) {
            try {
              ff.ffmpegProc.stdin.end();
            } catch {}
          }
        } catch {}
        try {
          if (ff && ff.ffmpegProc) {
            try {
              ff.ffmpegProc.kill("SIGKILL");
            } catch {}
          }
        } catch {}
        ff = null;
      };

      const safeResolve = (val) => {
        cleanup();
        resolve(val);
      };

      const safeReject = (err) => {
        cleanup();
        reject(err);
      };

      // Abort handling
      const onAbort = () => safeResolve(false);
      if (abortSignal) {
        if (abortSignal.aborted) return safeResolve(false);
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      // Smooth clock-based pacing (less jitter than sleep(20) in a loop)
      let nextSendAt = Date.now();

      const sendLoop = async () => {
        if (sending) return;
        sending = true;

        try {
          while (pending.length >= 160) {
            if (abortSignal?.aborted) return safeResolve(false);
            if (typeof isStillValid === "function" && !isStillValid())
              return safeResolve(false);

            const frame = pending.subarray(0, 160);
            pending = pending.subarray(160);

            const ok = AudioService.safeSend(ws, {
              event: "media",
              streamSid,
              media: { payload: frame.toString("base64") },
            });

            if (!ok) return safeResolve(false);

            nextSendAt += 20;
            const wait = Math.max(0, nextSendAt - Date.now());
            if (wait) await AudioService.sleep(wait);
          }

          // If ffmpeg ended, flush remainder padded to 160
          if (ended) {
            if (pending.length > 0) {
              if (abortSignal?.aborted) return safeResolve(false);
              if (typeof isStillValid === "function" && !isStillValid())
                return safeResolve(false);

              const padded =
                pending.length === 160
                  ? pending
                  : Buffer.concat([
                      pending,
                      Buffer.alloc(160 - pending.length),
                    ]);

              const ok = AudioService.safeSend(ws, {
                event: "media",
                streamSid,
                media: { payload: padded.toString("base64") },
              });

              pending = Buffer.alloc(0);
              if (!ok) return safeResolve(false);

              nextSendAt += 20;
              const wait = Math.max(0, nextSendAt - Date.now());
              if (wait) await AudioService.sleep(wait);
            }

            return safeResolve(true);
          }
        } catch (e) {
          return safeReject(e);
        } finally {
          sending = false;
        }
      };

      out.on("data", (chunk) => {
        if (abortSignal?.aborted) return;
        if (!chunk || !chunk.length) return;
        pending = Buffer.concat([pending, chunk]);
        sendLoop().catch(safeReject);
      });

      out.on("end", () => {
        ended = true;
        sendLoop().catch(safeReject);
      });

      out.on("error", (err) => {
        safeReject(err);
      });

      inputAudioStream.on("error", (err) => {
        safeReject(err);
      });

      ff = ffmpeg(inputAudioStream)
        .inputOptions([
          "-fflags",
          "+genpts",
          "-analyzeduration",
          "200000",
          "-probesize",
          "2048",
        ])

        .audioChannels(1)
        .audioFrequency(8000)
        .audioCodec("pcm_mulaw")
        .format("mulaw")
        .outputOptions([
          "-fflags",
          "+nobuffer",
          "-flush_packets",
          "1",
          "-max_delay",
          "0",
        ])
        .on("start", (cmd) => {
          logger.info(`FFmpeg started: ${cmd}`);
        })
        .on("error", (err) => {
          if (abortSignal?.aborted) return safeResolve(false);
          safeReject(err);
        })
        .on("end", () => {
          ended = true;
          sendLoop().catch(safeReject);
        })
        .pipe(out, { end: true });
    });
  }
}

module.exports = AudioService;
