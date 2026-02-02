require("dotenv").config();
const fetch = require("node-fetch");
const { createClient } = require("@deepgram/sdk");
const OpenAIService = require("./services/OpenAIService");

(async () => {
  const deepgram = createClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  const openaiService = new OpenAIService();

  // --- 1) Use Deepgram sample audio URL (no local file needed)
  const testAudioURL =
    "https://static.deepgram.com/examples/Bueller-Life-moves-pretty-fast.wav";

  const res = await fetch(testAudioURL);
  const audioBuffer = Buffer.from(await res.arrayBuffer());

  try {
    // --- 2) Transcribe audio using Deepgram prerecorded
    const dgResp = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
      model: "nova-2-phonecall",
      language: "en-US",
      punctuate: true,
      smart_format: true,
    });

    const transcript =
      dgResp?.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    if (!transcript) {
      console.log("⚠️ Transcript not found, dumping full response:");
      console.dir(dgResp, { depth: 8 });
      return;
    }

    console.log("📝 Deepgram Transcript:");
    console.log(transcript);

    // --- 3) Generate AI response using OpenAI
    const systemPrompt = "You are a friendly AI assistant on a phone call.";
    const aiResponse = await openaiService.generateResponse(transcript, systemPrompt);

    console.log("\n🤖 AI Response:");
    console.log(aiResponse);

    // --- Optional: TTS can be tested here ---
    // const ElevenLabsService = require('./services/ElevenLabsService');
    // const elevenlabs = new ElevenLabsService();
    // const audioTTS = await elevenlabs.textToSpeech(aiResponse, 'VOICE_ID_HERE');
    // require('fs').writeFileSync('ai_response.mp3', audioTTS);
    // console.log("🎵 TTS saved to ai_response.mp3");

  } catch (err) {
    console.error("❌ Error in AI call simulation:", err);
  }
})();
