import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../storage/types.js";

export function registerStatsResource(
  server: McpServer,
  storage: StorageBackend,
) {
  server.registerResource(
    "memory-stats",
    "memory://stats",
    {
      title: "Memory Statistics",
      description: "Current memory storage statistics including counts by category and source",
      mimeType: "application/json",
    },
    async (uri) => {
      const stats = await storage.getStats();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(stats, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
