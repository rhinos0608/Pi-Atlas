# Scrapling Hybrid Search: API & Interface Spec

> TypeScript interfaces and contracts for BM25 + Embedding + RRF hybrid search pipeline.

---

## 1. ScraplingBridge

### Overview

Manages a persistent Python subprocess running Scrapling. Communicates via stdin/stdout JSON protocol. Falls back to plain `fetchText()` when Scrapling unavailable.

### TypeScript Interface

```ts
// src/scrapling-bridge.ts

export interface ScraplingBridgeOptions {
  /** Python executable path. Default: "python3" */
  pythonPath?: string;
  /** Fetcher mode. Default: "stealthy" */
  fetcher?: 'fetcher' | 'dynamic' | 'stealthy';
  /** Auto-solve Cloudflare challenges. Default: false */
  solveCloudflare?: boolean;
  /** Proxy URL for Scrapling. Default: undefined */
  proxy?: string;
  /** Timeout per fetch in ms. Default: 30000 */
  fetchTimeout?: number;
  /** Signal for cancellation */
  signal?: AbortSignal;
}

export interface ScraplingFetchResult {
  /** Final URL after redirects */
  url: string;
  /** Page title */
  title: string;
  /** Full extracted text content */
  content: string;
  /** HTTP status code if available */
  statusCode?: number;
  /** Content type header if available */
  contentType?: string;
}

export interface ScraplingHealthStatus {
  /** Whether Python + scrapling are available */
  available: boolean;
  /** Python version string if available */
  pythonVersion?: string;
  /** Scrapling version if available */
  scraplingVersion?: string;
  /** Error message if unavailable */
  error?: string;
}

export class ScraplingBridge {
  /**
   * Create a new bridge instance.
   * Does NOT start the Python process until first fetch() or health().
   */
  constructor(options?: ScraplingBridgeOptions);

  /**
   * Fetch a page using Scrapling.
   * Falls back to plain fetchText() if Scrapling unavailable.
   *
   * @param url - Public HTTP(S) URL to fetch
   * @returns Fetch result with extracted content
   * @throws On URL validation failure or unrecoverable fetch error after fallback exhausted
   */
  fetch(url: string): Promise<ScraplingFetchResult>;

  /**
   * Check Scrapling availability.
   * Launches Python subprocess briefly to verify scrapling is importable.
   * Caches result for life of instance.
   *
   * @returns Health status
   */
  health(): Promise<ScraplingHealthStatus>;

  /**
   * Close the bridge, terminating the Python subprocess.
   * Idempotent; safe to call multiple times.
   */
  close(): Promise<void>;
}
```

### Python Subprocess Protocol

The bridge spawns a persistent Python process that reads JSON lines from stdin and writes JSON lines to stdout:

```python
# Inline Python script (managed by bridge, not a separate file)

# Input (stdin, one JSON object per line):
# { "action": "fetch", "url": "https://...", "fetcher": "stealthy", "solve_cloudflare": true, "proxy": null, "timeout": 30000 }
# { "action": "health" }
# { "action": "close" }

# Output (stdout, one JSON object per line):
# { "ok": true, "url": "https://...", "title": "...", "content": "...", "status_code": 200, "content_type": "text/html" }
# { "ok": true, "python_version": "3.12.0", "scrapling_version": "1.5.0" }
# { "ok": false, "error": "ModuleNotFoundError: No module named 'scrapling'" }
```

### Error Handling Contract

- If Python subprocess fails to start → `health().available === false`, `fetch()` uses fallback
- If Python returns `{ "ok": false }` → bridge throws `Error` with message, then falls back
- If subprocess crashes mid-fetch → bridge restarts subprocess and retries once, then falls back
- If signal aborted → bridge terminates subprocess, throws `AbortError`
- All errors from Scrapling path are caught; `fetchText()` fallback is always attempted before throwing

---

## 2. BM25Index

### Overview

Pure TypeScript Okapi BM25 implementation. Zero dependencies. In-memory inverted index.

### TypeScript Interface

```ts
// src/bm25.ts

export interface BM25Document {
  /** Unique document identifier */
  id: string;
  /** Document text to index */
  text: string;
}

export interface BM25Result {
  /** Document identifier */
  id: string;
  /** BM25 score */
  score: number;
}

export interface BM25Stats {
  /** Number of documents in index */
  documentCount: number;
  /** Total number of unique terms */
  vocabularySize: number;
  /** Average document length in tokens */
  avgDocLength: number;
}

export class BM25Index {
  /**
   * Create a new BM25 index.
   *
   * @param k1 - Term frequency saturation parameter (default 1.5)
   * @param b - Length normalization parameter (default 0.75)
   */
  constructor(k1?: number, b?: number);

  /**
   * Add a document to the index.
   * Idempotent: re-adding same id replaces the document.
   *
   * @param id - Unique document identifier
   * @param text - Document text
   */
  add(id: string, text: string): void;

  /**
   * Add multiple documents at once.
   * More efficient than repeated add() calls (single pass tokenization + IDF update).
   *
   * @param docs - Array of documents
   */
  addBatch(docs: BM25Document[]): void;

  /**
   * Search the index with a query string.
   *
   * @param query - Query text
   * @param topK - Maximum results to return (default 20)
   * @returns Ranked results by descending BM25 score
   */
  search(query: string, topK?: number): BM25Result[];

  /**
   * Clear all documents from the index.
   */
  clear(): void;

  /**
   * Get index statistics.
   */
  stats(): BM25Stats;
}
```

### Tokenizer Contract

```ts
// Internal to bm25.ts; exposed for testing

export interface TokenizerOptions {
  /** Minimum token length (default 2) */
  minLength?: number;
  /** Stopwords to filter (default: English set) */
  stopwords?: Set<string>;
  /** Lowercase input (default: true) */
  lower?: boolean;
}

export function tokenize(text: string, options?: TokenizerOptions): string[];
```

Tokenization rules:
1. Lowercase input
2. Split on `/\W+/` (any non-word characters)
3. Filter tokens shorter than `minLength` (default 2)
4. Filter stopwords
5. No stemming

Stopword list: ~150 common English words (`the`, `a`, `an`, `is`, `are`, `was`, `were`, `be`, `been`, `being`, `have`, `has`, `had`, `do`, `does`, `did`, `will`, `would`, `shall`, `should`, `may`, `might`, `must`, `can`, `could`, `i`, `me`, `my`, `myself`, `we`, `our`, `ours`, `ourselves`, `you`, `your`, `yours`, `yourself`, `yourselves`, `he`, `him`, `his`, `himself`, `she`, `her`, `hers`, `herself`, `it`, `its`, `itself`, `they`, `them`, `their`, `theirs`, `themselves`, `what`, `which`, `who`, `whom`, `this`, `that`, `these`, `those`, `am`, `is`, `are`, `was`, `were`, `be`, `been`, `being`, `have`, `has`, `had`, `having`, `do`, `does`, `did`, `doing`, `a`, `an`, `the`, `and`, `but`, `if`, `or`, `because`, `as`, `until`, `while`, `of`, `at`, `by`, `for`, `with`, `about`, `against`, `between`, `into`, `through`, `during`, `before`, `after`, `above`, `below`, `to`, `from`, `up`, `down`, `in`, `out`, `on`, `off`, `over`, `under`, `again`, `further`, `then`, `once`, `here`, `there`, `when`, `where`, `why`, `how`, `all`, `any`, `both`, `each`, `few`, `more`, `most`, `other`, `some`, `such`, `no`, `nor`, `not`, `only`, `own`, `same`, `so`, `than`, `too`, `very`, `just`, `don`, `now`)

### BM25 Formula

```
BM25(q, d) = Σ(t in q) IDF(t) * (f(t,d) * (k1 + 1)) / (f(t,d) + k1 * (1 - b + b * |d| / avgdl))

where:
  IDF(t) = log((N - n(t) + 0.5) / (n(t) + 0.5) + 1)
  f(t,d) = term frequency of t in document d
  |d| = document length in tokens
  avgdl = average document length across corpus
  N = total number of documents
  n(t) = number of documents containing term t
  k1 = 1.5 (default)
  b = 0.75 (default)
```

---

## 3. VectorIndex

### Overview

In-memory cosine similarity vector index. Stores vectors as `Float32Array[]` and computes cosine similarity against query vector.

### TypeScript Interface

```ts
// src/vector-index.ts

export interface VectorDocument {
  /** Unique document identifier */
  id: string;
  /** Embedding vector */
  vector: Float32Array | number[];
}

export interface VectorResult {
  /** Document identifier */
  id: string;
  /** Cosine similarity score (-1 to 1). Negative values are valid. Not a probability — do not clamp unless explicitly transformed. */
  score: number;
}

export interface VectorIndexStats {
  /** Number of vectors in index */
  count: number;
  /** Vector dimensions (uniform) */
  dimensions: number;
}

export class VectorIndex {
  /**
   * Create a new vector index.
   *
   * @param dimensions - Expected vector dimensions (validated on add)
   */
  constructor(dimensions?: number);

  /**
   * Add a vector to the index.
   *
   * @param id - Unique document identifier
   * @param vector - Embedding vector (Float32Array or number[])
   * @throws If vector dimensions don't match index dimensions
   */
  add(id: string, vector: Float32Array | number[]): void;

  /**
   * Search the index with a query vector.
   *
   * @param queryVector - Query embedding vector
   * @param topK - Maximum results to return (default 20)
   * @returns Ranked results by descending cosine similarity
   */
  search(queryVector: Float32Array | number[], topK?: number): VectorResult[];

  /**
   * Clear all vectors from the index.
   */
  clear(): void;

  /**
   * Get index statistics.
   */
  stats(): VectorIndexStats;
}
```

### Cosine Similarity Formula

```
cosine(u, v) = (u · v) / (||u|| * ||v||)

where:
  u · v = Σ(u[i] * v[i])  (dot product)
  ||u|| = sqrt(Σ(u[i]^2))  (L2 norm)
```

Implementation note: vectors stored as `Float32Array` for efficiency. Norms pre-computed on `add()` and cached.

---

## 4. EmbeddingClient

### Overview

HTTP client for the Python embedding sidecar. Communicates over HTTP (localhost) using the OpenAI-compatible `/v1/embeddings` endpoint.

### TypeScript Interface

```ts
// src/embedding-client.ts

export interface EmbeddingClientOptions {
  /** Sidecar base URL. Default: "http://127.0.0.1:{auto-detected-port}" */
  baseUrl?: string;
  /** Request timeout in ms. Default: 30000 */
  timeout?: number;
  /** Maximum retries on transient failure. Default: 2 */
  maxRetries?: number;
  /** Signal for cancellation */
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  /** Original text index for batch ordering */
  index: number;
  /** Embedding vector */
  embedding: Float32Array;
}

export interface EmbeddingHealthStatus {
  /** Whether sidecar is reachable and healthy */
  available: boolean;
  /** Model name loaded */
  model?: string;
  /** Vector dimensions */
  dimensions?: number;
  /** Error message if unavailable */
  error?: string;
}

export class EmbeddingClient {
  /**
   * Create a new embedding client.
   * Does NOT start the sidecar; expects sidecar to be running.
   *
   * @param options - Client options
   */
  constructor(options?: EmbeddingClientOptions);

  /**
   * Generate embedding for a single text.
   *
   * @param text - Input text (truncated to model max tokens by sidecar)
   * @returns Embedding vector
   * @throws If sidecar unavailable after retries
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Generate embeddings for multiple texts in one batch request.
   *
   * @param texts - Input texts (each truncated to model max tokens by sidecar)
   * @returns Embedding vectors in original order
   * @throws If sidecar unavailable after retries
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /**
   * Check sidecar health.
   *
   * @returns Health status
   */
  health(): Promise<EmbeddingHealthStatus>;
}
```

---

## 5. SidecarManager

### Overview

Manages the lifecycle of the Python embedding sidecar subprocess. Auto-starts on first use, health-polls until ready, monitors for crashes, auto-restarts with exponential backoff.

### TypeScript Interface

```ts
// src/sidecar-manager.ts

export interface SidecarManagerOptions {
  /** Python executable path. Default: "python3" */
  pythonPath?: string;
  /** Path to sidecar app.py. Default: auto-resolved relative to package */
  sidecarPath?: string;
  /** Preferred port. Default: random available port */
  port?: number;
  /** Model name for sentence-transformers. Default: "all-MiniLM-L6-v2" */
  model?: string;
  /** Health check interval during startup (ms). Default: 200 */
  healthPollInterval?: number;
  /** Maximum time to wait for startup (ms). Default: 60000 */
  startupTimeout?: number;
  /** Enable GPU if available. Default: true */
  gpu?: boolean;
  /** Signal for cancellation */
  signal?: AbortSignal;
}

export interface SidecarStatus {
  /** Current lifecycle state */
  state: 'stopped' | 'starting' | 'running' | 'error';
  /** Port the sidecar is listening on */
  port?: number;
  /** PID of the Python subprocess */
  pid?: number;
  /** Model name loaded */
  model?: string;
  /** Error message if state is 'error' */
  error?: string;
}

export class SidecarManager {
  /**
   * Create a new sidecar manager.
   * Does NOT start the sidecar until start() or ensureRunning().
   *
   * @param options - Manager options
   */
  constructor(options?: SidecarManagerOptions);

  /**
   * Start the sidecar subprocess.
   * Resolves when sidecar responds healthy to /v1/health.
   *
   * @returns Status after startup
   * @throws If startup times out
   */
  start(): Promise<SidecarStatus>;

  /**
   * Ensure sidecar is running. Starts if stopped.
   * Idempotent: safe to call before every embedding request.
   *
   * @returns Current status
   */
  ensureRunning(): Promise<SidecarStatus>;

  /**
   * Get current sidecar status without side effects.
   */
  health(): Promise<SidecarStatus>;

  /**
   * Stop the sidecar subprocess.
   * Sends SIGTERM, escalates to SIGKILL after 5s.
   * Idempotent: safe to call multiple times.
   */
  stop(): Promise<void>;
}
```

### Lifecycle State Machine

```
stopped ──start()──> starting ──healthy──> running
   ^                    │                    │
   │                    │ crash/timeout      │ crash
   │                    v                    v
   └──stop()────── error ───auto-restart────┘
                       │
                       └── max retries exceeded ──> error (permanent)
```

Auto-restart: on crash, restart with exponential backoff (1s, 2s, 4s, 8s, max 30s). After 5 consecutive failures, give up and stay in `error` state. `start()` resets `consecutiveFailures` counter.

---

## 6. chunkText

### Overview

Sentence-boundary-aware text chunking. Replaces current naive 2000-char slicing in `src/native-tools.ts:585-589`.

### Function Signature

```ts
// src/chunker.ts

export interface ChunkOptions {
  /** Maximum characters per chunk. Default: 2048 (~512 tokens) */
  maxChars?: number;
  /** Overlap characters between chunks. Default: 512 (~128 tokens) */
  overlap?: number;
  /** Minimum characters for a chunk to be emitted. Default: 100 */
  minChars?: number;
}

export interface TextChunk {
  /** Chunk text content */
  text: string;
  /** Start character offset in original text */
  start: number;
  /** End character offset in original text */
  end: number;
}

/**
 * Split text into overlapping sentence-boundary-aware chunks.
 *
 * Splits on sentence boundaries (., !, ?, \n\n).
 * Falls back to paragraph boundaries, then fixed-size if no sentence boundaries found.
 * Preserves original text whitespace except for trimming per chunk.
 *
 * @param text - Input text to chunk
 * @param options - Chunking options
 * @returns Array of text chunks with position metadata
 */
export function chunkText(text: string, options?: ChunkOptions): TextChunk[];
```

### Splitting Algorithm

1. Split text into sentences: `/(?<=[.!?])\s+(?=[\p{L}])/gu` (Unicode-aware) with `\n\n` as hard breaks
2. Greedy sentence accumulation until `currentLength >= maxChars`
3. Emit chunk, retain last `overlap` chars worth of sentences
4. Repeat until all sentences consumed
5. Filter chunks shorter than `minChars`
6. Fallback: if text has no sentence boundaries, split on paragraphs (`\n\n+`)
7. Final fallback: fixed-size slices with overlap

---

## 7. Embedding Sidecar HTTP API

### POST /v1/embeddings

OpenAI-compatible embeddings endpoint.

**Request:**
```json
{
  "input": ["text to embed", "another text"],
  "model": "all-MiniLM-L6-v2"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| input | `string` or `string[]` | Yes | Text(s) to embed |
| model | `string` | No | Model name (ignored; always uses configured model) |

**Response (200):**
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.123, -0.456, ...]
    },
    {
      "object": "embedding",
      "index": 1,
      "embedding": [0.789, -0.012, ...]
    }
  ],
  "model": "all-MiniLM-L6-v2",
  "usage": {
    "prompt_tokens": 42,
    "total_tokens": 42
  }
}
```

**Error Response (4xx/5xx):**
```json
{
  "error": {
    "message": "Model not loaded",
    "type": "server_error",
    "code": 500
  }
}
```

### GET /v1/health

Health check endpoint.

**Response (200):**
```json
{
  "status": "ok",
  "model": "all-MiniLM-L6-v2",
  "dimensions": 384,
  "device": "cpu",
  "uptime_seconds": 123.4
}
```

**Response (503) — model loading:**
```json
{
  "status": "loading",
  "model": "all-MiniLM-L6-v2"
}
```

---

## 8. Configuration / Environment Variables

### New Env Vars

```bash
# ── Scrapling bridge ──
PI_SEARCH_SCRAPLING_ENABLED=1          # Enable (1) or disable (0). Default: enabled (auto-detect). Set to 0 to disable.
PI_SEARCH_SCRAPLING_FETCHER=stealthy   # fetcher | dynamic | stealthy. Default: stealthy
PI_SEARCH_SCRAPLING_SOLVE_CLOUDFLARE=1 # Auto-solve Cloudflare. Default: 1
PI_SEARCH_SCRAPLING_PROXY=             # Proxy URL. Default: empty (no proxy)

# ── Embedding sidecar ──
PI_SEARCH_EMBEDDING_ENABLED=1          # Enable (1) or disable (0). Default: 1
PI_SEARCH_EMBEDDING_MODEL=all-MiniLM-L6-v2  # Model name. Default: all-MiniLM-L6-v2
PI_SEARCH_EMBEDDING_DIMENSIONS=384     # Expected vector dimensions. Default: 384
PI_SEARCH_EMBEDDING_PORT=              # Preferred sidecar port. Default: random
```

### local-config.ts Mappings

Add to the `mappings` array:

```ts
['scrapling.enabled', 'PI_SEARCH_SCRAPLING_ENABLED'],
['scrapling.fetcher', 'PI_SEARCH_SCRAPLING_FETCHER'],
['scrapling.solveCloudflare', 'PI_SEARCH_SCRAPLING_SOLVE_CLOUDFLARE'],
['scrapling.proxy', 'PI_SEARCH_SCRAPLING_PROXY'],
['embedding.enabled', 'PI_SEARCH_EMBEDDING_ENABLED'],
['embedding.model', 'PI_SEARCH_EMBEDDING_MODEL'],
['embedding.dimensions', 'PI_SEARCH_EMBEDDING_DIMENSIONS'],
['embedding.port', 'PI_SEARCH_EMBEDDING_PORT'],
```

### cli-backend.ts Forwarding

Add to `allowed` array in `buildCliEnvironment`:
```
'PI_SEARCH_SCRAPLING_ENABLED',
'PI_SEARCH_SCRAPLING_FETCHER',
'PI_SEARCH_SCRAPLING_SOLVE_CLOUDFLARE',
'PI_SEARCH_SCRAPLING_PROXY',
'PI_SEARCH_EMBEDDING_ENABLED',
'PI_SEARCH_EMBEDDING_MODEL',
'PI_SEARCH_EMBEDDING_DIMENSIONS',
'PI_SEARCH_EMBEDDING_PORT',
```

### Config Resolution Order

1. Process environment (`process.env`) — highest priority
2. `.env` file at project root
3. JSON config file at `SEARCH_MCP_CONFIG_PATH` (via `local-config.ts` mappings)
4. Hardcoded defaults

---

## 9. Error Types and Handling

### Error Hierarchy

```ts
// src/scrapling-bridge.ts

export class ScraplingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ScraplingError';
  }
}

export class ScraplingUnavailableError extends ScraplingError {
  constructor(message = 'Scrapling is not available; falling back to plain fetch') {
    super(message);
    this.name = 'ScraplingUnavailableError';
  }
}

export class ScraplingFetchError extends ScraplingError {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ScraplingFetchError';
  }
}
```

```ts
// src/embedding-client.ts

export class EmbeddingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export class EmbeddingUnavailableError extends EmbeddingError {
  constructor(message = 'Embedding sidecar is not available') {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}
```

```ts
// src/sidecar-manager.ts

export class SidecarError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SidecarError';
  }
}

export class SidecarStartupError extends SidecarError {
  constructor(message = 'Sidecar failed to start within timeout') {
    super(message);
    this.name = 'SidecarStartupError';
  }
}

export class SidecarCrashError extends SidecarError {
  constructor(message: string, public readonly exitCode?: number) {
    super(message);
    this.name = 'SidecarCrashError';
  }
}
```

### Error Handling Contract in semanticCrawl

```ts
// Pseudocode for error handling in enhanced semanticCrawl()

async function semanticCrawl(args, options): Promise<BackendCallResult> {
  // 1. URL discovery — unchanged
  const urls = await semanticSourceUrls(...)

  // 2. Scrapling bridge — graceful degradation
  let bridge: ScraplingBridge | undefined;
  if (env.PI_SEARCH_SCRAPLING_ENABLED !== '0') {
    bridge = new ScraplingBridge({ /* config */ });
    const health = await bridge.health();
    if (!health.available) {
      bridge = undefined; // fall through to plain fetch
    }
  }

  // 3. Embedding — graceful degradation
  let sidecar: SidecarManager | undefined;
  let embeddingClient: EmbeddingClient | undefined;
  let vectorIndex: VectorIndex | undefined;
  if (env.PI_SEARCH_EMBEDDING_ENABLED !== '0') {
    sidecar = new SidecarManager({ /* config */ });
    try {
      await sidecar.ensureRunning();
      embeddingClient = new EmbeddingClient({ baseUrl: `http://127.0.0.1:${sidecar.status.port}` });
      vectorIndex = new VectorIndex(/* dims */);
    } catch {
      // Sidecar unavailable; continue with BM25 only
      sidecar = undefined;
      embeddingClient = undefined;
      vectorIndex = undefined;
    }
  }

  // 4. Per-page loop
  const bm25Index = new BM25Index();
  for (const url of urls.slice(0, maxPages)) {
    let page: { url: string; title: string; content: string };
    try {
      page = bridge
        ? await bridge.fetch(url)
        : await fetchReadablePage(url, options.signal); // fallback
    } catch {
      continue; // skip failed pages
    }

    for (const chunk of chunkText(page.content)) {
      const chunkId = `${url}#${chunk.start}`;
      bm25Index.add(chunkId, chunk.text);
      if (vectorIndex && embeddingClient) {
        try {
          const vec = await embeddingClient.embed(chunk.text);
          vectorIndex.add(chunkId, vec);
        } catch {
          // Embedding failed for this chunk; skip vector index
        }
      }
    }
  }

  // 5. Query and fuse
  const bm25Results = bm25Index.search(query, topK * 2);
  let fused: Array<{ item: BM25Result; rrfScore: number }>;

  if (vectorIndex && embeddingClient) {
    try {
      const queryVec = await embeddingClient.embed(query);
      const vecResults = vectorIndex.search(queryVec, topK * 2);
      fused = rrfMerge(
        [bm25Results, vecResults.map(r => ({ id: r.id, score: r.score }))],
        { keyFn: r => r.id }
      );
    } catch {
      fused = bm25Results.map(r => ({ item: r, rrfScore: r.score }));
    }
  } else {
    fused = bm25Results.map(r => ({ item: r, rrfScore: r.score }));
  }

  // 6. Build result
  const ranked = fused.slice(0, topK).map(r => ({
    url: r.item.id.split('#')[0]!,
    content: /* resolve chunk text */,
    title: /* resolve from page map */,
    score: r.rrfScore,
  }));

  return textResult(/* formatted text */, { query, results: ranked });
}
```

### Key Error Handling Principles

1. **Every layer degrades independently** — Scrapling down ≠ embedding down ≠ BM25 down (BM25 can't fail)
2. **Fallback before throw** — always try fallback path before throwing
3. **Per-page failure isolation** — one failed page doesn't kill the crawl
4. **Per-chunk embedding failure isolation** — one failed embedding doesn't kill the vector index
5. **Partial results always returned** — even if Scrapling + embedding both fail, BM25 still works
6. **Errors logged, not silenced** — use `console.warn` for degradations so users know what's missing

---

## 10. Integration Points Summary

| Component | Creates | Modifies | Uses |
|-----------|---------|----------|------|
| `src/bm25.ts` | new file | — | — |
| `src/chunker.ts` | new file | — | — |
| `src/vector-index.ts` | new file | — | — |
| `src/embedding-client.ts` | new file | — | `src/http.ts` (for fetch) |
| `src/sidecar-manager.ts` | new file | — | `node:child_process` |
| `src/scrapling-bridge.ts` | new file | — | `node:child_process`, `src/http.ts` (fallback) |
| `sidecar/app.py` | new file | — | `fastapi`, `uvicorn`, `sentence-transformers` |
| `sidecar/requirements.txt` | new file | — | — |
| `src/native-tools.ts` | — | `fetchReadablePage`, `chunkText`, `scoreText`, `semanticCrawl` | all above |
| `src/index.ts` | — | `buildFetchRoute` (possibly) | — |
| `src/local-config.ts` | — | `mappings` array | — |
| `src/cli-backend.ts` | — | `allowed` array | — |
| `.env.example` | — | add new vars | — |
| `package.json` | — | no new deps (Phase 1-3) | — |
| `src/fusion.ts` | — | none (reuse as-is) | — |
