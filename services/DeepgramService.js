// services/DeepgramService.js
// Production-safe + low-latency + better ordering signals
// - Buffers audio until OPEN, but caps by BYTES and CHUNKS (prevents memory blow)
// - Sends transcript metadata (receivedAt/start/duration/confidence) to help drop stale input
// - Keeps keepAlive optional
// - Defensive checks to avoid crashing on Deepgram edge payloads

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

class DeepgramService {
  constructor() {
    const key = process.env.DEEPGRAM_API_KEY;

    if (!key) console.error("DEEPGRAM_API_KEY is missing");
    else console.log("Deepgram key loaded:", key.slice(0, 6) + "..." + key.slice(-4));

    this.deepgram = createClient(key);
    this.connections = new Map();
  }

  async createTranscriptionStream(sessionId, handlers = {}) {
    const dgSocket = this.deepgram.listen.live({
      model: process.env.DG_MODEL || "nova-2",
      language: process.env.DG_LANG || "en-US",
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,

      interim_results: true,
      punctuate: true,
      smart_format: true,

      // NOTE: If you want faster endpointing, set DG_ENDPOINTING_MS=300..600
      // and enable the line below (Deepgram supports endpointing for live):
      // endpointing: Number(process.env.DG_ENDPOINTING_MS || 0) || undefined,
    });

    const state = {
      socket: dgSocket,
      isReady: false,

      // Buffering (caps by chunks + bytes)
      buffer: [],
      bufferedBytes: 0,
      maxBufferedChunks: Number(process.env.DG_MAX_BUFFER_CHUNKS || 120),
      maxBufferedBytes: Number(process.env.DG_MAX_BUFFER_BYTES || 256000), // ~256KB

      lastAudioAt: Date.now(),
      keepAliveTimer: null,
      closed: false,
    };

    this.connections.set(sessionId, state);

    dgSocket.on(LiveTranscriptionEvents.Open, () => {
      console.log(`Deepgram OPEN for session ${sessionId}`);
      state.isReady = true;
      handlers.onOpen?.();

      if (state.buffer.length) {
        console.log(`Flushing ${state.buffer.length} buffered chunks to Deepgram`);
        for (const chunk of state.buffer) {
          try {
            dgSocket.send(chunk);
          } catch {}
        }
        state.buffer = [];
        state.bufferedBytes = 0;
      }

      const kaMs = Number(process.env.DG_KEEPALIVE_MS || 0);
      if (kaMs > 0) {
        state.keepAliveTimer = setInterval(() => {
          try {
            dgSocket.keepAlive?.();
          } catch {}
        }, kaMs);
      }
    });

    dgSocket.on(LiveTranscriptionEvents.SpeechStarted, () => {
      handlers.onSpeechStarted?.();
    });

    dgSocket.on(LiveTranscriptionEvents.Transcript, (data) => {
      try {
        // Some DG payloads can be partial/empty; stay defensive.
        const alt = data?.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        if (!text) return;

        const receivedAt = Date.now();

        handlers.onTranscript?.({
          text,
          isFinal: !!data?.is_final,
          speechFinal: !!data?.speech_final,

          // Useful for out-of-order protections if you want:
          start: typeof data?.start === "number" ? data.start : null,
          duration: typeof data?.duration === "number" ? data.duration : null,
          confidence: typeof alt?.confidence === "number" ? alt.confidence : null,
          receivedAt,
        });
      } catch {
        // Never throw from event handler
      }
    });

    dgSocket.on(LiveTranscriptionEvents.Error, (err) => {
      console.error(`Deepgram ERROR [${sessionId}]`);
      console.error("message:", err?.message);
      console.error("statusCode:", err?.statusCode);
      console.error("requestId:", err?.requestId);
      console.error("url:", err?.url);
      state.isReady = false;
    });

    dgSocket.on(LiveTranscriptionEvents.Close, () => {
      console.log(`Deepgram CLOSED for session ${sessionId}`);
      state.closed = true;

      try {
        if (state.keepAliveTimer) clearInterval(state.keepAliveTimer);
      } catch {}

      this.connections.delete(sessionId);
      handlers.onClose?.();
    });

    return dgSocket;
  }

  sendAudio(sessionId, audioData) {
    const state = this.connections.get(sessionId);
    if (!state || state.closed) return;

    state.lastAudioAt = Date.now();

    // Buffer until ready
    if (!state.isReady) {
      const chunk = audioData;
      const chunkBytes = chunk?.length || 0;

      state.buffer.push(chunk);
      state.bufferedBytes += chunkBytes;

      // Cap by chunks
      const extraChunks = state.buffer.length - state.maxBufferedChunks;
      if (extraChunks > 0) {
        for (let i = 0; i < extraChunks; i++) {
          const removed = state.buffer.shift();
          state.bufferedBytes -= removed?.length || 0;
        }
      }

      // Cap by bytes (drop oldest)
      while (state.bufferedBytes > state.maxBufferedBytes && state.buffer.length) {
        const removed = state.buffer.shift();
        state.bufferedBytes -= removed?.length || 0;
      }

      return;
    }

    // Ready: send immediately
    try {
      state.socket.send(audioData);
    } catch (e) {
      console.error("Deepgram sendAudio failed:", e.message);
    }
  }

  closeTranscriptionStream(sessionId) {
    const state = this.connections.get(sessionId);
    if (!state) return;

    try {
      if (state.keepAliveTimer) clearInterval(state.keepAliveTimer);
    } catch {}

    state.closed = true;

    try {
      state.socket.finish?.();
    } catch {}
    try {
      state.socket.close?.();
    } catch {}

    this.connections.delete(sessionId);
  }
}

module.exports = DeepgramService;