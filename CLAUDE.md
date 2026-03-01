# memory-mcp

MCP server providing persistent memory for Claude Code sessions.

## Build & Run

```bash
npm run build    # TypeScript → dist/
npm run dev      # Run with tsx (dev mode)
```

## Architecture

- `src/index.ts` — Entry point: McpServer + StdioServerTransport
- `src/storage/` — Storage backend (types + database)
- `src/tools/` — MCP tool handlers (store, search, list, delete, stats)
- `src/utils/` — Logger, ID generation, token estimation

## Rules

- **NEVER use console.log** — it corrupts the stdio MCP transport. Use `log.info()` / `log.error()` from `utils/logger.ts` (writes to stderr).
- All tool handlers are in separate files exporting a `register*` function.
- Storage implements the `StorageBackend` interface from `storage/types.ts`.
