import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, MemoryCategory, MemorySource } from "../storage/types.js";
import { generateId } from "../utils/id.js";
import { log } from "../utils/logger.js";

export function registerStoreTools(
  server: McpServer,
  storage: StorageBackend,
) {
  server.registerTool(
    "memory_store",
    {
      title: "Store Memory",
      description:
        "Store a piece of information in persistent memory. Use this to remember facts, decisions, code patterns, user preferences, or anything worth recalling in future sessions.",
      inputSchema: {
        content: z.string().describe("The content to remember"),
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
          .describe("Category of the memory (default: fact)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for filtering (e.g. ['auth', 'api'])"),
        importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Importance score 0-1 (default: 0.5)"),
        source: z
          .enum([
            "user_message",
            "assistant_message",
            "system",
            "file_content",
            "long_term_memory",
          ])
          .optional()
          .describe("Source of the memory (default: system)"),
      },
    },
    async (input) => {
      const chunk = await storage.addChunk({
        id: generateId(),
        content: input.content,
        source: (input.source ?? "system") as MemorySource,
        category: (input.category ?? "fact") as MemoryCategory,
        tags: input.tags ?? [],
        importance: input.importance ?? 0.5,
        timestamp: Date.now(),
      });

      log.debug("Stored memory:", chunk.id);

      return {
        content: [
          {
            type: "text" as const,
            text: `Stored memory ${chunk.id} [${chunk.category}]`,
          },
        ],
      };
    },
  );
}
