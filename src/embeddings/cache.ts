import { createHash } from "node:crypto";

interface CacheEntry {
  embedding: Float32Array;
  lastAccess: number;
}

export class LRUEmbeddingCache {
  private cache: Map<string, CacheEntry> = new Map();

  constructor(private maxSize: number = 10_000) {}

  static hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  get(hash: string): Float32Array | null {
    const entry = this.cache.get(hash);
    if (!entry) return null;
    entry.lastAccess = Date.now();
    return entry.embedding;
  }

  set(hash: string, embedding: Float32Array): void {
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }
    this.cache.set(hash, { embedding, lastAccess: Date.now() });
  }

  has(hash: string): boolean {
    return this.cache.has(hash);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) this.cache.delete(oldestKey);
  }
}
