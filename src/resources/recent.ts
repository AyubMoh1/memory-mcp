import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../storage/types.js";

export function registerRecentResource(
  server: McpServer,
  storage: StorageBackend,
) {
  server.registerResource(
    "recent-memories",
    "memory://recent",
    {
      title: "Recent Memories",
      description: "The 20 most recently stored memories",
      mimeType: "text/plain",
    },
    async (uri) => {
      const recent = await storage.list(20, 0);

      const text =
        recent.length === 0
          ? "No memories stored yet."
          : recent
              .map((m) => {
                const date = new Date(m.timestamp)
                  .toISOString()
                  .slice(0, 16);
                const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
                return `[${m.id}] ${date} (${m.category}, importance: ${m.importance})${tags}\n${m.content}`;
              })
              .join("\n---\n");

      return {
        contents: [
          {
            uri: uri.href,
            text,
            mimeType: "text/plain",
          },
        ],
      };
    },
  );
}
