import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL.replace(/\/$/, "") } : {}),
});

export function createResponsesModel(modelId: string) {
  return openai.responses(modelId);
}

// Qasey uses the native OpenAI Responses API deliberately. Do not replace these
// with openai.chat(...) for OpenAI-compatible gateways.
export const qaseyResponsesModel = createResponsesModel("gpt-5.6-sol");
export const intentResponsesModel = createResponsesModel("gpt-5.4-mini");
