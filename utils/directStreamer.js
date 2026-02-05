// utils/directStreamer.js - Simple helper for direct streaming
const logger = require("./logger");

class DirectStreamer {
  /**
   * Stream direct ULAW audio to Twilio
   */
  static async streamULawToTwilio(ws, streamSid, audioStream, abortSignal) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) {
        return reject(new Error("WebSocket not connected"));
      }

      let isAborted = false;
      let buffer = Buffer.alloc(0);
      let framesSent = 0;
      const startTime = Date.now();

      const onAbort = () => {
        isAborted = true;
        audioStream.destroy();
        resolve();
      };

      if (abortSignal.aborted) return onAbort();
      abortSignal.addEventListener("abort", onAbort);

      audioStream.on("data", (chunk) => {
        if (isAborted) return;

        buffer = Buffer.concat([buffer, chunk]);

        // Send in 160-byte chunks (20ms at 8000Hz)
        while (buffer.length >= 160) {
          const frame = buffer.subarray(0, 160);
          buffer = buffer.subarray(160);

          try {
            ws.send(JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: { payload: frame.toString("base64") }
            }));
            framesSent++;
          } catch (err) {
            logger.error(`DirectStreamer send error: ${err.message}`);
            reject(err);
            return;
          }
        }
      });

      audioStream.on("end", () => {
        if (isAborted) return;

        // Send final frame if any data remains
        if (buffer.length > 0) {
          const frame = Buffer.alloc(160, 0xff);
          buffer.copy(frame);
          
          try {
            ws.send(JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: { payload: frame.toString("base64") }
            }));
          } catch (err) {
            logger.error(`DirectStreamer final send error: ${err.message}`);
          }
        }

        const totalTime = Date.now() - startTime;
        logger.info(`DirectStreamer: ${framesSent} frames in ${totalTime}ms`);
        
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      });

      audioStream.on("error", (err) => {
        if (isAborted) return;
        
        logger.error(`DirectStreamer stream error: ${err.message}`);
        abortSignal.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  }
}

module.exports = DirectStreamer;