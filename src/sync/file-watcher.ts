import { watch, type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { StorageBackend, MemorySource, MemoryCategory } from "../storage/types.js";
import { chunkContent, classifyFile } from "./chunker.js";
import { generateId } from "../utils/id.js";
import { log } from "../utils/logger.js";

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private syncQueue: Set<string> = new Set();
  private syncTimer: NodeJS.Timeout | null = null;
  // Track which chunk IDs came from which file so we can replace on re-sync
  private fileChunkIds: Map<string, string[]> = new Map();

  constructor(
    private storage: StorageBackend,
    private getEmbedding: ((text: string) => Promise<Float32Array>) | null,
    private watchPaths: string[],
    private debounceMs: number = 2000,
  ) {}

  async start(): Promise<void> {
    if (this.watchPaths.length === 0) {
      log.info("No watch paths configured, file sync disabled");
      return;
    }

    log.info(`Watching ${this.watchPaths.length} path(s) for changes`);

    // Initial sync
    for (const path of this.watchPaths) {
      await this.syncFile(path).catch((err) =>
        log.error(`Initial sync failed for ${path}:`, err),
      );
    }

    // Watch for changes
    this.watcher = watch(this.watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });

    this.watcher.on("change", (path) => this.queueSync(path));
    this.watcher.on("add", (path) => this.queueSync(path));

    this.watcher.on("error", (err) => log.error("Watcher error:", err));
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    await this.watcher?.close();
    this.watcher = null;
  }

  private queueSync(filePath: string): void {
    this.syncQueue.add(filePath);

    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.processSyncQueue(), this.debounceMs);
  }

  private async processSyncQueue(): Promise<void> {
    const paths = Array.from(this.syncQueue);
    this.syncQueue.clear();

    for (const path of paths) {
      try {
        await this.syncFile(path);
      } catch (err) {
        log.error(`Sync failed for ${path}:`, err);
      }
    }
  }

  private async syncFile(filePath: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      log.debug(`File not readable: ${filePath}`);
      return;
    }

    if (content.trim().length === 0) return;

    // Delete previous chunks from this file
    const previousIds = this.fileChunkIds.get(filePath) || [];
    for (const id of previousIds) {
      await this.storage.deleteChunk(id);
    }

    // Chunk and index
    const chunks = chunkContent(content);
    const { source, category } = classifyFile(filePath);
    const newIds: string[] = [];

    for (const chunkText of chunks) {
      const id = generateId();
      let embedding: Float32Array | undefined;

      if (this.getEmbedding) {
        try {
          embedding = await this.getEmbedding(chunkText);
        } catch (err) {
          log.debug(`Embedding failed for chunk, skipping vector:`, err);
        }
      }

      await this.storage.addChunk(
        {
          id,
          content: chunkText,
          source: source as MemorySource,
          category: category as MemoryCategory,
          tags: ["file-sync", basename(filePath)],
          importance: 0.3,
          timestamp: Date.now(),
        },
        embedding,
      );

      newIds.push(id);
    }

    this.fileChunkIds.set(filePath, newIds);
    log.info(`Synced ${filePath}: ${chunks.length} chunks indexed`);
  }
}
