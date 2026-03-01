#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { SQLiteStorage } from "./storage/database.js";
import { detectEmbeddingProvider } from "./embeddings/detect.js";
import { LRUEmbeddingCache } from "./embeddings/cache.js";
import { registerStoreTools } from "./tools/store.js";
import { registerSearchTools } from "./tools/search.js";
import { registerListTools } from "./tools/list.js";
import { registerDeleteTools } from "./tools/delete.js";
import { registerStatsTools } from "./tools/stats.js";
import { registerContextTools } from "./tools/context.js";
import { registerStatsResource } from "./resources/stats.js";
import { registerRecentResource } from "./resources/recent.js";
import { FileWatcher } from "./sync/file-watcher.js";
import { log } from "./utils/logger.js";

async function main() {
  // Detect embedding provider first (needed for DB dimensions)
  const embeddingProvider = await detectEmbeddingProvider();
  const cache = new LRUEmbeddingCache();

  const dbPath =
    process.env.MEMORY_DB_PATH || join(homedir(), ".memory-mcp", "memory.db");
  const storage = new SQLiteStorage(dbPath, embeddingProvider.dimensions);
  await storage.initialize();

  const server = new McpServer({
    name: "memory-mcp",
    version: "1.0.0",
  });

  // Helper to get or create cached embedding
  const getEmbedding = async (text: string): Promise<Float32Array> => {
    const hash = LRUEmbeddingCache.hash(text);
    const cached = cache.get(hash);
    if (cached) return cached;

    const embedding = await embeddingProvider.generateEmbedding(text);
    cache.set(hash, embedding);
    return embedding;
  };

  // Tools
  registerStoreTools(server, storage, getEmbedding);
  registerSearchTools(server, storage, getEmbedding);
  registerListTools(server, storage);
  registerDeleteTools(server, storage);
  registerStatsTools(server, storage);
  registerContextTools(server, storage, getEmbedding);

  // Resources
  registerStatsResource(server, storage);
  registerRecentResource(server, storage);

  // File watching
  const watchPaths = process.env.MEMORY_WATCH_PATHS
    ? process.env.MEMORY_WATCH_PATHS.split(",").map((p) => p.trim()).filter(Boolean)
    : [];
  const fileWatcher = new FileWatcher(storage, getEmbedding, watchPaths);
  await fileWatcher.start();

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    await fileWatcher.stop();
    await storage.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("Server running on stdio");
}

main().catch((error) => {
  log.error("Fatal error:", error);
  process.exit(1);
});
