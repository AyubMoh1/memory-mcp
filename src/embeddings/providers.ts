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

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = "openai";
  dimensions = 1536;

  constructor(
    private apiKey: string,
    private model: string = "text-embedding-3-small",
  ) {}

  async generateEmbedding(text: string): Promise<Float32Array> {
    const [result] = await this.generateEmbeddings([text]);
    return result;
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embed failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: { embedding: number[] }[];
    };
    return data.data.map((d) => new Float32Array(d.embedding));
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  name = "gemini";
  dimensions = 768;

  constructor(
    private apiKey: string,
    private model: string = "embedding-001",
  ) {}

  async generateEmbedding(text: string): Promise<Float32Array> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini embed failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      embedding: { values: number[] };
    };
    return new Float32Array(data.embedding.values);
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.generateEmbedding(t)));
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
    case "openai":
      if (!config?.apiKey) throw new Error("OpenAI API key required");
      return new OpenAIEmbeddingProvider(config.apiKey, config.model);
    case "gemini":
      if (!config?.apiKey) throw new Error("Gemini API key required");
      return new GeminiEmbeddingProvider(config.apiKey, config.model);
    case "mock":
      return new MockEmbeddingProvider();
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
