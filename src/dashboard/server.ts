#!/usr/bin/env node

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DashboardDB } from "./db.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const part of url.slice(idx + 1).split("&")) {
    const [k, v] = part.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return params;
}

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function main() {
  const dbPath = process.env.MEMORY_DB_PATH || join(homedir(), ".memory-mcp", "memory.db");

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    console.error("Start the memory-mcp server first to create the database.");
    process.exit(1);
  }

  const db = new DashboardDB(dbPath);
  const port = Number(process.env.DASHBOARD_PORT) || 3847;

  const server = createServer((req, res) => {
    const url = req.url || "/";
    const path = url.split("?")[0];
    const query = parseQuery(url);

    // API routes
    if (path.startsWith("/api/")) {
      try {
        handleApi(db, path, query, res);
      } catch (err) {
        console.error("API error:", err);
        json(res, { error: "Internal server error" }, 500);
      }
      return;
    }

    // Static files
    serveStatic(path, res);
  });

  server.listen(port, () => {
    console.log(`Memory MCP Dashboard running at http://localhost:${port}`);
  });

  process.on("SIGINT", () => {
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    db.close();
    process.exit(0);
  });
}

function handleApi(
  db: DashboardDB,
  path: string,
  query: Record<string, string>,
  res: import("node:http").ServerResponse,
): void {
  const project = query.project || undefined;

  switch (path) {
    case "/api/projects":
      json(res, db.getProjects());
      break;

    case "/api/stats":
      json(res, db.getStats(project));
      break;

    case "/api/timeline":
      json(res, db.getTimeline(project, Number(query.days) || 30));
      break;

    case "/api/decay":
      json(res, db.getDecayCurve(project));
      break;

    case "/api/categories":
      json(res, db.getStats(project));
      break;

    case "/api/memories": {
      json(res, db.getMemories({
        project,
        limit: Number(query.limit) || 50,
        offset: Number(query.offset) || 0,
        category: query.category || undefined,
        sortBy: query.sort || undefined,
      }));
      break;
    }

    case "/api/top-accessed":
      json(res, db.getTopAccessed(project, Number(query.limit) || 20));
      break;

    case "/api/telemetry":
      json(res, db.getTelemetry({
        project,
        days: Number(query.days) || 7,
        event_type: query.event_type || undefined,
      }));
      break;

    case "/api/telemetry/summary":
      json(res, db.getTelemetrySummary(project, Number(query.days) || 7));
      break;

    default:
      json(res, { error: "Not found" }, 404);
  }
}

function serveStatic(path: string, res: import("node:http").ServerResponse): void {
  if (path === "/") path = "/index.html";

  const filePath = join(PUBLIC_DIR, path);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    // Serve index.html for SPA routing
    try {
      const index = readFileSync(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(index);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }
}

main();
