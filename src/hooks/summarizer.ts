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

export interface ExtractedKnowledge {
  category: "fact" | "decision" | "preference" | "error" | "code_pattern";
  content: string;
  importance: number;
}

export interface SummarizationResult {
  summary: string;
  extracted: ExtractedKnowledge[];
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

const EXTRACTION_PROMPT = `Analyze this conversation and output JSON with two fields:

1. "summary": A concise 2-4 sentence summary of what happened in this session.

2. "extracted": An array of specific knowledge items extracted from the conversation. Each item should have:
   - "category": one of "fact", "decision", "preference", "error", "code_pattern"
   - "content": the specific knowledge (1-2 sentences, self-contained)
   - "importance": 0.6-0.9 based on how useful this would be to recall in a future session

Categories explained:
- "fact": Specific technical facts learned (e.g. "The grub.cfg uses maxcpus=2 to limit CPU count on xs1 devices")
- "decision": Choices made and their reasoning (e.g. "Decided to remove IMAGE_WAS_CACHED check because modifications are idempotent")
- "preference": User preferences or corrections (e.g. "User prefers short responses without trailing summaries")
- "error": Bugs found and their root causes (e.g. "Sed quoting bug: single quotes inside single-quoted bash -c block breaks the command")
- "code_pattern": Reusable patterns or approaches (e.g. "Use double quotes for sed inside single-quoted bash -c blocks")

Only extract items that would genuinely be useful to recall later. Skip trivial or obvious items. Output 0-8 items.

Output ONLY valid JSON, no markdown fences, no preamble:
{"summary": "...", "extracted": [...]}`;

export async function summarizeConversation(
  messages: TranscriptMessage[],
  ollamaUrl?: string,
): Promise<string> {
  const result = await extractKnowledge(messages, ollamaUrl);
  return result.summary;
}

export async function extractKnowledge(
  messages: TranscriptMessage[],
  ollamaUrl?: string,
): Promise<SummarizationResult> {
  const url = ollamaUrl || process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const model = await detectChatModel(url);
  log.info(`Extracting knowledge with model: ${model}`);

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
          content: EXTRACTION_PROMPT,
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
  const rawContent = data.message?.content?.trim() || "";

  // Try to parse as structured JSON
  try {
    const parsed = JSON.parse(rawContent) as { summary?: string; extracted?: ExtractedKnowledge[] };
    const summary = parsed.summary || "";
    const extracted = (parsed.extracted || []).filter(
      (item) =>
        item.category &&
        item.content &&
        typeof item.importance === "number" &&
        ["fact", "decision", "preference", "error", "code_pattern"].includes(item.category),
    );

    // Clamp importance values
    for (const item of extracted) {
      item.importance = Math.max(0.5, Math.min(0.9, item.importance));
    }

    log.info(`Extracted ${extracted.length} knowledge items + summary`);
    return { summary, extracted };
  } catch {
    // Fallback: treat entire response as summary (backward compatible)
    log.info("Could not parse structured extraction, using raw summary");
    return { summary: rawContent, extracted: [] };
  }
}
