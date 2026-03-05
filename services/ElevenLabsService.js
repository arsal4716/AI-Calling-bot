// services/ElevenLabsService.js — v3
const axios = require("axios");
const http = require("http");
const https = require("https");
const FormData = require("form-data");
const fs = require("fs");
const logger = require("../utils/logger");

function mulawSilenceBytes(ms = 200) {
  const bytes = Math.max(160, Math.floor((8000 * ms) / 1000));
  return Buffer.alloc(bytes, 0xff);
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

class ElevenLabsService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.baseURL = "https://api.elevenlabs.io/v1";
    this.headers = {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json",
    };

    this.defaultVoiceId = process.env.ELEVEN_DEFAULT_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17";
    this.modelId = process.env.ELEVEN_MODEL_ID || "eleven_turbo_v2_5";
    this.optimizeLatency = Number(process.env.ELEVEN_OPT_LAT || 4);
  }

  async cloneVoice(name, audioFile) {
    try {
      const formData = new FormData();
      formData.append("name", name);
      formData.append("files", fs.createReadStream(audioFile.path));
      formData.append("description", "Cloned voice for AI calling");

      const response = await axios.post(`${this.baseURL}/voices/add`, formData, {
        headers: { ...formData.getHeaders(), "xi-api-key": this.apiKey },
        timeout: 300000,
        httpsAgent,
      });

      return { voiceId: response.data.voice_id, details: response.data };
    } catch (error) {
      logger.error("ElevenLabs voice cloning error:", error.response?.data || error.message);
      throw new Error(`Voice cloning failed: ${error.response?.data?.detail || error.message}`);
    }
  }
  _voiceSettings(voiceSettings = {}) {
    const envSpeed = Number(process.env.ELEVEN_SPEED || 1.1);

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const speed = clamp(Number(voiceSettings.speed ?? envSpeed), 0.7, 1.2);

    return {
      stability: voiceSettings.stability ?? 0.5,
      similarity_boost: voiceSettings.similarity_boost ?? 0.75,
      style: voiceSettings.style ?? 0,
      use_speaker_boost: voiceSettings.use_speaker_boost ?? true,
      speed,
    };
  }

  async textToSpeech(text, voiceId, voiceSettings = {}) {
    try {
      const effectiveVoiceId = voiceId || this.defaultVoiceId;
      const response = await axios.post(
        `${this.baseURL}/text-to-speech/${effectiveVoiceId}?output_format=ulaw_8000&optimize_streaming_latency=${this.optimizeLatency}`,
        {
          text: (text || "").trim(),
          model_id: this.modelId,
          voice_settings: this._voiceSettings(voiceSettings),
        },
        {
          headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json", Accept: "audio/basic" },
          responseType: "arraybuffer",
          timeout: Number(process.env.ELEVEN_TTS_TIMEOUT_MS || 30000),
          httpsAgent,
        }
      );
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
        httpsAgent,
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
        httpsAgent,
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
        httpsAgent,
      });
      return response.data;
    } catch (error) {
      logger.error("Get voice details error:", error.message);
      return null;
    }
  }

  async streamTextToSpeechFast(text, voiceId, voiceSettings = {}) {
    const effectiveVoiceId = voiceId || this.defaultVoiceId;

    const skipNorm = process.env.ELEVEN_SKIP_NORMALIZATION === "true"
      ? "&apply_text_normalization=false"
      : "";

    const url = `${this.baseURL}/text-to-speech/${effectiveVoiceId}/stream?output_format=ulaw_8000&optimize_streaming_latency=${this.optimizeLatency}${skipNorm}`;

    const payload = {
      text: (text || "").trim(),
      model_id: this.modelId,
      voice_settings: this._voiceSettings(voiceSettings),
    };

    const headers = {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/basic",
      Connection: "keep-alive",
    };

    const timeout = Number(process.env.ELEVEN_STREAM_TIMEOUT_MS || 12000);

    try {
      const res = await axios.post(url, payload, {
        headers,
        responseType: "stream",
        timeout,
        validateStatus: (s) => s >= 200 && s < 300,
        httpsAgent,
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
          httpsAgent,
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