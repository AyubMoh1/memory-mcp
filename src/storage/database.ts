import type {
  MemoryChunk,
  SearchFilters,
  SearchResult,
  StorageBackend,
  StorageStats,
} from "./types.js";

export class InMemoryStorage implements StorageBackend {
  private chunks: Map<string, MemoryChunk> = new Map();

  async initialize(): Promise<void> {
    // No-op for in-memory storage
  }

  async close(): Promise<void> {
    this.chunks.clear();
  }

  async addChunk(chunk: MemoryChunk): Promise<MemoryChunk> {
    this.chunks.set(chunk.id, chunk);
    return chunk;
  }

  async getChunk(id: string): Promise<MemoryChunk | null> {
    return this.chunks.get(id) ?? null;
  }

  async deleteChunk(id: string): Promise<boolean> {
    return this.chunks.delete(id);
  }

  async search(
    query: string,
    limit: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    const queryLower = query.toLowerCase();
    const words = queryLower.split(/\s+/).filter(Boolean);

    const results: SearchResult[] = [];

    for (const chunk of this.chunks.values()) {
      if (!this.matchesFilters(chunk, filters)) continue;

      const contentLower = chunk.content.toLowerCase();
      let matchedWords = 0;
      for (const word of words) {
        if (contentLower.includes(word)) matchedWords++;
      }

      if (matchedWords === 0) continue;

      const score = matchedWords / words.length;
      results.push({ chunk, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async list(
    limit: number,
    offset: number,
    filters?: SearchFilters,
  ): Promise<MemoryChunk[]> {
    let chunks = Array.from(this.chunks.values());

    if (filters) {
      chunks = chunks.filter((c) => this.matchesFilters(c, filters));
    }

    chunks.sort((a, b) => b.timestamp - a.timestamp);
    return chunks.slice(offset, offset + limit);
  }

  async getStats(): Promise<StorageStats> {
    const chunks = Array.from(this.chunks.values());
    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const chunk of chunks) {
      byCategory[chunk.category] = (byCategory[chunk.category] ?? 0) + 1;
      bySource[chunk.source] = (bySource[chunk.source] ?? 0) + 1;
    }

    const timestamps = chunks.map((c) => c.timestamp);

    return {
      totalChunks: chunks.length,
      byCategory,
      bySource,
      oldestTimestamp: timestamps.length ? Math.min(...timestamps) : null,
      newestTimestamp: timestamps.length ? Math.max(...timestamps) : null,
    };
  }

  private matchesFilters(chunk: MemoryChunk, filters?: SearchFilters): boolean {
    if (!filters) return true;
    if (filters.category && chunk.category !== filters.category) return false;
    if (filters.source && chunk.source !== filters.source) return false;
    if (
      filters.minImportance !== undefined &&
      chunk.importance < filters.minImportance
    )
      return false;
    if (filters.tags && filters.tags.length > 0) {
      const hasTag = filters.tags.some((t) => chunk.tags.includes(t));
      if (!hasTag) return false;
    }
    return true;
  }
}
