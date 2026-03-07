import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

interface RawChunkRow {
  id: string;
  content: string;
  source: string;
  category: string;
  tags: string;
  importance: number;
  timestamp: number;
  created_at: number;
  last_accessed: number | null;
  access_count: number;
}

interface TelemetryRow {
  id: number;
  event_type: string;
  tool_name: string | null;
  project: string | null;
  latency_ms: number | null;
  success: number | null;
  metadata: string | null;
  timestamp: number;
}

export class DashboardDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
    this.db.pragma("journal_mode = WAL");
    try {
      sqliteVec.load(this.db);
    } catch {
      // vec not needed for dashboard reads
    }
  }

  close(): void {
    this.db.close();
  }

  getProjects(): { project: string; count: number }[] {
    const rows = this.db.prepare(`
      SELECT tags FROM memory_chunks
    `).all() as { tags: string }[];

    const projectCounts = new Map<string, number>();
    for (const row of rows) {
      const tags: string[] = JSON.parse(row.tags || "[]");
      for (const tag of tags) {
        if (tag.startsWith("project:")) {
          const project = tag.slice(8);
          projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
        }
      }
    }

    return Array.from(projectCounts.entries())
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count);
  }

  getStats(project?: string): {
    totalChunks: number;
    byCategory: Record<string, number>;
    bySource: Record<string, number>;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
    avgImportance: number;
    avgAccessCount: number;
    neverAccessed: number;
  } {
    const filter = project ? this.projectFilter(project) : { where: "", params: [] };

    const total = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_chunks ${filter.where}
    `).get(...filter.params) as { count: number };

    const catRows = this.db.prepare(`
      SELECT category, COUNT(*) as count FROM memory_chunks ${filter.where} GROUP BY category
    `).all(...filter.params) as { category: string; count: number }[];

    const srcRows = this.db.prepare(`
      SELECT source, COUNT(*) as count FROM memory_chunks ${filter.where} GROUP BY source
    `).all(...filter.params) as { source: string; count: number }[];

    const dateRange = this.db.prepare(`
      SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM memory_chunks ${filter.where}
    `).get(...filter.params) as { oldest: number | null; newest: number | null };

    const avgImp = this.db.prepare(`
      SELECT AVG(importance) as avg FROM memory_chunks ${filter.where}
    `).get(...filter.params) as { avg: number | null };

    const avgAcc = this.db.prepare(`
      SELECT AVG(access_count) as avg FROM memory_chunks ${filter.where}
    `).get(...filter.params) as { avg: number | null };

    const neverAcc = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_chunks ${filter.where ? filter.where + " AND" : "WHERE"} last_accessed IS NULL
    `).get(...filter.params) as { count: number };

    const byCategory: Record<string, number> = {};
    for (const row of catRows) byCategory[row.category] = row.count;

    const bySource: Record<string, number> = {};
    for (const row of srcRows) bySource[row.source] = row.count;

    return {
      totalChunks: total.count,
      byCategory,
      bySource,
      oldestTimestamp: dateRange.oldest,
      newestTimestamp: dateRange.newest,
      avgImportance: avgImp.avg ?? 0,
      avgAccessCount: avgAcc.avg ?? 0,
      neverAccessed: neverAcc.count,
    };
  }

  getTimeline(project?: string, days: number = 30): { date: string; count: number }[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const filter = project ? this.projectFilter(project) : { where: "", params: [] };
    const timeWhere = filter.where
      ? `${filter.where} AND timestamp >= ?`
      : `WHERE timestamp >= ?`;

    const rows = this.db.prepare(`
      SELECT
        date(timestamp / 1000, 'unixepoch') as date,
        COUNT(*) as count
      FROM memory_chunks
      ${timeWhere}
      GROUP BY date
      ORDER BY date
    `).all(...filter.params, since) as { date: string; count: number }[];

    return rows;
  }

  getDecayCurve(project?: string): {
    id: string;
    importance: number;
    ageDays: number;
    accessCount: number;
    effectiveImportance: number;
    category: string;
  }[] {
    const filter = project ? this.projectFilter(project) : { where: "", params: [] };

    const rows = this.db.prepare(`
      SELECT id, importance, timestamp, last_accessed, access_count, category
      FROM memory_chunks ${filter.where}
    `).all(...filter.params) as RawChunkRow[];

    const now = Date.now();
    const halfLifeDays = 30;

    return rows.map((row) => {
      const referenceTime = row.last_accessed ?? row.timestamp;
      const ageDays = (now - referenceTime) / (1000 * 60 * 60 * 24);
      const decayFactor = Math.pow(0.5, ageDays / halfLifeDays);
      const accessBoost = Math.min(0.20, 0.05 * Math.log(1 + (row.access_count ?? 0)));
      const effectiveImportance = Math.max(0, Math.min(1, row.importance * decayFactor + accessBoost));

      return {
        id: row.id,
        importance: row.importance,
        ageDays: Math.round(ageDays * 10) / 10,
        accessCount: row.access_count ?? 0,
        effectiveImportance: Math.round(effectiveImportance * 1000) / 1000,
        category: row.category,
      };
    });
  }

  getMemories(opts: {
    project?: string;
    limit?: number;
    offset?: number;
    category?: string;
    sortBy?: string;
  }): { memories: RawChunkRow[]; total: number } {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const filter = opts.project ? this.projectFilter(opts.project) : { where: "", params: [] };

    let extraWhere = "";
    const extraParams: unknown[] = [];
    if (opts.category) {
      extraWhere = filter.where ? " AND category = ?" : "WHERE category = ?";
      extraParams.push(opts.category);
    }

    const orderBy = opts.sortBy === "importance" ? "importance DESC" :
                     opts.sortBy === "access_count" ? "access_count DESC" :
                     "timestamp DESC";

    const total = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_chunks ${filter.where} ${extraWhere}
    `).get(...filter.params, ...extraParams) as { count: number };

    const rows = this.db.prepare(`
      SELECT * FROM memory_chunks ${filter.where} ${extraWhere}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...filter.params, ...extraParams, limit, offset) as RawChunkRow[];

    return { memories: rows, total: total.count };
  }

  getTopAccessed(project?: string, limit: number = 20): RawChunkRow[] {
    const filter = project ? this.projectFilter(project) : { where: "", params: [] };

    return this.db.prepare(`
      SELECT * FROM memory_chunks
      ${filter.where ? filter.where + " AND" : "WHERE"} access_count > 0
      ORDER BY access_count DESC
      LIMIT ?
    `).all(...filter.params, limit) as RawChunkRow[];
  }

  getTelemetry(opts: {
    project?: string;
    days?: number;
    event_type?: string;
  }): TelemetryRow[] {
    const days = opts.days ?? 7;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const conditions: string[] = ["timestamp >= ?"];
    const params: unknown[] = [since];

    if (opts.project) {
      conditions.push("project = ?");
      params.push(opts.project);
    }
    if (opts.event_type) {
      conditions.push("event_type = ?");
      params.push(opts.event_type);
    }

    try {
      return this.db.prepare(`
        SELECT * FROM telemetry_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY timestamp DESC
        LIMIT 500
      `).all(...params) as TelemetryRow[];
    } catch {
      return [];
    }
  }

  getTelemetrySummary(project?: string, days: number = 7): {
    toolCalls: Record<string, { count: number; avgLatency: number; successRate: number }>;
    eventsPerDay: { date: string; count: number }[];
  } {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const conditions: string[] = ["timestamp >= ?"];
    const params: unknown[] = [since];

    if (project) {
      conditions.push("project = ?");
      params.push(project);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    try {
      const toolRows = this.db.prepare(`
        SELECT
          tool_name,
          COUNT(*) as count,
          AVG(latency_ms) as avg_latency,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
        FROM telemetry_events
        ${whereClause} AND tool_name IS NOT NULL
        GROUP BY tool_name
      `).all(...params) as { tool_name: string; count: number; avg_latency: number; successes: number }[];

      const toolCalls: Record<string, { count: number; avgLatency: number; successRate: number }> = {};
      for (const row of toolRows) {
        toolCalls[row.tool_name] = {
          count: row.count,
          avgLatency: Math.round(row.avg_latency ?? 0),
          successRate: row.count > 0 ? Math.round((row.successes / row.count) * 100) : 0,
        };
      }

      const dayRows = this.db.prepare(`
        SELECT
          date(timestamp / 1000, 'unixepoch') as date,
          COUNT(*) as count
        FROM telemetry_events
        ${whereClause}
        GROUP BY date
        ORDER BY date
      `).all(...params) as { date: string; count: number }[];

      return { toolCalls, eventsPerDay: dayRows };
    } catch {
      return { toolCalls: {}, eventsPerDay: [] };
    }
  }

  private projectFilter(project: string): { where: string; params: unknown[] } {
    return {
      where: `WHERE tags LIKE ?`,
      params: [`%"project:${project}"%`],
    };
  }
}
