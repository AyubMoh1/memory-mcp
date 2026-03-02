import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../storage/types.js";

export function registerStatsTools(
  server: McpServer,
  storage: StorageBackend,
) {
  server.registerTool(
    "memory_get_stats",
    {
      title: "Memory Stats",
      description:
        "Get statistics about stored memories: total count, breakdown by category and source, date range.",
      inputSchema: {},
    },
    async () => {
      const stats = await storage.getStats();

      const lines: string[] = [
        `Total memories: ${stats.totalChunks}`,
        "",
        "By category:",
        ...Object.entries(stats.byCategory).map(
          ([k, v]) => `  ${k}: ${v}`,
        ),
        "",
        "By source:",
        ...Object.entries(stats.bySource).map(
          ([k, v]) => `  ${k}: ${v}`,
        ),
      ];

      if (stats.oldestTimestamp) {
        lines.push(
          "",
          `Oldest: ${new Date(stats.oldestTimestamp).toISOString().slice(0, 16)}`,
          `Newest: ${new Date(stats.newestTimestamp!).toISOString().slice(0, 16)}`,
        );
      }

      if (stats.decayStats) {
        lines.push(
          "",
          "Decay:",
          `  Never accessed: ${stats.decayStats.neverAccessed}`,
          `  Avg access count: ${stats.decayStats.avgAccessCount.toFixed(1)}`,
          `  Below prune threshold: ${stats.decayStats.belowPruneThreshold}`,
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
