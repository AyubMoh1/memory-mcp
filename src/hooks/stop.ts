#!/usr/bin/env node

/**
 * Stop hook — captures memories when ANY session ends.
 * Skips if pre-compact already processed this session.
 * For short sessions (< 4 messages), saves raw messages only (no summarization).
 * For longer sessions, generates a summary via Ollama.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { parseTranscript } from "./transcript.js";
import { summarizeConversation } from "./summarizer.js";
import { SQLiteStorage } from "../storage/database.js";
import { detectEmbeddingProvider } from "../embeddings/detect.js";
import { generateId } from "../utils/id.js";
import { log } from "../utils/logger.js";
import type { MemoryChunk } from "../storage/types.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
}

const STATE_DIR = join(homedir(), ".memory-mcp");
const STOP_STATE_FILE = join(STATE_DIR, "stop-state.json");
const COMPACT_STATE_FILE = join(STATE_DIR, "compact-state.json");
const MAX_RAW_MESSAGES = 15;
const MIN_MESSAGES = 2;

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

function readState(file: string): Record<string, string> {
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch {
    // Corrupted state file, start fresh
  }
  return {};
}

function writeState(file: string, state: Record<string, string>): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

async function main() {
  // Read hook input from stdin
  let inputData: string;
  try {
    inputData = readFileSync(0, "utf-8");
  } catch {
    log.error("Stop hook: failed to read stdin");
    process.exit(0);
  }

  let input: HookInput;
  try {
    input = JSON.parse(inputData);
  } catch {
    log.error("Stop hook: failed to parse stdin JSON");
    process.exit(0);
  }

  if (!input.transcript_path) {
    log.error("Stop hook: no transcript_path");
    process.exit(0);
  }

  // Check if pre-compact already processed this session
  const compactState = readState(COMPACT_STATE_FILE);
  if (compactState[input.session_id]) {
    log.info("Stop hook: pre-compact already captured this session, skipping");
    process.exit(0);
  }

  const projectPath = getProjectPath();
  const projectTag = `project:${projectPath}`;

  // Parse transcript
  let messages;
  try {
    messages = parseTranscript(input.transcript_path);
  } catch (err) {
    log.error("Stop hook: failed to parse transcript:", err);
    process.exit(0);
  }

  if (messages.length < MIN_MESSAGES) {
    log.info(`Stop hook: only ${messages.length} message(s), skipping`);
    process.exit(0);
  }

  // Dedup: don't re-process the same session state
  const stateHash = createHash("sha256")
    .update(`stop:${input.session_id}:${messages.length}`)
    .digest("hex")
    .slice(0, 16);

  const stopState = readState(STOP_STATE_FILE);
  if (stopState[input.session_id] === stateHash) {
    log.info("Stop hook: already processed this state, skipping");
    process.exit(0);
  }

  // Initialize storage and embeddings
  const dbPath =
    process.env.MEMORY_DB_PATH || join(homedir(), ".memory-mcp", "memory.db");

  let embeddingProvider;
  try {
    embeddingProvider = await detectEmbeddingProvider();
  } catch (err) {
    log.error("Stop hook: Ollama not available, saving without embeddings:", err);
  }

  const storage = new SQLiteStorage(
    dbPath,
    embeddingProvider?.dimensions ?? 768,
  );
  await storage.initialize();

  const chunksToStore: { chunk: MemoryChunk; embedding?: Float32Array }[] = [];

  // For sessions with enough messages, generate a summary
  if (messages.length >= 4) {
    try {
      const summary = await summarizeConversation(messages);
      if (summary) {
        const chunk: MemoryChunk = {
          id: generateId(),
          content: `[Session Summary] ${summary}`,
          source: "system",
          category: "conversation",
          tags: ["auto-stop", "summary", input.session_id, projectTag],
          importance: 0.7,
          timestamp: Date.now(),
        };

        let embedding: Float32Array | undefined;
        if (embeddingProvider) {
          try {
            embedding = await embeddingProvider.generateEmbedding(chunk.content);
          } catch (err) {
            log.error("Stop hook: failed to embed summary:", err);
          }
        }

        chunksToStore.push({ chunk, embedding });
        log.info(`Stop hook: summary generated (${summary.length} chars)`);
      }
    } catch (err) {
      log.error("Stop hook: summarization failed:", err);
    }
  }

  // Store recent raw messages
  const recentMessages = messages.slice(-MAX_RAW_MESSAGES);
  for (const msg of recentMessages) {
    const chunk: MemoryChunk = {
      id: generateId(),
      content: `[${msg.role}] ${msg.content}`,
      source: msg.role === "user" ? "user_message" : "assistant_message",
      category: "conversation",
      tags: ["auto-stop", "raw", input.session_id, projectTag],
      importance: 0.4,
      timestamp: Date.now(),
    };

    let embedding: Float32Array | undefined;
    if (embeddingProvider) {
      try {
        embedding = await embeddingProvider.generateEmbedding(chunk.content);
      } catch (err) {
        log.error("Stop hook: failed to embed message:", err);
      }
    }

    chunksToStore.push({ chunk, embedding });
  }

  // Store all chunks
  let stored = 0;
  for (const { chunk, embedding } of chunksToStore) {
    try {
      await storage.addChunk(chunk, embedding);
      stored++;
    } catch (err) {
      log.error(`Stop hook: failed to store chunk ${chunk.id}:`, err);
    }
  }

  log.info(`Stop hook: stored ${stored} memories for ${projectPath}`);

  // Update dedup state (keep last 100 sessions to avoid unbounded growth)
  stopState[input.session_id] = stateHash;
  const entries = Object.entries(stopState);
  if (entries.length > 100) {
    const trimmed = Object.fromEntries(entries.slice(-100));
    writeState(STOP_STATE_FILE, trimmed);
  } else {
    writeState(STOP_STATE_FILE, stopState);
  }

  await storage.close();
}

main().catch((err) => {
  log.error("Stop hook failed:", err);
  process.exit(0); // Always exit 0 — don't block shutdown
});
