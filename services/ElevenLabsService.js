const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

class ElevenLabsService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.baseURL = "https://api.elevenlabs.io/v1";
    this.headers = {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  async cloneVoice(name, audioFile) {
    try {
      const formData = new FormData();
      formData.append("name", name);
      formData.append("files", fs.createReadStream(audioFile.path));
      formData.append("description", "Cloned voice for AI calling");

      const response = await axios.post(
        `${this.baseURL}/voices/add`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            "xi-api-key": this.apiKey,
          },
          timeout: 300000,
        },
      );

      return {
        voiceId: response.data.voice_id,
        details: response.data,
      };
    } catch (error) {
      console.error(
        "ElevenLabs voice cloning error:",
        error.response?.data || error.message,
      );
      throw new Error(
        `Voice cloning failed: ${error.response?.data?.detail || error.message}`,
      );
    }
  }
  async textToSpeech(text, voiceId, voiceSettings = {}) {
    try {
      console.log(
        `🎵TTS Request: voice=${voiceId}, text="${text.substring(0, 50)}..."`,
      );

      const effectiveVoiceId = voiceId || "CwhRBWXzGAHq8TQ4Fs17";

      const response = await axios.post(
        `${this.baseURL}/text-to-speech/${effectiveVoiceId}`,
        {
          text: text,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: voiceSettings.stability || 0.5,
            similarity_boost: voiceSettings.similarity_boost || 0.75,
            style: voiceSettings.style || 0,
            use_speaker_boost: voiceSettings.use_speaker_boost || true,
          },
        },
        {
          headers: {
            "xi-api-key": this.apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          responseType: "arraybuffer",
          timeout: 30000,
        },
      );

      console.log(`TTS Success: ${response.data.length} bytes (MP3)`);
      return Buffer.from(response.data);
    } catch (error) {
      console.error("TTS Error:", error.message);

      return Buffer.from([0xff, 0xfb]);
    }
  }

  async getVoices() {
    try {
      const response = await axios.get(`${this.baseURL}/voices`, {
        headers: {
          "xi-api-key": this.apiKey,
        },
      });
      return response.data.voices;
    } catch (error) {
      console.error("Get voices error:", error);
      throw error;
    }
  }

  async deleteVoice(voiceId) {
    try {
      await axios.delete(`${this.baseURL}/voices/${voiceId}`, {
        headers: this.headers,
      });
    } catch (error) {
      console.error("Delete voice error:", error);
    }
  }

  async getVoiceDetails(voiceId) {
    try {
      const response = await axios.get(`${this.baseURL}/voices/${voiceId}`, {
        headers: this.headers,
      });
      return response.data;
    } catch (error) {
      console.error("Get voice details error:", error);
      return null;
    }
  }

  async streamTextToSpeech(text, voiceId, voiceSettings = {}) {
    const effectiveVoiceId = voiceId || "CwhRBWXzGAHq8TQ4Fs17";

    const response = await axios.post(
      `${this.baseURL}/text-to-speech/${effectiveVoiceId}/stream`,
      {
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: voiceSettings.stability ?? 0.5,
          similarity_boost: voiceSettings.similarity_boost ?? 0.75,
          style: voiceSettings.style ?? 0,
          use_speaker_boost: voiceSettings.use_speaker_boost ?? true,
        },
      },
      {
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "stream",
        timeout: 30000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: (s) => s >= 200 && s < 300,
      },
    );

    return response.data;
  }
}

module.exports = ElevenLabsService;
