import { log } from "../utils/logger.js";

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  generateEmbedding(text: string): Promise<Float32Array>;
  generateEmbeddings(texts: string[]): Promise<Float32Array[]>;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  name = "ollama";
  dimensions: number;

  constructor(
    private baseUrl: string = "http://127.0.0.1:11434",
    private model: string = "nomic-embed-text",
    dimensions: number = 768,
  ) {
    this.dimensions = dimensions;
  }

  async generateEmbedding(text: string): Promise<Float32Array> {
    const [result] = await this.generateEmbeddings([text]);
    return result;
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings.map((e) => new Float32Array(e));
  }
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  name = "mock";
  dimensions = 128;

  async generateEmbedding(text: string): Promise<Float32Array> {
    // Deterministic pseudo-random embedding from text hash
    const embedding = new Float32Array(this.dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < this.dimensions; i++) {
      embedding[i] = Math.sin(hash + i * 0.1) * 0.5;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += embedding[i] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dimensions; i++) embedding[i] /= norm;
    return embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.generateEmbedding(t)));
  }
}

export function createEmbeddingProvider(
  provider: string,
  config?: Record<string, string>,
): EmbeddingProvider {
  switch (provider) {
    case "ollama":
      return new OllamaEmbeddingProvider(
        config?.url || "http://127.0.0.1:11434",
        config?.model || "nomic-embed-text",
        parseInt(config?.dimensions || "768", 10),
      );
    case "mock":
      return new MockEmbeddingProvider();
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
