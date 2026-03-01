# memory-mcp

Persistent memory MCP server for Claude Code. Store, search, and retrieve memories across sessions using hybrid vector + keyword search.

## Setup

```bash
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
| `memory_search` | Search memories (hybrid vector + keyword) |
| `memory_list` | List recent memories with filters |
| `memory_delete` | Delete a memory by ID |
| `memory_get_stats` | Get storage statistics |

## License

MIT
