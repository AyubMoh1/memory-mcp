#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { SQLiteStorage } from "../storage/database.js";
import { estimateTokens } from "../utils/tokens.js";
import { log } from "../utils/logger.js";

const TOKEN_BUDGET = 4000;

function getProjectPath(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function outputEmpty(): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "",
    },
  }));
}

async function main() {
  const projectPath = getProjectPath();
  const projectTag = `project:${projectPath}`;

  const dbPath =
    process.env.MEMORY_DB_PATH || join(homedir(), ".memory-mcp", "memory.db");

  if (!existsSync(dbPath)) {
    outputEmpty();
    return;
  }

  const storage = new SQLiteStorage(dbPath, 768);
  await storage.initialize();

  try {
    const memories = await storage.list(200, 0, { tags: [projectTag] });

    if (memories.length === 0) {
      outputEmpty();
      return;
    }

    // Compute effective importance for each memory
    const scored = memories.map((chunk) => ({
      chunk,
      effectiveImportance: storage.computeEffectiveImportance(
        chunk.importance,
        chunk.lastAccessed ?? null,
        chunk.accessCount ?? 0,
        chunk.timestamp,
      ),
      isSummary: chunk.tags.includes("summary"),
    }));

    // Sort: summaries first, then by effective importance descending
    scored.sort((a, b) => {
      if (a.isSummary !== b.isSummary) return a.isSummary ? -1 : 1;
      return b.effectiveImportance - a.effectiveImportance;
    });

    // Fit within token budget
    const selected: typeof scored = [];
    let totalTokens = 0;
    const headerTokens = estimateTokens("=== Project Memory ===\n\n");

    totalTokens += headerTokens;
    for (const entry of scored) {
      const line = formatMemory(entry.chunk, entry.effectiveImportance);
      const lineTokens = estimateTokens(line + "\n---\n");
      if (totalTokens + lineTokens > TOKEN_BUDGET) break;
      selected.push(entry);
      totalTokens += lineTokens;
    }

    if (selected.length === 0) {
      outputEmpty();
      return;
    }

    const lines = selected.map((e) =>
      formatMemory(e.chunk, e.effectiveImportance),
    );

    const context = [
      `=== Project Memory ===`,
      `${selected.length} memories from previous sessions (~${totalTokens} tokens). Use memory_search for more.`,
      ``,
      lines.join("\n---\n"),
    ].join("\n");

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    }));
  } finally {
    await storage.close();
  }
}

function formatMemory(chunk: { content: string; category: string; tags: string[] }, effectiveImportance: number): string {
  const category = chunk.tags.includes("summary") ? "summary" : chunk.category;
  return `[${category}] (importance: ${effectiveImportance.toFixed(2)}) ${chunk.content}`;
}

main().catch((err) => {
  log.error("Session-start hook failed:", err);
  outputEmpty();
  process.exit(0);
});
