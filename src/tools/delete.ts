import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../storage/types.js";
import { log } from "../utils/logger.js";

export function registerDeleteTools(
  server: McpServer,
  storage: StorageBackend,
) {
  server.registerTool(
    "memory_delete",
    {
      title: "Delete Memory",
      description: "Delete a memory by its ID.",
      inputSchema: {
        id: z.string().describe("The memory ID to delete (e.g. mem_1234567890_abcd1234)"),
      },
    },
    async (input) => {
      const deleted = await storage.deleteChunk(input.id);

      if (!deleted) {
        return {
          content: [
            { type: "text" as const, text: `Memory ${input.id} not found.` },
          ],
        };
      }

      log.debug("Deleted memory:", input.id);

      return {
        content: [
          { type: "text" as const, text: `Deleted memory ${input.id}.` },
        ],
      };
    },
  );
}
