// utils/audio.js
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { PassThrough, Readable } = require("stream");
const logger = require("./logger");

/**
 * Low-latency audio transcoding service for Twilio Media Streams.
 * 
 * KEY FEATURES:
 * 1. NO `-re` flag - process audio at maximum speed
 * 2. Minimal analyzeduration/probesize for instant start
 * 3. 40ms jitter buffer (2 frames)
 * 4. Precise timing using high-resolution timers
 * 5. Proper cleanup on abort/barge-in
 */
class AudioService {
  
  /**
   * High-precision delay using process.hrtime
   */
  static preciseDelay(ms) {
    return new Promise((resolve) => {
      if (ms <= 0) return resolve();
      
      const target = process.hrtime.bigint() + BigInt(Math.floor(ms * 1_000_000));
      
      const spinWait = () => {
        if (process.hrtime.bigint() >= target) {
          resolve();
        } else {
          setImmediate(spinWait);
        }
      };
      
      // Use setTimeout for most of the delay, then spin-wait for precision
      if (ms > 5) {
        setTimeout(spinWait, ms - 3);
      } else {
        spinWait();
      }
    });
  }

  /**
   * Safely send JSON to WebSocket
   */
  static safeSend(ws, payload) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(payload));
        return true;
      }
    } catch (err) {
      logger.warn(`WebSocket send failed: ${err.message}`);
    }
    return false;
  }

  /**
   * Check if object is a readable stream
   */
  static isReadableStream(obj) {
    return obj && typeof obj.pipe === "function" && typeof obj.on === "function";
  }

  /**
   * Spawn FFmpeg process optimized for low-latency streaming.
   */
  static spawnFFmpeg(inputFormat = "mp3") {
    const args = [
      // === INPUT OPTIONS ===
      "-hide_banner",
      "-loglevel", "error",
      
      // NO -re flag!
      
      // Minimal analysis for instant start
      "-fflags", "+igndts+discardcorrupt+nobuffer",
      "-flags", "low_delay",
      "-analyzeduration", "0",
      "-probesize", "32",
      
      // Input format and source
      "-f", inputFormat,
      "-i", "pipe:0",
      
      // === OUTPUT OPTIONS ===
      "-ac", "1",
      "-ar", "8000",
      "-acodec", "pcm_mulaw",
      "-f", "mulaw",
      
      // Flush immediately
      "-fflags", "+nobuffer+flush_packets",
      "-flush_packets", "1",
      "-max_delay", "0",
      "-muxdelay", "0",
      
      // Output to stdout
      "pipe:1"
    ];

    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      highWaterMark: 16 * 1024
    });

    return ffmpegProcess;
  }

  /**
   * Main entry point: Stream ElevenLabs MP3 audio to Twilio.
   */
  static streamElevenLabsToTwilio({
    ws,
    streamSid,
    inputAudioStream,
    abortSignal,
    isStillValid
  }) {
    return new Promise((resolve, reject) => {
      // === VALIDATION ===
      if (!ws || ws.readyState !== 1) {
        logger.warn("AudioService: WebSocket not open");
        return resolve(false);
      }

      if (!streamSid) {
        logger.warn("AudioService: No streamSid provided");
        return resolve(false);
      }

      if (!AudioService.isReadableStream(inputAudioStream)) {
        logger.error(`AudioService: Invalid input stream (got ${typeof inputAudioStream})`);
        return resolve(false);
      }

      // === STATE ===
      let ffmpegProcess = null;
      let isAborted = false;
      let isEnded = false;
      let isSending = false;
      
      let frameBuffer = Buffer.alloc(0);
      
      // Jitter buffer: 2 frames (40ms)
      const JITTER_BUFFER_FRAMES = 2;
      const JITTER_BUFFER_BYTES = 160 * JITTER_BUFFER_FRAMES;
      let hasStartedSending = false;
      
      // Timing
      let nextFrameTime = 0;
      let framesSent = 0;
      let startTime = 0;

      // === CLEANUP FUNCTION ===
      const cleanup = (reason) => {
        if (isAborted) return;
        isAborted = true;
        
        logger.info(`AudioService cleanup: ${reason}`);

        if (abortSignal) {
          try {
            abortSignal.removeEventListener("abort", onAbort);
          } catch {}
        }

        try {
          inputAudioStream.removeAllListeners();
          if (typeof inputAudioStream.destroy === "function") {
            inputAudioStream.destroy();
          }
        } catch {}

        if (ffmpegProcess) {
          try {
            ffmpegProcess.stdin.removeAllListeners();
            ffmpegProcess.stdout.removeAllListeners();
            ffmpegProcess.stderr.removeAllListeners();
            ffmpegProcess.removeAllListeners();
            
            if (!ffmpegProcess.stdin.destroyed) {
              ffmpegProcess.stdin.end();
            }
            
            setTimeout(() => {
              try {
                if (ffmpegProcess && !ffmpegProcess.killed) {
                  ffmpegProcess.kill("SIGKILL");
                }
              } catch {}
            }, 100);
          } catch {}
          ffmpegProcess = null;
        }
      };

      // === ABORT HANDLER ===
      const onAbort = () => {
        logger.info("AudioService: Aborted (barge-in)");
        cleanup("abort");
        resolve(false);
      };

      if (abortSignal?.aborted) {
        return resolve(false);
      }
      
      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      // === FRAME SENDING LOOP ===
      const sendFrames = async () => {
        if (isSending || isAborted) return;
        isSending = true;

        try {
          while (frameBuffer.length >= 160 && !isAborted) {
            if (typeof isStillValid === "function" && !isStillValid()) {
              cleanup("invalid");
              return resolve(false);
            }

            const frame = frameBuffer.subarray(0, 160);
            frameBuffer = frameBuffer.subarray(160);

            const sent = AudioService.safeSend(ws, {
              event: "media",
              streamSid: streamSid,
              media: {
                payload: frame.toString("base64")
              }
            });

            if (!sent) {
              cleanup("send-failed");
              return resolve(false);
            }

            framesSent++;

            // === PRECISE TIMING ===
            nextFrameTime += 20;
            
            const now = Date.now();
            const drift = nextFrameTime - now;
            
            if (drift > 1) {
              await AudioService.preciseDelay(drift);
            }
                        if (framesSent % 50 === 0) {
              const actualElapsed = Date.now() - startTime;
              const expectedElapsed = framesSent * 20;
              const driftMs = actualElapsed - expectedElapsed;
              logger.info(`AudioService: Sent ${framesSent} frames, drift=${driftMs}ms`);
            }
          }
          if (isEnded && frameBuffer.length > 0 && !isAborted) {
            const finalFrame = Buffer.concat([
              frameBuffer,
              Buffer.alloc(160 - frameBuffer.length, 0xFF)
            ]);
            frameBuffer = Buffer.alloc(0);

            AudioService.safeSend(ws, {
              event: "media",
              streamSid: streamSid,
              media: {
                payload: finalFrame.toString("base64")
              }
            });
            framesSent++;
          }

          // === CHECK IF COMPLETE ===
          if (isEnded && frameBuffer.length === 0 && !isAborted) {
            const totalDuration = framesSent * 20;
            const actualDuration = Date.now() - startTime;
            logger.info(`AudioService: Complete - ${framesSent} frames (${totalDuration}ms audio) in ${actualDuration}ms`);
            cleanup("complete");
            return resolve(true);
          }

        } catch (err) {
          if (!isAborted) {
            logger.error(`AudioService sendFrames error: ${err.message}`);
            cleanup("error");
            reject(err);
          }
        } finally {
          isSending = false;
        }
      };

      // === SPAWN FFMPEG ===
      try {
        ffmpegProcess = AudioService.spawnFFmpeg("mp3");
        
        logger.info("AudioService: FFmpeg spawned (no -re flag)");

        ffmpegProcess.on("error", (err) => {
          if (!isAborted) {
            logger.error(`FFmpeg process error: ${err.message}`);
            cleanup("ffmpeg-error");
            reject(err);
          }
        });

        ffmpegProcess.on("close", (code) => {
          if (!isAborted && code !== 0) {
            logger.warn(`FFmpeg closed with code ${code}`);
          }
        });

        ffmpegProcess.stderr.on("data", (data) => {
          const msg = data.toString().trim();
          if (msg && !isAborted) {
            logger.warn(`FFmpeg: ${msg}`);
          }
        });

        // === PROCESS FFMPEG OUTPUT ===
        ffmpegProcess.stdout.on("data", (chunk) => {
          if (isAborted) return;
          
          frameBuffer = Buffer.concat([frameBuffer, chunk]);

          if (!hasStartedSending && frameBuffer.length >= JITTER_BUFFER_BYTES) {
            hasStartedSending = true;
            startTime = Date.now();
            nextFrameTime = startTime;
            
            logger.info(`AudioService: First audio ready, starting playback (buffer=${frameBuffer.length} bytes)`);
            
            sendFrames().catch((err) => {
              if (!isAborted) {
                cleanup("send-error");
                reject(err);
              }
            });
          } else if (hasStartedSending) {
            sendFrames().catch((err) => {
              if (!isAborted) {
                cleanup("send-error");
                reject(err);
              }
            });
          }
        });

        ffmpegProcess.stdout.on("end", () => {
          isEnded = true;
          
          if (!hasStartedSending && frameBuffer.length > 0) {
            hasStartedSending = true;
            startTime = Date.now();
            nextFrameTime = startTime;
          }
          
          sendFrames().catch((err) => {
            if (!isAborted) {
              cleanup("send-error");
              reject(err);
            }
          });
        });

        ffmpegProcess.stdout.on("error", (err) => {
          if (!isAborted) {
            logger.error(`FFmpeg stdout error: ${err.message}`);
            cleanup("stdout-error");
            reject(err);
          }
        });

        // === PIPE INPUT TO FFMPEG ===
        inputAudioStream.on("error", (err) => {
          if (!isAborted) {
            logger.error(`Input stream error: ${err.message}`);
            cleanup("input-error");
            reject(err);
          }
        });

        inputAudioStream.pipe(ffmpegProcess.stdin);

        ffmpegProcess.stdin.on("error", (err) => {
          if (err.code !== "EPIPE" && !isAborted) {
            logger.warn(`FFmpeg stdin error: ${err.message}`);
          }
        });

      } catch (err) {
        cleanup("spawn-error");
        reject(err);
      }
    });
  }
}

module.exports = AudioService;
