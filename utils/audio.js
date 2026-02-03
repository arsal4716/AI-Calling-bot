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

  /**
   * Convert ElevenLabs MP3 stream -> mulaw 8k and push frames to Twilio in real time.
   */
  static streamElevenLabsToTwilio({ ws, streamSid, inputAudioStream, abortSignal, isStillValid }) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return resolve(false);
      if (!streamSid) return resolve(false);

      let ffmpegProcess = null;
      const ffmpegOut = new PassThrough();
      let pending = Buffer.alloc(0);
      let ended = false;
      let sending = false;
      let frameInterval = null;

      const cleanup = () => {
        if (frameInterval) {
          clearInterval(frameInterval);
          frameInterval = null;
        }
        if (ffmpegProcess) {
          try {
            ffmpegProcess.kill('SIGKILL');
          } catch {}
          ffmpegProcess = null;
        }
      };

      // Set up abort handling
      abortSignal?.addEventListener('abort', () => {
        cleanup();
        resolve(false);
      });

      const sendFrames = async () => {
        if (sending) return;
        sending = true;

        try {
          while (pending.length >= 160) {
            if (abortSignal?.aborted) {
              cleanup();
              return resolve(false);
            }
            
            if (typeof isStillValid === "function" && !isStillValid()) {
              cleanup();
              return resolve(false);
            }

            const frame = pending.slice(0, 160);
            pending = pending.slice(160);

            const ok = AudioService.safeSend(ws, {
              event: "media",
              streamSid,
              media: { payload: frame.toString("base64") },
            });
            
            if (!ok) {
              cleanup();
              return resolve(false);
            }

            // Accurate 20ms pacing
            await AudioService.sleep(20);
          }

          if (ended && pending.length === 0) {
            cleanup();
            return resolve(true);
          }
          
          if (ended && pending.length > 0) {
            const padded = Buffer.concat([
              pending,
              Buffer.alloc(160 - pending.length)
            ]);
            
            const ok = AudioService.safeSend(ws, {
              event: "media",
              streamSid,
              media: { payload: padded.toString("base64") },
            });
            
            pending = Buffer.alloc(0);
            cleanup();
            
            if (ok) {
              // Send mark event for clean end
              await AudioService.sleep(20);
              AudioService.safeSend(ws, {
                event: "mark",
                streamSid,
                mark: { name: "end_of_audio" }
              });
              
              return resolve(true);
            }
            return resolve(false);
          }
        } catch (e) {
          cleanup();
          reject(e);
        } finally {
          sending = false;
        }
      };

      // Use interval to regularly check for frames
      frameInterval = setInterval(() => {
        if (pending.length >= 160 || (ended && pending.length > 0)) {
          sendFrames().catch(reject);
        }
      }, 10);

      ffmpegOut.on("data", (chunk) => {
        if (abortSignal?.aborted) return;
        pending = Buffer.concat([pending, chunk]);
      });

      ffmpegOut.on("end", () => {
        ended = true;
      });

      ffmpegOut.on("error", (err) => {
        cleanup();
        reject(err);
      });

      // Create ffmpeg process
      ffmpegProcess = ffmpeg(inputAudioStream)
        .inputOptions([
          "-fflags", "+genpts+discardcorrupt",
          "-flags", "low_delay",
          "-avioflags", "direct",
          "-probesize", "32",
          "-analyzeduration", "0",
        ])
        .audioFilters("aresample=async=1000")
        .audioChannels(1)
        .audioFrequency(8000)
        .audioCodec("pcm_mulaw")
        .format("mulaw")
        .outputOptions([
          "-fflags", "+nobuffer+flush_packets",
          "-max_delay", "0",
          "-avioflags", "direct",
        ])
        .on("start", (cmd) => {
          logger.debug(`FFmpeg started: ${cmd}`);
        })
        .on("error", (err) => {
          if (err.message.includes("SIGKILL") || err.message.includes("abort")) {
            return;
          }
          cleanup();
          reject(err);
        })
        .on("end", () => {
          ended = true;
        })
        .pipe(ffmpegOut, { end: true });

      inputAudioStream.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }
}

module.exports = AudioService;