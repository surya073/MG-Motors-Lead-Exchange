import apiClient from "./axiosInstance";

// The shared apiClient's default timeout (15s, see config/env.js) is sized
// for ordinary CRUD/dashboard calls. The assistant can take a Gemini
// tool-calling loop of up to 4 sequential steps to answer a broad question
// ("today's summary" can chain dashboard + Happy/Unhappy + dealer lookups),
// each step being its own Gemini round trip plus a real datastore query —
// comfortably past 15s for a multi-step answer even though it's working
// correctly. A too-short timeout here doesn't surface as an error from the
// backend at all (axios never gets a response to report), so it looked
// like "the assistant is broken" when it was actually just cut off early.
//
// NOTE: a real SSE-streaming version of ask() was tried here and reverted —
// it broke every query in production in a way that couldn't be diagnosed
// without live server logs this environment doesn't have access to. Do not
// reintroduce streaming without a way to verify it end-to-end first.
const AI_REQUEST_TIMEOUT_MS = 60000;

export const aiAssistantService = {
  async ask(message, history = []) {
    const { data } = await apiClient.post(
      "/mg_motors_au_function/ai-assistant/query",
      { message, history },
      { timeout: AI_REQUEST_TIMEOUT_MS }
    );
    return data; // { reply, audio }
  },

  async askByVoice(audioBlob, history = []) {
    const form = new FormData();
    form.append("audio", audioBlob, "voice.webm");
    form.append("history", JSON.stringify(history));
    const { data } = await apiClient.post("/mg_motors_au_function/ai-assistant/voice", form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: AI_REQUEST_TIMEOUT_MS,
    });
    return data; // { transcript, reply, audio }
  },

  // Speech-to-text only — no Gemini call, no TTS. Lets the UI show the
  // user's transcribed message immediately, then hand it to ask() (the
  // same path a typed message takes) for the actual assistant turn.
  async transcribe(audioBlob) {
    const form = new FormData();
    form.append("audio", audioBlob, "voice.webm");
    const { data } = await apiClient.post("/mg_motors_au_function/ai-assistant/transcribe", form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: AI_REQUEST_TIMEOUT_MS,
    });
    return data; // { transcript }
  },
};
