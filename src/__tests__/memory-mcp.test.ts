import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { SQLiteStorage } from "../storage/database.js";
import type { MemoryChunk } from "../storage/types.js";
import type { EmbeddingProvider } from "../embeddings/providers.js";
import { LRUEmbeddingCache } from "../embeddings/cache.js";

// Test-only embedding provider (not used in production)
class TestEmbeddingProvider implements EmbeddingProvider {
  name = "test";
  dimensions = 128;

  async generateEmbedding(text: string): Promise<Float32Array> {
    const embedding = new Float32Array(this.dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < this.dimensions; i++) {
      embedding[i] = Math.sin(hash + i * 0.1) * 0.5;
    }
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += embedding[i] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dimensions; i++) embedding[i] /= norm;
    return embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.generateEmbedding(t)));
  }
}
import { chunkContent, classifyFile } from "../sync/chunker.js";
import { FileWatcher } from "../sync/file-watcher.js";
import { estimateTokens } from "../utils/tokens.js";
import { generateId } from "../utils/id.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "memory-mcp-test-"));
}

function makeChunk(overrides: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: generateId(),
    content: "Test content for memory chunk",
    source: "system",
    category: "fact",
    tags: [],
    importance: 0.5,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Utils ──────────────────────────────────────────────────────────────────

describe("generateId", () => {
  it("returns a string starting with mem_", () => {
    const id = generateId();
    assert.match(id, /^mem_\d+_[a-f0-9]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    assert.equal(ids.size, 100);
  });
});

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 characters", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("a".repeat(100)), 25);
  });
});

// ─── LRU Embedding Cache ────────────────────────────────────────────────────

describe("LRUEmbeddingCache", () => {
  it("hashes content deterministically with SHA256", () => {
    const h1 = LRUEmbeddingCache.hash("hello");
    const h2 = LRUEmbeddingCache.hash("hello");
    const h3 = LRUEmbeddingCache.hash("world");
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.equal(h1.length, 64); // SHA256 hex
  });

  it("stores and retrieves embeddings", () => {
    const cache = new LRUEmbeddingCache(100);
    const embedding = new Float32Array([1, 2, 3]);
    const hash = LRUEmbeddingCache.hash("test");

    assert.equal(cache.get(hash), null);
    cache.set(hash, embedding);
    assert.deepEqual(cache.get(hash), embedding);
    assert.equal(cache.size, 1);
  });

  it("evicts oldest entry when at capacity", () => {
    const cache = new LRUEmbeddingCache(2);
    const e1 = new Float32Array([1]);
    const e2 = new Float32Array([2]);
    const e3 = new Float32Array([3]);

    cache.set("a", e1);
    cache.set("b", e2);
    assert.equal(cache.size, 2);

    cache.set("c", e3); // should evict "a"
    assert.equal(cache.size, 2);
    assert.equal(cache.get("a"), null);
    assert.deepEqual(cache.get("b"), e2);
    assert.deepEqual(cache.get("c"), e3);
  });

  it("updates lastAccess on get (LRU behavior)", async () => {
    const cache = new LRUEmbeddingCache(2);
    cache.set("a", new Float32Array([1]));
    await sleep(5); // Ensure different timestamp
    cache.set("b", new Float32Array([2]));
    await sleep(5);

    // Access "a" to make it recently used
    cache.get("a");
    await sleep(5);

    // Add "c" — should evict "b" (least recently used), not "a"
    cache.set("c", new Float32Array([3]));
    assert.notEqual(cache.get("a"), null);
    assert.equal(cache.get("b"), null);
  });

  it("clears all entries", () => {
    const cache = new LRUEmbeddingCache(100);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    assert.equal(cache.size, 2);
    cache.clear();
    assert.equal(cache.size, 0);
  });
});

// ─── Mock Embedding Provider ────────────────────────────────────────────────

describe("TestEmbeddingProvider", () => {
  const provider = new TestEmbeddingProvider();

  it("has correct dimensions", () => {
    assert.equal(provider.dimensions, 128);
    assert.equal(provider.name, "mock");
  });

  it("generates embedding of correct length", async () => {
    const embedding = await provider.generateEmbedding("hello world");
    assert.equal(embedding.length, 128);
  });

  it("generates deterministic embeddings", async () => {
    const e1 = await provider.generateEmbedding("test text");
    const e2 = await provider.generateEmbedding("test text");
    assert.deepEqual(e1, e2);
  });

  it("generates different embeddings for different text", async () => {
    const e1 = await provider.generateEmbedding("hello");
    const e2 = await provider.generateEmbedding("world");
    assert.notDeepEqual(e1, e2);
  });

  it("generates normalized embeddings (unit length)", async () => {
    const embedding = await provider.generateEmbedding("normalize me");
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) norm += embedding[i] ** 2;
    assert.ok(Math.abs(Math.sqrt(norm) - 1.0) < 0.01);
  });

  it("batch generates embeddings", async () => {
    const results = await provider.generateEmbeddings(["a", "b", "c"]);
    assert.equal(results.length, 3);
    assert.equal(results[0].length, 128);
  });
});

// ─── Chunker ────────────────────────────────────────────────────────────────

describe("chunkContent", () => {
  it("splits by markdown headers", () => {
    const content = `## Section One
Some content here.

## Section Two
More content here.

## Section Three
Final content.`;

    const chunks = chunkContent(content);
    assert.equal(chunks.length, 3);
    assert.ok(chunks[0].startsWith("## Section One"));
    assert.ok(chunks[1].startsWith("## Section Two"));
    assert.ok(chunks[2].startsWith("## Section Three"));
  });

  it("filters out tiny chunks", () => {
    const content = `## A
tiny

## Real Section
This is a proper section with enough content to pass the minimum threshold.`;

    const chunks = chunkContent(content, 2000, 20);
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((c) => c.length >= 20));
  });

  it("splits large sections by paragraphs", () => {
    const largeParagraph = "A".repeat(500);
    const content = `## Big Section
${largeParagraph}

${largeParagraph}

${largeParagraph}

${largeParagraph}

${largeParagraph}`;

    const chunks = chunkContent(content, 1200, 20);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 1200));
  });

  it("falls back to paragraph splitting when no headers", () => {
    const content = `First paragraph with some content here that is long enough.

Second paragraph with more content and details about things.

Third paragraph wrapping up the content in this section.`;

    const chunks = chunkContent(content, 2000, 20);
    assert.ok(chunks.length >= 1);
  });

  it("handles empty content", () => {
    assert.deepEqual(chunkContent(""), []);
    assert.deepEqual(chunkContent("   "), []);
  });

  it("handles single short content", () => {
    assert.deepEqual(chunkContent("tiny"), []);
    const chunks = chunkContent("This is enough content to pass the minimum size threshold easily.");
    assert.equal(chunks.length, 1);
  });
});

describe("classifyFile", () => {
  it("classifies memory files", () => {
    assert.deepEqual(classifyFile("/path/to/MEMORY.md"), {
      source: "long_term_memory",
      category: "fact",
    });
    assert.deepEqual(classifyFile("/path/memory/daily.md"), {
      source: "long_term_memory",
      category: "fact",
    });
  });

  it("classifies code files", () => {
    const codeExtensions = [".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go"];
    for (const ext of codeExtensions) {
      const result = classifyFile(`/path/to/file${ext}`);
      assert.equal(result.source, "file_content");
      assert.equal(result.category, "code_pattern", `Failed for ${ext}`);
    }
  });

  it("classifies config files as decisions", () => {
    for (const ext of [".json", ".yaml", ".yml"]) {
      const result = classifyFile(`/path/to/config${ext}`);
      assert.equal(result.category, "decision", `Failed for ${ext}`);
    }
  });

  it("classifies markdown/text as fact", () => {
    assert.equal(classifyFile("/path/README.md").category, "fact");
    assert.equal(classifyFile("/path/notes.txt").category, "fact");
  });

  it("falls back to fact for unknown extensions", () => {
    assert.deepEqual(classifyFile("/path/to/file.xyz"), {
      source: "file_content",
      category: "fact",
    });
  });
});

// ─── SQLite Storage ─────────────────────────────────────────────────────────

describe("SQLiteStorage", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  before(async () => {
    tmpDir = makeTmpDir();
    storage = new SQLiteStorage(join(tmpDir, "test.db"), 128);
    await storage.initialize();
  });

  after(async () => {
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("basic CRUD", () => {
    it("adds and retrieves a chunk", async () => {
      const chunk = makeChunk({ content: "Hello CRUD test" });
      await storage.addChunk(chunk);

      const retrieved = await storage.getChunk(chunk.id);
      assert.ok(retrieved);
      assert.equal(retrieved.id, chunk.id);
      assert.equal(retrieved.content, "Hello CRUD test");
      assert.equal(retrieved.category, "fact");
      assert.equal(retrieved.source, "system");
    });

    it("returns null for non-existent chunk", async () => {
      const result = await storage.getChunk("nonexistent");
      assert.equal(result, null);
    });

    it("deletes a chunk", async () => {
      const chunk = makeChunk({ content: "To be deleted" });
      await storage.addChunk(chunk);

      const deleted = await storage.deleteChunk(chunk.id);
      assert.equal(deleted, true);

      const retrieved = await storage.getChunk(chunk.id);
      assert.equal(retrieved, null);
    });

    it("returns false when deleting non-existent chunk", async () => {
      const deleted = await storage.deleteChunk("nonexistent");
      assert.equal(deleted, false);
    });

    it("stores and retrieves tags as JSON", async () => {
      const chunk = makeChunk({
        content: "Tagged chunk content here",
        tags: ["auth", "api", "important"],
      });
      await storage.addChunk(chunk);

      const retrieved = await storage.getChunk(chunk.id);
      assert.ok(retrieved);
      assert.deepEqual(retrieved.tags, ["auth", "api", "important"]);
    });

    it("stores chunks with embeddings", async () => {
      const provider = new TestEmbeddingProvider();
      const chunk = makeChunk({ content: "Chunk with embedding data" });
      const embedding = await provider.generateEmbedding(chunk.content);

      await storage.addChunk(chunk, embedding);
      const retrieved = await storage.getChunk(chunk.id);
      assert.ok(retrieved);
      assert.equal(retrieved.content, "Chunk with embedding data");
    });
  });

  describe("listing", () => {
    let listStorage: SQLiteStorage;
    let listDir: string;

    before(async () => {
      listDir = makeTmpDir();
      listStorage = new SQLiteStorage(join(listDir, "list.db"), 128);
      await listStorage.initialize();

      // Add chunks with different timestamps
      for (let i = 0; i < 10; i++) {
        await listStorage.addChunk(
          makeChunk({
            content: `List item ${i}`,
            category: i < 5 ? "fact" : "decision",
            importance: i / 10,
            timestamp: Date.now() - (9 - i) * 1000,
          }),
        );
      }
    });

    after(async () => {
      await listStorage.close();
      rmSync(listDir, { recursive: true, force: true });
    });

    it("lists chunks ordered by timestamp DESC", async () => {
      const chunks = await listStorage.list(5, 0);
      assert.equal(chunks.length, 5);
      // Newest first
      assert.ok(chunks[0].timestamp >= chunks[1].timestamp);
      assert.ok(chunks[1].timestamp >= chunks[2].timestamp);
    });

    it("supports offset pagination", async () => {
      const page1 = await listStorage.list(5, 0);
      const page2 = await listStorage.list(5, 5);
      assert.equal(page1.length, 5);
      assert.equal(page2.length, 5);
      // No overlap
      const page1Ids = new Set(page1.map((c) => c.id));
      assert.ok(page2.every((c) => !page1Ids.has(c.id)));
    });

    it("filters by category", async () => {
      const facts = await listStorage.list(20, 0, { category: "fact" });
      const decisions = await listStorage.list(20, 0, { category: "decision" });
      assert.equal(facts.length, 5);
      assert.equal(decisions.length, 5);
      assert.ok(facts.every((c) => c.category === "fact"));
      assert.ok(decisions.every((c) => c.category === "decision"));
    });

    it("filters by minimum importance", async () => {
      const important = await listStorage.list(20, 0, { minImportance: 0.5 });
      assert.ok(important.length > 0);
      assert.ok(important.every((c) => c.importance >= 0.5));
    });
  });

  describe("FTS5 keyword search", () => {
    let searchStorage: SQLiteStorage;
    let searchDir: string;

    before(async () => {
      searchDir = makeTmpDir();
      searchStorage = new SQLiteStorage(join(searchDir, "search.db"), 128);
      await searchStorage.initialize();

      await searchStorage.addChunk(
        makeChunk({ content: "TypeScript React frontend development" }),
      );
      await searchStorage.addChunk(
        makeChunk({ content: "Python Django backend API server" }),
      );
      await searchStorage.addChunk(
        makeChunk({ content: "PostgreSQL database migration scripts" }),
      );
      await searchStorage.addChunk(
        makeChunk({
          content: "React component testing with Jest",
          category: "code_pattern",
        }),
      );
      await searchStorage.addChunk(
        makeChunk({
          content: "Authentication with JWT tokens and sessions",
          category: "decision",
        }),
      );
    });

    after(async () => {
      await searchStorage.close();
      rmSync(searchDir, { recursive: true, force: true });
    });

    it("finds chunks by keyword", async () => {
      const results = await searchStorage.search("React", 10);
      assert.ok(results.length >= 2);
      assert.ok(results.every((r) => r.chunk.content.includes("React")));
    });

    it("returns results with scores", async () => {
      const results = await searchStorage.search("TypeScript", 10);
      assert.ok(results.length >= 1);
      assert.ok(results.every((r) => typeof r.score === "number"));
    });

    it("returns empty for non-matching query", async () => {
      const results = await searchStorage.search("xyznonexistent", 10);
      assert.equal(results.length, 0);
    });

    it("respects limit", async () => {
      const results = await searchStorage.search("React", 1);
      assert.equal(results.length, 1);
    });

    it("filters by category in search", async () => {
      const results = await searchStorage.search("React", 10, {
        category: "code_pattern",
      });
      assert.ok(results.length >= 1);
      assert.ok(results.every((r) => r.chunk.category === "code_pattern"));
    });

    it("handles FTS5 special characters safely", async () => {
      // These should not crash — they contain FTS5 operators
      const results1 = await searchStorage.search("NOT React", 10);
      const results2 = await searchStorage.search("React AND Python", 10);
      const results3 = await searchStorage.search("test (with) [brackets]", 10);
      // Should not throw — that's the main assertion
      assert.ok(Array.isArray(results1));
      assert.ok(Array.isArray(results2));
      assert.ok(Array.isArray(results3));
    });
  });

  describe("vector search", () => {
    let vecStorage: SQLiteStorage;
    let vecDir: string;
    const provider = new TestEmbeddingProvider();

    before(async () => {
      vecDir = makeTmpDir();
      vecStorage = new SQLiteStorage(join(vecDir, "vec.db"), 128);
      await vecStorage.initialize();

      assert.ok(vecStorage.isVecEnabled, "sqlite-vec should be enabled");

      const items = [
        "JavaScript frameworks like React and Vue for frontend",
        "Python machine learning with scikit-learn and TensorFlow",
        "Database optimization and SQL query performance tuning",
        "Docker containerization and Kubernetes orchestration",
        "REST API design patterns and best practices",
      ];

      for (const content of items) {
        const chunk = makeChunk({ content });
        const embedding = await provider.generateEmbedding(content);
        await vecStorage.addChunk(chunk, embedding);
      }
    });

    after(async () => {
      await vecStorage.close();
      rmSync(vecDir, { recursive: true, force: true });
    });

    it("sqlite-vec is enabled", () => {
      assert.ok(vecStorage.isVecEnabled);
    });

    it("finds similar vectors", async () => {
      const queryEmbedding = await provider.generateEmbedding(
        "frontend web development",
      );
      const results = vecStorage.vectorSearch(queryEmbedding, 5);
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.score > 0));
    });

    it("returns results ordered by similarity", async () => {
      const queryEmbedding = await provider.generateEmbedding("database SQL");
      const results = vecStorage.vectorSearch(queryEmbedding, 5);
      assert.ok(results.length > 0);
      // Scores should be in descending order
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].score >= results[i].score);
      }
    });

    it("hybrid search combines vector and keyword", async () => {
      const queryEmbedding = await provider.generateEmbedding("React");
      const results = vecStorage.hybridSearch("React", 5, undefined, queryEmbedding);
      assert.ok(results.length > 0);
      // Should find React-related content
      const topResult = results[0];
      assert.ok(topResult.chunk.content.includes("React"));
    });

    it("hybrid search works without embedding (keyword-only fallback)", async () => {
      const results = vecStorage.hybridSearch("Docker", 5);
      assert.ok(results.length > 0);
      assert.ok(results[0].chunk.content.includes("Docker"));
    });

    it("deleting a chunk removes its vector", async () => {
      const chunk = makeChunk({ content: "Temporary vector chunk for deletion test" });
      const embedding = await provider.generateEmbedding(chunk.content);
      await vecStorage.addChunk(chunk, embedding);

      // Verify it exists in vector search
      const queryEmb = await provider.generateEmbedding("Temporary vector");
      const before = vecStorage.vectorSearch(queryEmb, 10);
      const hasBefore = before.some((r) => r.chunk.id === chunk.id);
      assert.ok(hasBefore);

      // Delete and verify gone
      await vecStorage.deleteChunk(chunk.id);
      const afterResults = vecStorage.vectorSearch(queryEmb, 10);
      const hasAfter = afterResults.some((r) => r.chunk.id === chunk.id);
      assert.ok(!hasAfter);
    });
  });

  describe("statistics", () => {
    let statsStorage: SQLiteStorage;
    let statsDir: string;

    before(async () => {
      statsDir = makeTmpDir();
      statsStorage = new SQLiteStorage(join(statsDir, "stats.db"), 128);
      await statsStorage.initialize();

      await statsStorage.addChunk(makeChunk({ category: "fact", source: "system" }));
      await statsStorage.addChunk(makeChunk({ category: "fact", source: "system" }));
      await statsStorage.addChunk(makeChunk({ category: "decision", source: "user_message" }));
      await statsStorage.addChunk(makeChunk({ category: "code_pattern", source: "file_content" }));
    });

    after(async () => {
      await statsStorage.close();
      rmSync(statsDir, { recursive: true, force: true });
    });

    it("returns correct total count", async () => {
      const stats = await statsStorage.getStats();
      assert.equal(stats.totalChunks, 4);
    });

    it("breaks down by category", async () => {
      const stats = await statsStorage.getStats();
      assert.equal(stats.byCategory["fact"], 2);
      assert.equal(stats.byCategory["decision"], 1);
      assert.equal(stats.byCategory["code_pattern"], 1);
    });

    it("breaks down by source", async () => {
      const stats = await statsStorage.getStats();
      assert.equal(stats.bySource["system"], 2);
      assert.equal(stats.bySource["user_message"], 1);
      assert.equal(stats.bySource["file_content"], 1);
    });

    it("tracks timestamp range", async () => {
      const stats = await statsStorage.getStats();
      assert.ok(stats.oldestTimestamp !== null);
      assert.ok(stats.newestTimestamp !== null);
      assert.ok(stats.oldestTimestamp! <= stats.newestTimestamp!);
    });

    it("returns empty stats for fresh database", async () => {
      const emptyDir = makeTmpDir();
      const emptyStorage = new SQLiteStorage(join(emptyDir, "empty.db"), 128);
      await emptyStorage.initialize();

      const stats = await emptyStorage.getStats();
      assert.equal(stats.totalChunks, 0);
      assert.deepEqual(stats.byCategory, {});
      assert.deepEqual(stats.bySource, {});
      assert.equal(stats.oldestTimestamp, null);
      assert.equal(stats.newestTimestamp, null);

      await emptyStorage.close();
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});

// ─── File Watcher ───────────────────────────────────────────────────────────

describe("FileWatcher", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;
  let watchDir: string;

  before(async () => {
    tmpDir = makeTmpDir();
    watchDir = join(tmpDir, "watched");
    mkdirSync(watchDir, { recursive: true });
    storage = new SQLiteStorage(join(tmpDir, "watcher.db"), 128);
    await storage.initialize();
  });

  after(async () => {
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("syncs a file on startup (initial sync)", async () => {
    const filePath = join(watchDir, "test.md");
    writeFileSync(
      filePath,
      `## Architecture
This project uses TypeScript with a modular architecture.

## Database
SQLite with FTS5 for full-text search and sqlite-vec for vector search.`,
    );

    const watcher = new FileWatcher(storage, null, [filePath], 500);
    await watcher.start();

    // Give it a moment to index
    await sleep(200);

    const stats = await storage.getStats();
    assert.ok(stats.totalChunks > 0, "Should have indexed chunks from initial sync");

    const results = await storage.search("TypeScript", 10);
    assert.ok(results.length > 0, "Should find TypeScript content from synced file");

    await watcher.stop();
  });

  it("re-syncs on file change (replaces old chunks)", async () => {
    // Use isolated storage so previous test doesn't interfere
    const isoDir = makeTmpDir();
    const isoWatchDir = join(isoDir, "watched");
    mkdirSync(isoWatchDir, { recursive: true });
    const isoStorage = new SQLiteStorage(join(isoDir, "resync.db"), 128);
    await isoStorage.initialize();

    const filePath = join(isoWatchDir, "changing.md");
    writeFileSync(filePath, "## Pineapple\nPineapple content that is long enough to index properly.");

    const watcher = new FileWatcher(isoStorage, null, [filePath], 500);
    await watcher.start();
    await sleep(300);

    const resultsBefore = await isoStorage.search("Pineapple", 10);
    assert.ok(resultsBefore.length > 0);

    // Modify the file with completely different words
    writeFileSync(filePath, "## Butterfly\nButterfly migration patterns across the continent.");
    await sleep(2000); // Wait for debounce + processing

    const resultsAfterOld = await isoStorage.search("Pineapple", 10);
    const resultsAfterNew = await isoStorage.search("Butterfly", 10);

    // Old content should be gone, new content should be found
    assert.equal(resultsAfterOld.length, 0, "Old chunks should be removed");
    assert.ok(resultsAfterNew.length > 0, "New chunks should be indexed");

    await watcher.stop();
    await isoStorage.close();
    rmSync(isoDir, { recursive: true, force: true });
  });
});

// ─── End-to-End: MCP Protocol ──────────────────────────────────────────────

describe("MCP Protocol (end-to-end)", () => {
  it("responds to initialize request", async () => {
    const { spawn } = await import("node:child_process");
    const serverPath = new URL("../../dist/index.js", import.meta.url).pathname;

    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MEMORY_DB_PATH: join(makeTmpDir(), "mcp-test.db"),
        },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        // Kill after we get a response
        child.kill("SIGTERM");
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", () => resolve(stdout));
      child.on("error", reject);

      // Send initialize request
      const request = JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      });

      child.stdin.write(request + "\n");
      child.stdin.end();

      setTimeout(() => {
        child.kill("SIGTERM");
        resolve(stdout);
      }, 10000);
    });

    const parsed = JSON.parse(result.trim().split("\n")[0]);
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result.serverInfo.name, "memory-mcp");
    assert.equal(parsed.result.serverInfo.version, "1.0.0");
    assert.ok(parsed.result.capabilities.tools);
    assert.ok(parsed.result.capabilities.resources);
  });

  it("lists tools via tools/list", async () => {
    const { spawn } = await import("node:child_process");
    const serverPath = new URL("../../dist/index.js", import.meta.url).pathname;

    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MEMORY_DB_PATH: join(makeTmpDir(), "mcp-tools.db"),
        },
      });

      let stdout = "";
      const responses: string[] = [];

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        const lines = stdout.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          child.kill("SIGTERM");
        }
      });

      child.on("close", () => resolve(stdout));
      child.on("error", reject);

      // Send initialize then tools/list
      const init = JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      });

      const toolsList = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 2,
      });

      child.stdin.write(init + "\n");

      // Small delay to ensure init is processed
      setTimeout(() => {
        child.stdin.write(toolsList + "\n");
        child.stdin.end();
      }, 500);

      setTimeout(() => {
        child.kill("SIGTERM");
        resolve(stdout);
      }, 10000);
    });

    const lines = result.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 2, `Expected 2 responses, got ${lines.length}`);

    const toolsResponse = JSON.parse(lines[1]);
    assert.equal(toolsResponse.id, 2);

    const toolNames = toolsResponse.result.tools.map(
      (t: { name: string }) => t.name,
    );

    const expectedTools = [
      "memory_store",
      "memory_search",
      "memory_list",
      "memory_delete",
      "memory_get_stats",
      "memory_get_context",
    ];

    for (const name of expectedTools) {
      assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
    }
  });
});
