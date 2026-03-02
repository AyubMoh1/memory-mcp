# memory-mcp

MCP server providing persistent memory for Claude Code sessions.

## Build & Run

```bash
npm run build    # TypeScript → dist/
npm run dev      # Run with tsx (dev mode)
```

## Architecture

- `src/index.ts` — Entry point: McpServer + StdioServerTransport, graceful shutdown
- `src/storage/` — SQLite + FTS5 + sqlite-vec (types + database)
- `src/embeddings/` — Ollama embedding provider (required)
- `src/sync/` — File watching with chokidar, markdown chunking
- `src/tools/` — MCP tool handlers (store, search, list, delete, stats, context)
- `src/resources/` — MCP resources (memory://stats, memory://recent)
- `src/utils/` — Logger, ID generation, token estimation

## Storage

- Database: `~/.memory-mcp/memory.db` (SQLite with WAL mode)
- Three tables: `memory_chunks` (data), `fts_chunks` (FTS5 keyword search), `vec_chunks` (vector search)
- Hybrid search: 70% vector similarity + 30% BM25 keyword

## Rules

- **NEVER use console.log** — it corrupts the stdio MCP transport. Use `log.info()` / `log.error()` from `utils/logger.ts` (writes to stderr).
- All tool handlers are in separate files exporting a `register*` function.
- Storage implements the `StorageBackend` interface from `storage/types.ts`.
- Ollama is required for embeddings. The server will fail to start without it.
