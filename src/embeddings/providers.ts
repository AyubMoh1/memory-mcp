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
