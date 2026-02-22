// services/ElevenLabsService.js
// Production-safe + low latency
// Fixes:
// - use_speaker_boost was broken in textToSpeech (false became true because of `|| true`)
// - Return REAL mulaw silence on errors (not MP3 header bytes)
// - Add small retry for stream request (helps random 5xx / network hiccups)
// - Keep timeouts realistic for streaming; still low-latency with optimize_streaming_latency

const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const logger = require("../utils/logger");

function mulawSilenceBytes(ms = 200) {
  // mulaw 8kHz mono: 8000 bytes/sec
  const bytes = Math.max(160, Math.floor((8000 * ms) / 1000));
  return Buffer.alloc(bytes, 0xff); // common mulaw silence
}

class ElevenLabsService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.baseURL = "https://api.elevenlabs.io/v1";
    this.headers = {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json",
    };

    this.defaultVoiceId = process.env.ELEVEN_DEFAULT_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17";
    this.modelId = process.env.ELEVEN_MODEL_ID || "eleven_monolingual_v1";
    this.optimizeLatency = Number(process.env.ELEVEN_OPT_LAT || 4);
  }

  async cloneVoice(name, audioFile) {
    try {
      const formData = new FormData();
      formData.append("name", name);
      formData.append("files", fs.createReadStream(audioFile.path));
      formData.append("description", "Cloned voice for AI calling");

      const response = await axios.post(`${this.baseURL}/voices/add`, formData, {
        headers: {
          ...formData.getHeaders(),
          "xi-api-key": this.apiKey,
        },
        timeout: 300000,
      });

      return {
        voiceId: response.data.voice_id,
        details: response.data,
      };
    } catch (error) {
      logger.error(
        "ElevenLabs voice cloning error:",
        error.response?.data || error.message
      );
      throw new Error(
        `Voice cloning failed: ${error.response?.data?.detail || error.message}`
      );
    }
  }

  _voiceSettings(voiceSettings = {}) {
    return {
      stability: voiceSettings.stability ?? 0.5,
      similarity_boost: voiceSettings.similarity_boost ?? 0.75,
      style: voiceSettings.style ?? 0,

      // IMPORTANT: allow false
      use_speaker_boost: voiceSettings.use_speaker_boost ?? true,
    };
  }

  async textToSpeech(text, voiceId, voiceSettings = {}) {
    try {
      const effectiveVoiceId = voiceId || this.defaultVoiceId;

      logger.info(
        `TTS Request: voice=${effectiveVoiceId}, text="${String(text).substring(0, 60)}..."`
      );

      const response = await axios.post(
        `${this.baseURL}/text-to-speech/${effectiveVoiceId}?output_format=ulaw_8000&optimize_streaming_latency=${this.optimizeLatency}`,
        {
          text,
          model_id: this.modelId,
          voice_settings: this._voiceSettings(voiceSettings),
        },
        {
          headers: {
            "xi-api-key": this.apiKey,
            "Content-Type": "application/json",
            Accept: "audio/basic",
          },
          responseType: "arraybuffer",
          timeout: Number(process.env.ELEVEN_TTS_TIMEOUT_MS || 30000),
        }
      );

      logger.info(`TTS Success: ${response.data.length} bytes (ULAW)`);
      return Buffer.from(response.data);
    } catch (error) {
      logger.error("TTS Error:", error.response?.data || error.message);
      return mulawSilenceBytes(240);
    }
  }

  async getVoices() {
    try {
      const response = await axios.get(`${this.baseURL}/voices`, {
        headers: { "xi-api-key": this.apiKey },
        timeout: 15000,
      });
      return response.data.voices;
    } catch (error) {
      logger.error("Get voices error:", error.message);
      throw error;
    }
  }

  async deleteVoice(voiceId) {
    try {
      await axios.delete(`${this.baseURL}/voices/${voiceId}`, {
        headers: this.headers,
        timeout: 15000,
      });
    } catch (error) {
      logger.error("Delete voice error:", error.message);
    }
  }

  async getVoiceDetails(voiceId) {
    try {
      const response = await axios.get(`${this.baseURL}/voices/${voiceId}`, {
        headers: this.headers,
        timeout: 15000,
      });
      return response.data;
    } catch (error) {
      logger.error("Get voice details error:", error.message);
      return null;
    }
  }

  async streamTextToSpeechFast(text, voiceId, voiceSettings = {}) {
    const effectiveVoiceId = voiceId || this.defaultVoiceId;
    const url = `${this.baseURL}/text-to-speech/${effectiveVoiceId}/stream?output_format=ulaw_8000&optimize_streaming_latency=${this.optimizeLatency}`;

    const payload = {
      text,
      model_id: this.modelId,
      voice_settings: this._voiceSettings(voiceSettings),
    };

    const headers = {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/basic",
    };

    const timeout = Number(process.env.ELEVEN_STREAM_TIMEOUT_MS || 20000);

    // Small retry (1) for transient network/5xx
    try {
      const res = await axios.post(url, payload, {
        headers,
        responseType: "stream",
        timeout,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return res.data;
    } catch (e1) {
      logger.error(`Eleven stream failed (try1): ${e1.message}`);
      try {
        const res2 = await axios.post(url, payload, {
          headers,
          responseType: "stream",
          timeout,
          validateStatus: (s) => s >= 200 && s < 300,
        });
        return res2.data;
      } catch (e2) {
        logger.error(`Eleven stream failed (try2): ${e2.message}`);
        throw e2;
      }
    }
  }
}

module.exports = ElevenLabsService;