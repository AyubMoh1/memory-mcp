import { log } from "../utils/logger.js";
import {
  type EmbeddingProvider,
  OllamaEmbeddingProvider,
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

  // 2. Mock fallback (keyword-only search still works)
  log.info("No embedding provider found — using mock (keyword search only)");
  return new MockEmbeddingProvider();
}
