export interface MemoryChunk {
  id: string;
  content: string;
  source: MemorySource;
  category: MemoryCategory;
  tags: string[];
  importance: number;
  timestamp: number;
}

export type MemorySource =
  | "user_message"
  | "assistant_message"
  | "system"
  | "file_content"
  | "long_term_memory";

export type MemoryCategory =
  | "fact"
  | "preference"
  | "decision"
  | "code_pattern"
  | "error"
  | "conversation";

export interface SearchFilters {
  category?: MemoryCategory;
  source?: MemorySource;
  tags?: string[];
  minImportance?: number;
}

export interface SearchResult {
  chunk: MemoryChunk;
  score: number;
}

export interface StorageStats {
  totalChunks: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
}

export interface StorageBackend {
  initialize(): Promise<void>;
  close(): Promise<void>;
  addChunk(chunk: MemoryChunk): Promise<MemoryChunk>;
  getChunk(id: string): Promise<MemoryChunk | null>;
  deleteChunk(id: string): Promise<boolean>;
  search(
    query: string,
    limit: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]>;
  list(
    limit: number,
    offset: number,
    filters?: SearchFilters,
  ): Promise<MemoryChunk[]>;
  getStats(): Promise<StorageStats>;
}
