#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { SQLiteStorage } from "./storage/database.js";
import { registerStoreTools } from "./tools/store.js";
import { registerSearchTools } from "./tools/search.js";
import { registerListTools } from "./tools/list.js";
import { registerDeleteTools } from "./tools/delete.js";
import { registerStatsTools } from "./tools/stats.js";
import { log } from "./utils/logger.js";

const dbPath =
  process.env.MEMORY_DB_PATH || join(homedir(), ".memory-mcp", "memory.db");
const storage = new SQLiteStorage(dbPath);

const server = new McpServer({
  name: "memory-mcp",
  version: "0.1.0",
});

registerStoreTools(server, storage);
registerSearchTools(server, storage);
registerListTools(server, storage);
registerDeleteTools(server, storage);
registerStatsTools(server, storage);

async function main() {
  await storage.initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("Server running on stdio");
}

main().catch((error) => {
  log.error("Fatal error:", error);
  process.exit(1);
});
