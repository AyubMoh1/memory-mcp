import Database from "better-sqlite3";
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

  constructor(private dbPath: string) {}

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

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

    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_chunks")
      .get() as { count: number };
    log.info(`Initialized SQLite storage at ${this.dbPath} (${count.count} memories)`);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async addChunk(chunk: MemoryChunk): Promise<MemoryChunk> {
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
      return result.changes > 0;
    });

    return del();
  }

  async search(
    query: string,
    limit: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    return this.keywordSearch(query, limit, filters);
  }

  async list(
    limit: number,
    offset: number,
    filters?: SearchFilters,
  ): Promise<MemoryChunk[]> {
    const { where, params } = this.buildFilterClause(filters, "memory_chunks");
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
        .all(sanitized, ...params, limit) as (RawChunkRow & { rank: number })[];

      // BM25 returns negative scores (lower = better match), normalize to 0-1
      const maxRank = rows.length ? Math.abs(rows[rows.length - 1].rank) : 1;
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
    const { where, params } = this.buildFilterClause(filters, "memory_chunks");
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
      params.push(...filters.tags.map((t) => `%"${t}"%`));
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
