import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../utils/logger.js";
import type {
  MemoryChunk,
  MemoryCategory,
  MemorySource,
  SearchFilters,
  SearchResult,
  StorageBackend,
  StorageStats,
} from "./types.js";

export class SQLiteStorage implements StorageBackend {
  private db: Database.Database | null = null;
  private vecEnabled = false;

  constructor(
    private dbPath: string,
    private embeddingDimensions: number = 768,
  ) {}

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Load sqlite-vec extension
    try {
      sqliteVec.load(this.db);
      this.vecEnabled = true;
      log.info("sqlite-vec extension loaded");
    } catch (err) {
      log.error("Failed to load sqlite-vec, vector search disabled:", err);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'system',
        category TEXT NOT NULL DEFAULT 'fact',
        tags TEXT DEFAULT '[]',
        importance REAL DEFAULT 0.5,
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_source ON memory_chunks(source);
      CREATE INDEX IF NOT EXISTS idx_chunks_category ON memory_chunks(category);
      CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON memory_chunks(timestamp);
      CREATE INDEX IF NOT EXISTS idx_chunks_importance ON memory_chunks(importance);

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        chunk_id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );
    `);

    if (this.vecEnabled) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding FLOAT[${this.embeddingDimensions}]
        );
      `);
    }

    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_chunks")
      .get() as { count: number };
    log.info(
      `Initialized SQLite storage at ${this.dbPath} (${count.count} memories, vec: ${this.vecEnabled})`,
    );
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async addChunk(
    chunk: MemoryChunk,
    embedding?: Float32Array,
  ): Promise<MemoryChunk> {
    const db = this.getDb();
    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO memory_chunks (id, content, source, category, tags, importance, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        chunk.id,
        chunk.content,
        chunk.source,
        chunk.category,
        JSON.stringify(chunk.tags),
        chunk.importance,
        chunk.timestamp,
      );

      db.prepare(
        "INSERT INTO fts_chunks (chunk_id, content) VALUES (?, ?)",
      ).run(chunk.id, chunk.content);

      if (embedding && this.vecEnabled) {
        db.prepare(
          "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
        ).run(chunk.id, Buffer.from(embedding.buffer));
      }
    });

    insert();
    return chunk;
  }

  async getChunk(id: string): Promise<MemoryChunk | null> {
    const row = this.getDb()
      .prepare("SELECT * FROM memory_chunks WHERE id = ?")
      .get(id) as RawChunkRow | undefined;

    return row ? this.rowToChunk(row) : null;
  }

  async deleteChunk(id: string): Promise<boolean> {
    const db = this.getDb();
    const del = db.transaction(() => {
      const result = db
        .prepare("DELETE FROM memory_chunks WHERE id = ?")
        .run(id);
      db.prepare("DELETE FROM fts_chunks WHERE chunk_id = ?").run(id);
      if (this.vecEnabled) {
        db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?").run(id);
      }
      return result.changes > 0;
    });

    return del();
  }

  async search(
    query: string,
    limit: number,
    filters?: SearchFilters,
    queryEmbedding?: Float32Array,
  ): Promise<SearchResult[]> {
    return this.hybridSearch(query, limit, filters, queryEmbedding);
  }

  async list(
    limit: number,
    offset: number,
    filters?: SearchFilters,
  ): Promise<MemoryChunk[]> {
    const { where, params } = this.buildFilterClause(
      filters,
      "memory_chunks",
    );
    const sql = `
      SELECT * FROM memory_chunks
      ${where ? `WHERE ${where}` : ""}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.getDb().prepare(sql).all(...params) as RawChunkRow[];
    return rows.map((r) => this.rowToChunk(r));
  }

  async getStats(): Promise<StorageStats> {
    const db = this.getDb();

    const total = db
      .prepare("SELECT COUNT(*) as count FROM memory_chunks")
      .get() as { count: number };

    const categoryRows = db
      .prepare(
        "SELECT category, COUNT(*) as count FROM memory_chunks GROUP BY category",
      )
      .all() as { category: string; count: number }[];

    const sourceRows = db
      .prepare(
        "SELECT source, COUNT(*) as count FROM memory_chunks GROUP BY source",
      )
      .all() as { source: string; count: number }[];

    const dateRange = db
      .prepare(
        "SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM memory_chunks",
      )
      .get() as { oldest: number | null; newest: number | null };

    const byCategory: Record<string, number> = {};
    for (const row of categoryRows) byCategory[row.category] = row.count;

    const bySource: Record<string, number> = {};
    for (const row of sourceRows) bySource[row.source] = row.count;

    return {
      totalChunks: total.count,
      byCategory,
      bySource,
      oldestTimestamp: dateRange.oldest,
      newestTimestamp: dateRange.newest,
    };
  }

  get isVecEnabled(): boolean {
    return this.vecEnabled;
  }

  hybridSearch(
    query: string,
    limit: number,
    filters?: SearchFilters,
    queryEmbedding?: Float32Array,
  ): SearchResult[] {
    const keywordResults = this.keywordSearch(query, limit * 3, filters);

    if (!queryEmbedding || !this.vecEnabled) {
      return keywordResults.slice(0, limit);
    }

    let vectorResults: SearchResult[] = [];
    try {
      vectorResults = this.vectorSearch(queryEmbedding, limit * 3, filters);
    } catch (err) {
      log.error("Vector search failed, using keyword-only:", err);
      return keywordResults.slice(0, limit);
    }

    // Merge with 70% vector / 30% keyword weighting
    const scoreMap = new Map<string, { chunk: MemoryChunk; vectorScore: number; keywordScore: number }>();

    for (const r of vectorResults) {
      scoreMap.set(r.chunk.id, {
        chunk: r.chunk,
        vectorScore: r.score,
        keywordScore: 0,
      });
    }

    for (const r of keywordResults) {
      const existing = scoreMap.get(r.chunk.id);
      if (existing) {
        existing.keywordScore = r.score;
      } else {
        scoreMap.set(r.chunk.id, {
          chunk: r.chunk,
          vectorScore: 0,
          keywordScore: r.score,
        });
      }
    }

    const merged: SearchResult[] = [];
    for (const entry of scoreMap.values()) {
      merged.push({
        chunk: entry.chunk,
        score: entry.vectorScore * 0.7 + entry.keywordScore * 0.3,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }

  vectorSearch(
    queryEmbedding: Float32Array,
    limit: number,
    filters?: SearchFilters,
  ): SearchResult[] {
    if (!this.vecEnabled) return [];

    const db = this.getDb();
    const sql = `
      SELECT vc.chunk_id, vc.distance, mc.*
      FROM vec_chunks vc
      JOIN memory_chunks mc ON mc.id = vc.chunk_id
      WHERE vc.embedding MATCH ?
        AND k = ?
      ORDER BY vc.distance
    `;

    const rows = db
      .prepare(sql)
      .all(Buffer.from(queryEmbedding.buffer), limit) as (RawChunkRow & {
      chunk_id: string;
      distance: number;
    })[];

    // Convert cosine distance to similarity score (0-1)
    const results: SearchResult[] = rows.map((row) => ({
      chunk: this.rowToChunk(row),
      score: 1 / (1 + row.distance),
    }));

    // Apply filters post-query (vec0 doesn't support WHERE on joined tables in MATCH)
    if (filters) {
      return results.filter((r) => this.matchesFilters(r.chunk, filters));
    }
    return results;
  }

  keywordSearch(
    query: string,
    limit: number,
    filters?: SearchFilters,
  ): SearchResult[] {
    const sanitized = this.sanitizeFTS5(query);
    if (!sanitized) return [];

    const { where, params } = this.buildFilterClause(filters);
    const filterJoin = where ? `AND ${where}` : "";

    const sql = `
      SELECT mc.*, bm25(fts_chunks) as rank
      FROM fts_chunks
      JOIN memory_chunks mc ON mc.id = fts_chunks.chunk_id
      WHERE fts_chunks MATCH ?
      ${filterJoin}
      ORDER BY rank
      LIMIT ?
    `;

    try {
      const rows = this.getDb()
        .prepare(sql)
        .all(sanitized, ...params, limit) as (RawChunkRow & {
        rank: number;
      })[];

      // BM25 returns negative scores (lower = better match), normalize to 0-1
      const maxRank = rows.length
        ? Math.abs(rows[rows.length - 1].rank)
        : 1;
      const minRank = rows.length ? Math.abs(rows[0].rank) : 0;
      const range = maxRank - minRank || 1;

      return rows.map((row) => ({
        chunk: this.rowToChunk(row),
        score: 1 - (Math.abs(row.rank) - minRank) / range,
      }));
    } catch (err) {
      log.error("FTS5 search failed, falling back to LIKE:", err);
      return this.fallbackSearch(query, limit, filters);
    }
  }

  private fallbackSearch(
    query: string,
    limit: number,
    filters?: SearchFilters,
  ): SearchResult[] {
    const { where, params } = this.buildFilterClause(
      filters,
      "memory_chunks",
    );
    const filterClause = where ? `AND ${where}` : "";

    const sql = `
      SELECT * FROM memory_chunks
      WHERE content LIKE ?
      ${filterClause}
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    const rows = this.getDb()
      .prepare(sql)
      .all(`%${query}%`, ...params, limit) as RawChunkRow[];

    return rows.map((row, i) => ({
      chunk: this.rowToChunk(row),
      score: 1 - i / (rows.length || 1),
    }));
  }

  private matchesFilters(
    chunk: MemoryChunk,
    filters: SearchFilters,
  ): boolean {
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

  private sanitizeFTS5(text: string): string {
    return text
      .replace(/[^\w\s]/g, " ")
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildFilterClause(
    filters?: SearchFilters,
    tableAlias: string = "mc",
  ): {
    where: string;
    params: unknown[];
  } {
    if (!filters) return { where: "", params: [] };

    const t = tableAlias;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.category) {
      conditions.push(`${t}.category = ?`);
      params.push(filters.category);
    }
    if (filters.source) {
      conditions.push(`${t}.source = ?`);
      params.push(filters.source);
    }
    if (filters.minImportance !== undefined) {
      conditions.push(`${t}.importance >= ?`);
      params.push(filters.minImportance);
    }
    if (filters.tags && filters.tags.length > 0) {
      const tagConditions = filters.tags.map(() => `${t}.tags LIKE ?`);
      conditions.push(`(${tagConditions.join(" OR ")})`);
      params.push(...filters.tags.map((tag) => `%"${tag}"%`));
    }

    return {
      where: conditions.join(" AND "),
      params,
    };
  }

  private rowToChunk(row: RawChunkRow): MemoryChunk {
    return {
      id: row.id,
      content: row.content,
      source: row.source as MemorySource,
      category: row.category as MemoryCategory,
      tags: JSON.parse(row.tags || "[]"),
      importance: row.importance,
      timestamp: row.timestamp,
    };
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error("Database not initialized");
    return this.db;
  }
}

interface RawChunkRow {
  id: string;
  content: string;
  source: string;
  category: string;
  tags: string;
  importance: number;
  timestamp: number;
  created_at: number;
}
