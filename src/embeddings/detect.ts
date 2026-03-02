import { log } from "../utils/logger.js";
import {
  type EmbeddingProvider,
  OllamaEmbeddingProvider,
} from "./providers.js";

export async function detectEmbeddingProvider(): Promise<EmbeddingProvider> {
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

      throw new Error(
        "Ollama is running but no embedding model found. Install one with: ollama pull nomic-embed-text",
      );
    }

    throw new Error(`Ollama responded with status ${response.status}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Ollama")) {
      throw error;
    }
    throw new Error(
      `Ollama is required but not reachable at ${ollamaUrl}. Start it with: ollama serve`,
    );
  }
}
