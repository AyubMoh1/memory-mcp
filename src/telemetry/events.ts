import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../utils/logger.js";

export interface TelemetryEvent {
  id?: number;
  event_type: string;
  tool_name?: string;
  project?: string;
  latency_ms?: number;
  success?: boolean;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

let instance: TelemetryRecorder | null = null;

export function initTelemetry(dbPath: string): TelemetryRecorder {
  instance = new TelemetryRecorder(dbPath);
  return instance;
}

export function recordEvent(
  event_type: string,
  opts?: {
    tool_name?: string;
    project?: string;
    latency_ms?: number;
    success?: boolean;
    metadata?: Record<string, unknown>;
  },
): void {
  instance?.record({
    event_type,
    timestamp: Date.now(),
    ...opts,
  });
}

export class TelemetryRecorder {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        project TEXT,
        latency_ms INTEGER,
        success INTEGER,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_telemetry_project ON telemetry_events(project);
      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_events(timestamp);
    `);

    log.info("Telemetry recorder initialized");
  }

  record(event: TelemetryEvent): void {
    try {
      this.db.prepare(`
        INSERT INTO telemetry_events (event_type, tool_name, project, latency_ms, success, metadata, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.event_type,
        event.tool_name ?? null,
        event.project ?? null,
        event.latency_ms ?? null,
        event.success === undefined ? null : event.success ? 1 : 0,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.timestamp,
      );
    } catch (err) {
      log.error("Failed to record telemetry event:", err);
    }
  }

  close(): void {
    this.db.close();
  }
}
