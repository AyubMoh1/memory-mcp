#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { SQLiteStorage } from "../storage/database.js";
import { estimateTokens } from "../utils/tokens.js";
import { log } from "../utils/logger.js";
import type { MemoryChunk } from "../storage/types.js";

const TOKEN_BUDGET = 4000;

// Priority tiers for memory selection
const CATEGORY_PRIORITY: Record<string, number> = {
  decision: 4,
  error: 4,
  preference: 3,
  fact: 3,
  code_pattern: 2,
  conversation: 0,
};

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

interface ScoredMemory {
  chunk: MemoryChunk;
  effectiveImportance: number;
  isExtracted: boolean;
  isSummary: boolean;
  categoryPriority: number;
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

    // Score and classify each memory
    const scored: ScoredMemory[] = memories.map((chunk) => ({
      chunk,
      effectiveImportance: storage.computeEffectiveImportance(
        chunk.importance,
        chunk.lastAccessed ?? null,
        chunk.accessCount ?? 0,
        chunk.timestamp,
        chunk.category,
      ),
      isExtracted: chunk.tags.includes("extracted"),
      isSummary: chunk.tags.includes("summary"),
      categoryPriority: CATEGORY_PRIORITY[chunk.category] ?? 0,
    }));

    // Sort by: extracted knowledge first, then summaries, then by
    // category priority, then by effective importance
    scored.sort((a, b) => {
      // Extracted knowledge items first
      if (a.isExtracted !== b.isExtracted) return a.isExtracted ? -1 : 1;
      // Summaries next
      if (a.isSummary !== b.isSummary) return a.isSummary ? -1 : 1;
      // Then by category priority
      if (a.categoryPriority !== b.categoryPriority) return b.categoryPriority - a.categoryPriority;
      // Then by effective importance
      return b.effectiveImportance - a.effectiveImportance;
    });

    // Deduplicate: limit raw messages per session to max 2
    const sessionRawCount = new Map<string, number>();
    const MAX_RAW_PER_SESSION = 2;

    const selected: ScoredMemory[] = [];
    let totalTokens = estimateTokens("=== Project Memory ===\n\n");

    for (const entry of scored) {
      // For raw conversation messages, limit per session
      if (!entry.isExtracted && !entry.isSummary && entry.chunk.category === "conversation") {
        const sessionId = entry.chunk.tags.find((t) =>
          !t.startsWith("project:") && !t.startsWith("auto-") && t !== "raw" && t !== "summary" && t !== "extracted"
        );
        if (sessionId) {
          const count = sessionRawCount.get(sessionId) ?? 0;
          if (count >= MAX_RAW_PER_SESSION) continue;
          sessionRawCount.set(sessionId, count + 1);
        }
      }

      // Skip low-importance conversation memories to make room for knowledge
      if (entry.chunk.category === "conversation" && !entry.isSummary && entry.effectiveImportance < 0.25) {
        continue;
      }

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

function formatMemory(chunk: MemoryChunk, effectiveImportance: number): string {
  const tag = chunk.tags.includes("extracted") ? chunk.category :
    chunk.tags.includes("summary") ? "summary" : chunk.category;
  return `[${tag}] (importance: ${effectiveImportance.toFixed(2)}) ${chunk.content}`;
}

main().catch((err) => {
  log.error("Session-start hook failed:", err);
  outputEmpty();
  process.exit(0);
});
