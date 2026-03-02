# memory-mcp

Persistent memory MCP server for Claude Code. Store, search, and retrieve memories across sessions using hybrid vector + keyword search powered by SQLite, FTS5, and sqlite-vec.

## Features

- **Hybrid search** — 70% vector similarity + 30% BM25 keyword matching
- **Local embeddings** — Ollama (local, free) with mock fallback
- **Persistent storage** — SQLite database survives across sessions
- **Token-aware context** — Retrieve memories fitted within a token budget
- **File watching** — Auto-index markdown and code files on change
- **LRU embedding cache** — 10k entries, SHA256-keyed dedup

## Setup

```bash
git clone https://github.com/AyubMoh1/memory-mcp.git
cd memory-mcp
npm install
npm run build
```

## Register with Claude Code

Add to `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory with category, tags, and importance |
| `memory_search` | Hybrid vector + keyword search |
| `memory_list` | List recent memories with filters |
| `memory_delete` | Delete a memory by ID |
| `memory_get_context` | Token-budgeted context retrieval for a topic |
| `memory_get_stats` | Storage statistics |

## Resources

| Resource | URI | Description |
|----------|-----|-------------|
| Stats | `memory://stats` | JSON storage statistics |
| Recent | `memory://recent` | Last 20 memories |

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_PATH` | `~/.memory-mcp/memory.db` | Database file location |
| `MEMORY_WATCH_PATHS` | *(empty)* | Comma-separated file paths to auto-index |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `DEBUG` | — | Enable debug logging |

### Embedding Provider Priority

1. **Ollama** (local, free) — auto-detected if running
2. **Mock** — deterministic fallback, keyword search still works

## Architecture

```
src/
├── index.ts              # Entry point: MCP server + stdio transport
├── storage/
│   ├── types.ts          # MemoryChunk, SearchResult, StorageBackend
│   └── database.ts       # SQLite + FTS5 + sqlite-vec
├── embeddings/
│   ├── providers.ts      # Ollama, Mock
│   ├── cache.ts          # LRU embedding cache
│   └── detect.ts         # Auto-detect best provider
├── sync/
│   ├── file-watcher.ts   # chokidar with debouncing
│   └── chunker.ts        # Split files by headers/paragraphs
├── tools/                # MCP tool handlers
├── resources/            # MCP resource handlers
└── utils/                # Logger, ID gen, token estimation
```

## License

MIT
