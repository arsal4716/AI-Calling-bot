// DeepgramService.js (MINIMAL - matches your working test-live)
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
      model: "nova-2",
      language: "en-US",
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      interim_results: true,
      punctuate: true,
      smart_format: true,
    });

    const state = {
      socket: dgSocket,
      isReady: false,
      buffer: [],
      lastAudioAt: Date.now(),
    };

    this.connections.set(sessionId, state);

    dgSocket.on(LiveTranscriptionEvents.Open, () => {
      console.log(`Deepgram OPEN for session ${sessionId}`);
      state.isReady = true;

      if (state.buffer.length) {
        console.log(` Flushing ${state.buffer.length} buffered chunks to Deepgram`);
        for (const chunk of state.buffer) dgSocket.send(chunk);
        state.buffer = [];
      }
    });

    dgSocket.on(LiveTranscriptionEvents.SpeechStarted, () => {
      handlers.onSpeechStarted?.();
    });

    dgSocket.on(LiveTranscriptionEvents.Transcript, (data) => {
      const text = data?.channel?.alternatives?.[0]?.transcript?.trim();
      if (!text) return;

      handlers.onTranscript?.({
        text,
        isFinal: !!data.is_final,
        speechFinal: !!data.speech_final,
      });
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
      console.log(` Deepgram CLOSED for session ${sessionId}`);
      this.connections.delete(sessionId);
    });

    return dgSocket;
  }

  sendAudio(sessionId, audioData) {
    const state = this.connections.get(sessionId);
    if (!state) return;

    state.lastAudioAt = Date.now();

    if (!state.isReady) {
      state.buffer.push(audioData);
      return;
    }

    try {
      state.socket.send(audioData);
    } catch (e) {
      console.error("Deepgram sendAudio failed:", e.message);
    }
  }

  closeTranscriptionStream(sessionId) {
    const state = this.connections.get(sessionId);
    if (!state) return;

    try { state.socket.finish?.(); } catch {}
    try { state.socket.close?.(); } catch {}

    this.connections.delete(sessionId);
  }
}

module.exports = DeepgramService;
