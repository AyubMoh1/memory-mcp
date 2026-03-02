import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, MemoryCategory } from "../storage/types.js";
import { estimateTokens } from "../utils/tokens.js";
import { log } from "../utils/logger.js";

export function registerContextTools(
  server: McpServer,
  storage: StorageBackend,
  getEmbedding: (text: string) => Promise<Float32Array>,
) {
  server.registerTool(
    "memory_get_context",
    {
      title: "Get Context",
      description:
        "Retrieve relevant memories for a topic, fitted within a token budget. Use this to load context at the start of a session or when diving into a specific topic.",
      inputSchema: {
        topic: z
          .string()
          .describe("Topic or question to find relevant context for"),
        token_budget: z
          .number()
          .min(100)
          .max(50000)
          .optional()
          .describe("Max tokens to return (default: 4000)"),
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
      },
    },
    async (input) => {
      const budget = input.token_budget ?? 4000;

      let queryEmbedding: Float32Array | undefined;
      try {
        queryEmbedding = await getEmbedding(input.topic);
      } catch (err) {
        log.error("Failed to embed topic query:", err);
      }

      const results = await storage.search(
        input.topic,
        50,
        {
          category: input.category as MemoryCategory | undefined,
        },
        queryEmbedding,
      );

      // Pack results into token budget
      let tokenCount = 0;
      const fitted: string[] = [];

      for (const result of results) {
        const effImp = result.effectiveImportance ?? result.chunk.importance;
        const entry = `[${result.chunk.category}] (score: ${result.score.toFixed(2)}, importance: ${effImp.toFixed(2)}) ${result.chunk.content}`;
        const tokens = estimateTokens(entry);

        if (tokenCount + tokens > budget) break;
        tokenCount += tokens;
        fitted.push(entry);
      }

      if (fitted.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant memories found for this topic.",
            },
          ],
        };
      }

      const header = `Found ${fitted.length} relevant memories (~${tokenCount} tokens):`;
      const body = fitted.join("\n---\n");

      return {
        content: [
          { type: "text" as const, text: `${header}\n\n${body}` },
        ],
      };
    },
  );
}
