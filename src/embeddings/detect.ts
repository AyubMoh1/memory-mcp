import { log } from "../utils/logger.js";
import {
  type EmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  GeminiEmbeddingProvider,
  MockEmbeddingProvider,
} from "./providers.js";

export async function detectEmbeddingProvider(): Promise<EmbeddingProvider> {
  // 1. Try Ollama (local, free)
  const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = (await response.json()) as {
        models?: { name: string }[];
      };

      // Check for embedding models
      const models = data.models || [];
      const embeddingModels = [
        { name: "nomic-embed-text", dimensions: 768 },
        { name: "mxbai-embed-large", dimensions: 1024 },
        { name: "all-minilm", dimensions: 384 },
      ];

      for (const em of embeddingModels) {
        const found = models.find((m) => m.name.startsWith(em.name));
        if (found) {
          log.info(`Using Ollama embedding: ${found.name} (${em.dimensions}d)`);
          return new OllamaEmbeddingProvider(ollamaUrl, found.name, em.dimensions);
        }
      }

      log.info("Ollama running but no embedding models found");
    }
  } catch {
    // Ollama not available
  }

  // 2. Try OpenAI
  if (process.env.OPENAI_API_KEY) {
    log.info("Using OpenAI embedding: text-embedding-3-small (1536d)");
    return new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY);
  }

  // 3. Try Gemini
  if (process.env.GEMINI_API_KEY) {
    log.info("Using Gemini embedding: embedding-001 (768d)");
    return new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY);
  }

  // 4. Mock fallback (keyword-only search still works)
  log.info("No embedding provider found — using mock (keyword search only)");
  return new MockEmbeddingProvider();
}
