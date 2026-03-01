import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, MemoryCategory } from "../storage/types.js";

export function registerSearchTools(
  server: McpServer,
  storage: StorageBackend,
) {
  server.registerTool(
    "memory_search",
    {
      title: "Search Memory",
      description:
        "Search stored memories using keyword matching. Returns the most relevant results ranked by score.",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results to return (default: 10)"),
        category: z
          .enum([
            "fact",
            "preference",
            "decision",
            "code_pattern",
            "error",
            "conversation",
          ])
          .optional()
          .describe("Filter by category"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Filter by tags (matches any)"),
        min_importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum importance score"),
      },
    },
    async (input) => {
      const results = await storage.search(input.query, input.limit ?? 10, {
        category: input.category as MemoryCategory | undefined,
        tags: input.tags,
        minImportance: input.min_importance,
      });

      if (results.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No memories found matching query." },
          ],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `[${r.chunk.id}] (score: ${r.score.toFixed(2)}, ${r.chunk.category}) ${r.chunk.content}`,
        )
        .join("\n---\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    },
  );
}
