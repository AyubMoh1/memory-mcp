import type { TranscriptMessage } from "./transcript.js";
import { log } from "../utils/logger.js";

const PREFERRED_MODELS = ["llama3.2", "llama3.1", "llama3"];
const MAX_INPUT_CHARS = 32_000; // ~8000 tokens

interface OllamaTagsResponse {
  models?: { name: string }[];
}

interface OllamaChatResponse {
  message?: { content?: string };
}

async function detectChatModel(ollamaUrl: string): Promise<string> {
  const response = await fetch(`${ollamaUrl}/api/tags`);
  if (!response.ok) throw new Error(`Ollama not reachable: ${response.status}`);

  const data = (await response.json()) as OllamaTagsResponse;
  const models = data.models || [];
  const modelNames = models.map((m) => m.name);

  for (const preferred of PREFERRED_MODELS) {
    const found = modelNames.find((n) => n.startsWith(preferred));
    if (found) return found;
  }

  // Filter out embedding-only models, pick first available
  const chatModel = modelNames.find(
    (n) =>
      !n.includes("embed") &&
      !n.includes("nomic") &&
      !n.includes("minilm") &&
      !n.includes("mxbai"),
  );

  if (chatModel) return chatModel;
  throw new Error("No chat model found in Ollama. Install one with: ollama pull llama3.2");
}

function formatMessages(messages: TranscriptMessage[]): string {
  const formatted = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  // Truncate from the beginning to keep recent context
  if (formatted.length > MAX_INPUT_CHARS) {
    return formatted.slice(-MAX_INPUT_CHARS);
  }
  return formatted;
}

export async function summarizeConversation(
  messages: TranscriptMessage[],
  ollamaUrl?: string,
): Promise<string> {
  const url = ollamaUrl || process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const model = await detectChatModel(url);
  log.info(`Summarizing with model: ${model}`);

  const conversationText = formatMessages(messages);

  const response = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "Summarize this conversation concisely. Focus on: decisions made, user preferences, code patterns, errors encountered, and key facts learned. Output only the summary, no preamble.",
        },
        {
          role: "user",
          content: conversationText,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama chat failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OllamaChatResponse;
  return data.message?.content?.trim() || "";
}
