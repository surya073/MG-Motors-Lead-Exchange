import apiClient from "./axiosInstance";

export const aiAssistantService = {
  async ask(message, history = []) {
    const { data } = await apiClient.post("/mg_motors_au_function/ai-assistant/query", { message, history });
    return data; // { reply, audio }
  },

  async askByVoice(audioBlob, history = []) {
    const form = new FormData();
    form.append("audio", audioBlob, "voice.webm");
    form.append("history", JSON.stringify(history));
    const { data } = await apiClient.post("/mg_motors_au_function/ai-assistant/voice", form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return data; // { transcript, reply, audio }
  },
};