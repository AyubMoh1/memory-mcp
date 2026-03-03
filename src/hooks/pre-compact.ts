#!/usr/bin/env node

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
const STATE_FILE = join(STATE_DIR, "compact-state.json");
const MAX_RAW_MESSAGES = 20;

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

function readState(): Record<string, string> {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // Corrupted state file, start fresh
  }
  return {};
}

function writeState(state: Record<string, string>): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function main() {
  // Read hook input from stdin
  let inputData: string;
  try {
    inputData = readFileSync(0, "utf-8");
  } catch {
    log.error("Failed to read stdin");
    process.exit(0);
  }

  let input: HookInput;
  try {
    input = JSON.parse(inputData);
  } catch {
    log.error("Failed to parse stdin JSON");
    process.exit(0);
  }

  if (!input.transcript_path) {
    log.error("No transcript_path in hook input");
    process.exit(0);
  }

  const projectPath = getProjectPath();
  const projectTag = `project:${projectPath}`;

  // Parse transcript
  let messages;
  try {
    messages = parseTranscript(input.transcript_path);
  } catch (err) {
    log.error("Failed to parse transcript:", err);
    process.exit(0);
  }

  if (messages.length === 0) {
    log.info("No messages in transcript, skipping");
    process.exit(0);
  }

  // Deduplication check
  const stateHash = createHash("sha256")
    .update(`${input.session_id}:${messages.length}`)
    .digest("hex")
    .slice(0, 16);

  const state = readState();
  if (state[input.session_id] === stateHash) {
    log.info("Already processed this state, skipping");
    process.exit(0);
  }

  // Initialize storage and embeddings
  const dbPath =
    process.env.MEMORY_DB_PATH || join(homedir(), ".memory-mcp", "memory.db");

  let embeddingProvider;
  try {
    embeddingProvider = await detectEmbeddingProvider();
  } catch (err) {
    log.error("Ollama not available, saving without embeddings:", err);
  }

  const storage = new SQLiteStorage(
    dbPath,
    embeddingProvider?.dimensions ?? 768,
  );
  await storage.initialize();

  const chunksToStore: { chunk: MemoryChunk; embedding?: Float32Array }[] = [];

  // Generate summary
  try {
    const summary = await summarizeConversation(messages);
    if (summary) {
      const chunk: MemoryChunk = {
        id: generateId(),
        content: `[Session Summary] ${summary}`,
        source: "system",
        category: "conversation",
        tags: ["auto-compact", "summary", input.session_id, projectTag],
        importance: 0.8,
        timestamp: Date.now(),
      };

      let embedding: Float32Array | undefined;
      if (embeddingProvider) {
        try {
          embedding = await embeddingProvider.generateEmbedding(chunk.content);
        } catch (err) {
          log.error("Failed to embed summary:", err);
        }
      }

      chunksToStore.push({ chunk, embedding });
      log.info(`Summary generated (${summary.length} chars)`);
    }
  } catch (err) {
    log.error("Failed to generate summary:", err);
  }

  // Store recent raw messages
  const recentMessages = messages.slice(-MAX_RAW_MESSAGES);
  for (const msg of recentMessages) {
    const chunk: MemoryChunk = {
      id: generateId(),
      content: `[${msg.role}] ${msg.content}`,
      source: msg.role === "user" ? "user_message" : "assistant_message",
      category: "conversation",
      tags: ["auto-compact", "raw", input.session_id, projectTag],
      importance: 0.5,
      timestamp: Date.now(),
    };

    let embedding: Float32Array | undefined;
    if (embeddingProvider) {
      try {
        embedding = await embeddingProvider.generateEmbedding(chunk.content);
      } catch (err) {
        log.error("Failed to embed message:", err);
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
      log.error(`Failed to store chunk ${chunk.id}:`, err);
    }
  }

  log.info(`Stored ${stored} memories (1 summary + ${stored - 1} raw messages)`);

  // Update dedup state
  state[input.session_id] = stateHash;
  writeState(state);

  await storage.close();
}

main().catch((err) => {
  log.error("Pre-compact hook failed:", err);
  process.exit(0); // Always exit 0 — don't block compaction
});
