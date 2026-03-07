import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  StorageBackend,
  MemoryCategory,
  MemorySource,
} from "../storage/types.js";
import { recordEvent } from "../telemetry/events.js";

export function registerListTools(
  server: McpServer,
  storage: StorageBackend,
) {
  server.registerTool(
    "memory_list",
    {
      title: "List Memories",
      description:
        "List stored memories, ordered by most recent first. Supports filtering by category and source.",
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results (default: 20)"),
        offset: z
          .number()
          .min(0)
          .optional()
          .describe("Skip this many results (default: 0)"),
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
        source: z
          .enum([
            "user_message",
            "assistant_message",
            "system",
            "file_content",
            "long_term_memory",
          ])
          .optional()
          .describe("Filter by source"),
      },
    },
    async (input) => {
      const start = Date.now();
      const chunks = await storage.list(input.limit ?? 20, input.offset ?? 0, {
        category: input.category as MemoryCategory | undefined,
        source: input.source as MemorySource | undefined,
      });

      recordEvent("tool_call", { tool_name: "memory_list", latency_ms: Date.now() - start, success: true, metadata: { results: chunks.length } });

      if (chunks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No memories found." }],
        };
      }

      const formatted = chunks
        .map((c) => {
          const date = new Date(c.timestamp).toISOString().slice(0, 16);
          const tags = c.tags.length ? ` [${c.tags.join(", ")}]` : "";
          return `[${c.id}] ${date} (${c.category}, importance: ${c.importance})${tags}\n${c.content}`;
        })
        .join("\n---\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    },
  );
}
