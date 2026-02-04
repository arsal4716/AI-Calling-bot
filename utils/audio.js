// utils/audio.js
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { PassThrough, Readable } = require("stream");
const logger = require("./logger");

/**
 * Low-latency audio transcoding service for Twilio Media Streams.
 * 
 * KEY FIXES:
 * 1. NO `-re` flag - process audio at maximum speed
 * 2. Minimal analyzeduration/probesize for instant start
 * 3. 40ms jitter buffer (2 frames) instead of 120ms
 * 4. Precise timing using high-resolution timers
 * 5. Proper cleanup on abort/barge-in
 */
class AudioService {
  
  /**
   * High-precision delay using process.hrtime
   * More accurate than setTimeout for sub-50ms delays
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
      if (ws && ws.readyState === 1) { // WebSocket.OPEN
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
   * 
   * CRITICAL: No `-re` flag! That flag causes real-time throttling
   * which adds delay equal to the audio duration.
   */
  static spawnFFmpeg(inputFormat = "mp3") {
    const args = [
      // === INPUT OPTIONS ===
      "-hide_banner",
      "-loglevel", "error",
      
      // NO -re flag! This is the main fix for latency
      
      // Minimal analysis for instant start
      "-fflags", "+igndts+discardcorrupt+nobuffer",
      "-flags", "low_delay",
      "-analyzeduration", "0",
      "-probesize", "32",
      
      // Input format and source
      "-f", inputFormat,
      "-i", "pipe:0",
      
      // === OUTPUT OPTIONS ===
      "-ac", "1",                    // Mono
      "-ar", "8000",                 // 8kHz for Twilio μ-law
      "-acodec", "pcm_mulaw",        // μ-law codec
      "-f", "mulaw",                 // Raw μ-law output
      
      // Flush immediately - critical for low latency
      "-fflags", "+nobuffer+flush_packets",
      "-flush_packets", "1",
      "-max_delay", "0",
      "-muxdelay", "0",
      
      // Output to stdout
      "pipe:1"
    ];

    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Increase buffer sizes for smoother streaming
      highWaterMark: 16 * 1024
    });

    return ffmpegProcess;
  }

  /**
   * Main entry point: Stream ElevenLabs MP3 audio to Twilio.
   * 
   * Converts MP3 → μ-law 8kHz and sends 20ms frames (160 bytes each)
   * with precise timing to match Twilio's expected rate.
   * 
   * @param {Object} options
   * @param {WebSocket} options.ws - Twilio WebSocket connection
   * @param {string} options.streamSid - Twilio stream identifier
   * @param {ReadableStream} options.inputAudioStream - MP3 audio from ElevenLabs
   * @param {AbortSignal} options.abortSignal - Signal to cancel on barge-in
   * @param {Function} options.isStillValid - Check if this TTS is still active
   * @returns {Promise<boolean>} - true if completed, false if aborted
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
      
      // Audio buffer for μ-law frames
      let frameBuffer = Buffer.alloc(0);
      
      // Jitter buffer: 2 frames (40ms) - minimal but prevents underrun
      const JITTER_BUFFER_FRAMES = 2;
      const JITTER_BUFFER_BYTES = 160 * JITTER_BUFFER_FRAMES;
      let hasStartedSending = false;
      
      // Timing for precise 20ms frame pacing
      let nextFrameTime = 0;
      let framesSent = 0;
      let startTime = 0;

      // === CLEANUP FUNCTION ===
      const cleanup = (reason) => {
        if (isAborted) return;
        isAborted = true;
        
        logger.debug(`AudioService cleanup: ${reason}`);

        // Remove abort listener
        if (abortSignal) {
          try {
            abortSignal.removeEventListener("abort", onAbort);
          } catch {}
        }

        // Clean up input stream
        try {
          inputAudioStream.removeAllListeners();
          if (typeof inputAudioStream.destroy === "function") {
            inputAudioStream.destroy();
          }
        } catch {}

        // Clean up FFmpeg process
        if (ffmpegProcess) {
          try {
            ffmpegProcess.stdin.removeAllListeners();
            ffmpegProcess.stdout.removeAllListeners();
            ffmpegProcess.stderr.removeAllListeners();
            ffmpegProcess.removeAllListeners();
            
            // End stdin gracefully first
            if (!ffmpegProcess.stdin.destroyed) {
              ffmpegProcess.stdin.end();
            }
            
            // Force kill after short delay
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

      // Check if already aborted
      if (abortSignal?.aborted) {
        return resolve(false);
      }
      
      // Register abort listener
      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      // === FRAME SENDING LOOP ===
      const sendFrames = async () => {
        if (isSending || isAborted) return;
        isSending = true;

        try {
          // Send all complete frames we have buffered
          while (frameBuffer.length >= 160 && !isAborted) {
            // Check validity before each frame
            if (typeof isStillValid === "function" && !isStillValid()) {
              cleanup("invalid");
              return resolve(false);
            }

            // Extract one 160-byte frame (20ms of μ-law audio)
            const frame = frameBuffer.subarray(0, 160);
            frameBuffer = frameBuffer.subarray(160);

            // Send to Twilio
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
            // Calculate when the next frame should be sent
            // Each frame represents exactly 20ms of audio
            nextFrameTime += 20;
            
            const now = Date.now();
            const drift = nextFrameTime - now;
            
            // If we're ahead of schedule, wait
            if (drift > 1) {
              await AudioService.preciseDelay(drift);
            }
            
            // Log timing drift periodically (every 50 frames = 1 second)
            if (framesSent % 50 === 0) {
              const actualElapsed = Date.now() - startTime;
              const expectedElapsed = framesSent * 20;
              const driftMs = actualElapsed - expectedElapsed;
              logger.debug(`AudioService: Sent ${framesSent} frames, drift=${driftMs}ms`);
            }
          }

          // === HANDLE END OF STREAM ===
          if (isEnded && frameBuffer.length > 0 && !isAborted) {
            // Pad final partial frame with μ-law silence (0xFF)
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

        // Handle FFmpeg errors
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

        // Log FFmpeg stderr (errors only)
        ffmpegProcess.stderr.on("data", (data) => {
          const msg = data.toString().trim();
          if (msg && !isAborted) {
            logger.warn(`FFmpeg: ${msg}`);
          }
        });

        // === PROCESS FFMPEG OUTPUT (μ-law data) ===
        ffmpegProcess.stdout.on("data", (chunk) => {
          if (isAborted) return;
          
          // Append to frame buffer
          frameBuffer = Buffer.concat([frameBuffer, chunk]);

          // Start sending once we have minimal jitter buffer
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
            // Continue sending if we have more frames
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
          
          // If we never started (very short audio), start now
          if (!hasStartedSending && frameBuffer.length > 0) {
            hasStartedSending = true;
            startTime = Date.now();
            nextFrameTime = startTime;
          }
          
          // Final send to flush remaining frames
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

        // Pipe ElevenLabs MP3 → FFmpeg stdin
        inputAudioStream.pipe(ffmpegProcess.stdin);

        ffmpegProcess.stdin.on("error", (err) => {
          // EPIPE is expected when we abort early
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

  /**
   * Alternative: Create a persistent FFmpeg transcoder that can be reused
   * for multiple TTS outputs within the same call.
   * 
   * This eliminates FFmpeg spawn overhead (~100-150ms per TTS).
   * 
   * @returns {Object} Transcoder object with input, output, and kill methods
   */
  static createPersistentTranscoder() {
    const ffmpegProcess = AudioService.spawnFFmpeg("mp3");
    const outputStream = new PassThrough();

    ffmpegProcess.stdout.pipe(outputStream);

    ffmpegProcess.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        logger.warn(`Persistent FFmpeg: ${msg}`);
      }
    });

    ffmpegProcess.on("error", (err) => {
      logger.error(`Persistent FFmpeg error: ${err.message}`);
      outputStream.destroy(err);
    });

    ffmpegProcess.on("close", (code) => {
      logger.info(`Persistent FFmpeg closed with code ${code}`);
      outputStream.end();
    });

    return {
      /**
       * Write MP3 data to the transcoder
       */
      write: (chunk) => {
        if (!ffmpegProcess.stdin.destroyed) {
          return ffmpegProcess.stdin.write(chunk);
        }
        return false;
      },

      /**
       * Get the μ-law output stream
       */
      output: outputStream,

      /**
       * FFmpeg process reference
       */
      process: ffmpegProcess,

      /**
       * Check if transcoder is still alive
       */
      isAlive: () => !ffmpegProcess.killed && !ffmpegProcess.stdin.destroyed,

      /**
       * Gracefully shut down the transcoder
       */
      kill: () => {
        try {
          if (!ffmpegProcess.stdin.destroyed) {
            ffmpegProcess.stdin.end();
          }
          setTimeout(() => {
            try {
              if (!ffmpegProcess.killed) {
                ffmpegProcess.kill("SIGKILL");
              }
            } catch {}
          }, 200);
        } catch {}
      }
    };
  }

  /**
   * Convert a Buffer or Uint8Array to a readable stream
   */
  static bufferToStream(buffer) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
  }
}

module.exports = AudioService;
