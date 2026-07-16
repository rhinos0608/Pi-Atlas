# Scrapling Hybrid Search Implementation Plan

> **For agentic workers:** Implement task-by-task in order. Track progress with checkboxes. Do not commit.

**Goal:** Replace naive `semanticCrawl` pipeline with true hybrid search: Scrapling JS rendering + BM25 lexical ranking + embedding semantic search + RRF fusion, with graceful degradation at every layer.

**Architecture:** Four independent layers plug into `semanticCrawl()` in `src/native-tools.ts`. Each layer degrades gracefully. Zero new npm dependencies for Phases 1-3. Existing `rrfMerge` reused as-is.

**Tech stack:** TypeScript (pure BM25, chunker, vector-index), Node.js child_process (Scrapling bridge, sidecar manager), Python FastAPI (embedding sidecar), Python Scrapling (page fetching).

---

## Global Constraints

- ADR 0004 must be approved before implementation.
- Preserve user-owned files; do not edit, format, stage, or overwrite without explicit instructions.
- One writer only. Complete each phase before starting the next.
- Zero new npm dependencies for Phases 1-3. Optional `@huggingface/transformers` only in Phase 4.
- All new code must have corresponding tests.
- `npm test` must continue passing after each phase.
- `npm run typecheck` must pass after each phase.

---

## Phase 1: BM25 + Chunker (Zero Dependencies, Zero Risk)

**Value:** Immediate ranking quality boost. No external deps. Can ship independently.

### Task 1.1: Create BM25 Index

**Files:** create `src/bm25.ts`, `test/bm25.test.ts`

**Produces:** `BM25Index` class with `add`, `addBatch`, `search`, `clear`, `stats`.

- [ ] Implement `tokenize()` with lowercase, `/\W+/` split, min length 2, English stopwords (inline list ~150 words)
- [ ] Implement `BM25Index` with Okapi BM25 (k1=1.5, b=0.75)
- [ ] `add(id, text)`: tokenize, update inverted index, update IDF cache, update doc length stats
- [ ] `addBatch(docs)`: single-pass tokenization + IDF update (more efficient than repeated `add`)
- [ ] `search(query, topK)`: tokenize query, compute BM25 score per document, sort descending, return topK
- [ ] `clear()`: reset all internal state
- [ ] `stats()`: return documentCount, vocabularySize, avgDocLength
- [ ] Export `tokenize` for testing

**Tests (`test/bm25.test.ts`):**
- [ ] Tokenizer: lowercase, split on non-word, min length filter, stopword filter, edge cases (empty, all-stopwords, numbers, unicode)
- [ ] `add` + `search`: single term, multi-term, term frequency saturation (repeating term doesn't linearly boost)
- [ ] IDF weighting: rare term scores higher than common term
- [ ] Document length normalization: longer docs not advantaged
- [ ] `addBatch`: same results as sequential `add`
- [ ] `clear` + `search`: empty index returns empty array
- [ ] `stats`: correct counts after adds
- [ ] Edge: duplicate ids (replaces), empty text, very long text

**Acceptance:**
```bash
node --import tsx --test test/bm25.test.ts  # all green
```

### Task 1.2: Create Text Chunker

**Files:** create `src/chunker.ts`, `test/chunker.test.ts`

**Produces:** `chunkText()` function with sentence-boundary-aware splitting.

- [ ] Implement `chunkText(text, options)`:
  - Split on sentence boundaries: `/(?<=[.!?])\s+(?=[A-Z])/g`
  - `\n\n` as hard paragraph breaks
  - Greedy accumulate sentences until `>= maxChars` (default 2048)
  - Emit chunk, retain overlap (default 512 chars worth of sentences)
  - Filter chunks shorter than `minChars` (default 100)
  - Fallback: paragraph split on `\n\n+`
  - Final fallback: fixed-size slices with overlap
- [ ] Return `TextChunk[]` with `text`, `start`, `end`

**Tests (`test/chunker.test.ts`):**
- [ ] Short text (< maxChars): single chunk
- [ ] Long text: multiple chunks with correct boundaries at sentence breaks
- [ ] Overlap: adjacent chunks share characters
- [ ] Paragraph boundaries preserved (no chunk splits mid-paragraph unless paragraph exceeds maxChars)
- [ ] Min chars filtering: very short chunks omitted
- [ ] Empty text: empty array
- [ ] Text with no sentence boundaries (single line): fallback to paragraph split
- [ ] Text with no paragraph breaks: fallback to fixed-size
- [ ] Unicode/special characters: preserved correctly
- [ ] Position metadata: start/end accurate

**Acceptance:**
```bash
node --import tsx --test test/chunker.test.ts  # all green
```

### Task 1.3: Wire BM25 + Chunker into semanticCrawl

**Files:** modify `src/native-tools.ts`

**Produces:** `semanticCrawl()` uses `BM25Index` + `chunkText()` instead of naive `scoreText()` + `chunkText()`.

- [ ] Import `BM25Index` from `./bm25.js`
- [ ] Import `chunkText` from `./chunker.js`
- [ ] In `semanticCrawl()`:
  - Create `const bm25Index = new BM25Index()` before page loop
  - Replace `chunkText(page.content)` with new chunker (keep existing function name as wrapper or inline)
  - Replace `scoreText(content, query)` with: `bm25Index.add(chunkId, chunk.text)` during indexing phase
  - After page loop: `const ranked = bm25Index.search(query, topK)` instead of `dedupeBy(chunks).sort()`
  - Map results back to chunk data for text formatting
- [ ] Keep `fetchReadablePage()` unchanged (Scrapling replaces in Phase 3)
- [ ] Keep `dedupeBy` for URL dedup (still needed)
- [ ] Remove `scoreText()` function (line 591-594) — no longer used
- [ ] Add `console.warn` log: "Using BM25 ranking (Phase 1)" for observability

**Tests:**
- [ ] Existing `semanticCrawl` tests (if any in test suite) must pass
- [ ] `npm test` must pass
- [ ] Manual: `node --import tsx src/cli.ts call fetch '{"query":"test","url":"https://example.com"}'` returns results

**Acceptance:**
```bash
npm test                          # all existing tests pass
npm run typecheck                 # no new errors
node --import tsx --test test/bm25.test.ts test/chunker.test.ts  # all green
```

**Estimated effort:** 2-3 hours

---

## Phase 2: Embedding Sidecar + Vector Index

**Value:** True semantic search via vector embeddings. Requires Python deps but degrades gracefully.

**Prerequisite:** Phase 1 complete.

### Task 2.1: Create Embedding Sidecar (Python)

**Files:** create `sidecar/app.py`, `sidecar/requirements.txt`

**Produces:** Python FastAPI app serving `/v1/embeddings` (POST) and `/v1/health` (GET).

- [ ] `sidecar/requirements.txt`:
  ```
  fastapi>=0.115.0
  uvicorn>=0.32.0
  sentence-transformers>=3.3.0
  ```
- [ ] `sidecar/app.py`:
  - Accept `--port` CLI arg (default: random or 8765)
  - Accept `--model` CLI arg (default: `all-MiniLM-L6-v2`)
  - Accept `--device` CLI arg (default: auto-detect GPU/CPU)
  - Load model on startup (lazy: first request triggers load if `--preload` not set)
  - `GET /v1/health`:
    - Returns `{"status": "ok", "model": "...", "dimensions": 384, "device": "cpu", "uptime_seconds": ...}` if model loaded
    - Returns `{"status": "loading", "model": "..."}` if model still loading
  - `POST /v1/embeddings`:
    - Body: `{"input": "..." or ["...", "..."], "model": "..."}`
    - Returns OpenAI-compatible: `{"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [...]}], "model": "...", "usage": {...}}`
    - Single text: convert to `[text]` internally
    - Batch: pass all texts to `model.encode()` at once
    - Truncate texts to model max sequence length silently
    - Error responses: `{"error": {"message": "...", "type": "...", "code": 500}}`
  - Print port to stdout on startup: `SIDECAR_PORT=<port>` (TypeScript parses this)
  - Handle SIGTERM gracefully (close model, stop uvicorn)

**Verification:**
```bash
cd sidecar
pip install -r requirements.txt
python app.py --port 8765 --model all-MiniLM-L6-v2 &
sleep 5
curl http://127.0.0.1:8765/v1/health
curl -X POST http://127.0.0.1:8765/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world", "model": "all-MiniLM-L6-v2"}'
kill %1
```

### Task 2.2: Create Vector Index

**Files:** create `src/vector-index.ts`, `test/vector-index.test.ts`

**Produces:** `VectorIndex` class with in-memory cosine similarity search.

- [ ] Implement `VectorIndex`:
  - Store vectors as `Float32Array[]`
  - Pre-compute and cache L2 norms on `add()`
  - `add(id, vector)`: validate dimensions, store vector + norm
  - `search(queryVector, topK)`: compute cosine similarity for all vectors, sort descending, return topK
  - `clear()`: reset arrays
  - `stats()`: count, dimensions
- [ ] Accept `number[]` or `Float32Array` for both `add` and `search`

**Tests (`test/vector-index.test.ts`):**
- [ ] `add` + `search`: identical vector returns score ~1.0
- [ ] Orthogonal vectors return score ~0.0
- [ ] `search` returns correct topK sorted
- [ ] Dimension mismatch on `add` throws
- [ ] `clear` empties index
- [ ] `stats` returns correct counts
- [ ] Edge: empty index search returns empty array
- [ ] Edge: single vector in index

**Acceptance:**
```bash
node --import tsx --test test/vector-index.test.ts  # all green
```

### Task 2.3: Create Embedding Client

**Files:** create `src/embedding-client.ts`, `test/embedding-client.test.ts`

**Produces:** `EmbeddingClient` class for HTTP communication with sidecar.

- [ ] Implement `EmbeddingClient`:
  - `embed(text)`: POST to `/v1/embeddings`, return `Float32Array`
  - `embedBatch(texts)`: POST all texts at once, return `Float32Array[]`
  - `health()`: GET `/v1/health`, parse response
  - Timeout: configurable, default 30s
  - Retry: configurable max retries, default 2, on transient HTTP errors (5xx, ECONNREFUSED)
  - Truncate single-text input to 8192 chars as client-side guard

**Tests (`test/embedding-client.test.ts`):**
- [ ] Mock HTTP server (use `node:http` or mock `fetch`):
  - `embed()`: sends correct body, parses correct response
  - `embedBatch()`: sends array, returns array in order
  - `health()`: parses health response
  - Timeout test: server doesn't respond, client throws after timeout
  - Retry test: server fails once then succeeds, client retries
  - Server returns error: client retries then throws `EmbeddingUnavailableError`
  - Empty text: handled gracefully (returns zero vector or throws)

**Acceptance:**
```bash
node --import tsx --test test/embedding-client.test.ts  # all green
```

### Task 2.4: Create Sidecar Manager

**Files:** create `src/sidecar-manager.ts`, `test/sidecar-manager.test.ts`

**Produces:** `SidecarManager` class for Python subprocess lifecycle.

- [ ] Implement `SidecarManager`:
  - `start()`: spawn `python3 sidecar/app.py --port <random> --model <model>`, parse `SIDECAR_PORT=<port>` from stdout, health-poll until ready
  - `ensureRunning()`: if stopped/error, call `start()`. Idempotent.
  - `health()`: check if subprocess alive, return status
  - `stop()`: SIGTERM → SIGKILL after 5s. Clean up.
  - Auto-restart: on crash, restart with exponential backoff (1s, 2s, 4s, 8s, max 30s). Max 5 consecutive failures.
  - Port detection: random available port via `net.createServer().listen(0)` then close
  - Forward `PI_SEARCH_EMBEDDING_MODEL` for model selection
  - Forward `--device cpu` if GPU not available

**Tests (`test/sidecar-manager.test.ts`):**
- [ ] Mock `child_process.spawn`:
  - `start()`: spawns correct command, parses port from stdout
  - `ensureRunning()`: doesn't double-start if already running
  - `health()`: returns correct status per lifecycle state
  - `stop()`: sends SIGTERM, cleans up
  - Crash recovery: auto-restarts on process exit
  - Max retries: gives up after 5 consecutive failures
  - Timeout: throws `SidecarStartupError` if startup > 60s
  - Signal abort: stops subprocess

**Acceptance:**
```bash
node --import tsx --test test/sidecar-manager.test.ts  # all green
```

### Task 2.5: Wire Embedding Pipeline into semanticCrawl

**Files:** modify `src/native-tools.ts`

**Produces:** `semanticCrawl()` uses BM25 + embedding + RRF fusion.

- [ ] Import `VectorIndex` from `./vector-index.js`
- [ ] Import `EmbeddingClient` from `./embedding-client.js`
- [ ] Import `SidecarManager` from `./sidecar-manager.js`
- [ ] Gate behind `PI_SEARCH_EMBEDDING_ENABLED !== '0'`
- [ ] In `semanticCrawl()`:
  - Before page loop: create `SidecarManager`, call `ensureRunning()`, create `EmbeddingClient` + `VectorIndex`. Catch errors → fallback to BM25-only.
  - During page loop (after BM25 `add`): collect all chunk texts in array. After page loop: call `embeddingClient.embedBatch(texts)`, map returned vectors to chunkIds, add to `VectorIndex`. Catch batch errors → fallback to BM25-only.
  - After page loop (query phase):
    - `bm25Results = bm25Index.search(query, topK * 2)`
    - If embedding available: `queryVec = await embeddingClient.embed(query)`, `vecResults = vectorIndex.search(queryVec, topK * 2)`, `fused = rrfMerge([bm25Results, vecResults], { keyFn: r => r.id })`
    - Else: use `bm25Results` directly
  - Map fused results back to chunk content + URL + title
- [ ] Add `console.warn` logs for degradations (sidecar unavailable, embedding failed, etc.)

**Tests:**
- [ ] `npm test` must pass (existing tests unmodified)
- [ ] Manual integration test with real sidecar:
  ```bash
  pip install fastapi uvicorn sentence-transformers
  PI_SEARCH_EMBEDDING_ENABLED=1 node --import tsx src/cli.ts call fetch '{"query":"machine learning","searchQuery":"machine learning overview","maxPages":2,"topK":5}'
  ```
  Verify results include `rrfScore` field and are meaningfully ranked.

**Acceptance:**
```bash
npm test                          # all existing tests pass
npm run typecheck                 # no new errors
```

**Estimated effort:** 5-7 hours

---

## Phase 3: Scrapling Bridge

**Value:** JS rendering, stealth crawling, anti-bot bypass. Replaces naive `fetchReadablePage`.

**Prerequisite:** Phase 1 complete (Phase 2 optional, Scrapling works independently of embeddings).

### Task 3.1: Create Scrapling Bridge

**Files:** create `src/scrapling-bridge.ts`, `test/scrapling-bridge.test.ts`

**Produces:** `ScraplingBridge` class with Python subprocess management.

- [ ] Implement Python inline script (embedded as string in TypeScript):
  - Accept JSON commands on stdin: `{"action": "fetch", "url": "...", "fetcher": "stealthy", "solve_cloudflare": true, "proxy": null, "timeout": 30000}`
  - `fetch`: use Scrapling's `StealthyFetcher`/`DynamicFetcher`/`Fetcher` based on mode, return `{"ok": true, "url": "...", "title": "...", "content": "...", "status_code": 200, "content_type": "..."}`
  - `health`: import scrapling, return `{"ok": true, "python_version": "...", "scrapling_version": "..."}`
  - `close`: exit process
  - On error: `{"ok": false, "error": "..."}`
- [ ] Implement `ScraplingBridge` class:
  - `constructor(options)`: store options, don't start process
  - `health()`: spawn one-shot Python to test scrapling import. Cache result.
  - `fetch(url)`: 
    - First call: start persistent Python subprocess
    - Send JSON command, await JSON response
    - On error: attempt restart once, then fall back to `fetchText()` (import from `src/http.js`)
  - `close()`: send close command, terminate subprocess, idempotent
- [ ] Session reuse: single Python process per bridge instance; keep alive across multiple `fetch()` calls within a `semanticCrawl` invocation
- [ ] Config from env:
  - `PI_SEARCH_SCRAPLING_ENABLED` — if `0`, `health()` returns `{available: false}` immediately
  - `PI_SEARCH_SCRAPLING_FETCHER` — `fetcher` | `dynamic` | `stealthy`
  - `PI_SEARCH_SCRAPLING_SOLVE_CLOUDFLARE` — `1` to enable
  - `PI_SEARCH_SCRAPLING_PROXY` — proxy URL

**Tests (`test/scrapling-bridge.test.ts`):**
- [ ] Mock `child_process.execFile` / `spawn`:
  - `health()` when Python available: returns `{available: true, ...}`
  - `health()` when Python unavailable: returns `{available: false, error: "..."}`
  - `fetch()`: sends correct JSON command, parses correct response
  - `fetch()` when Scrapling returns error: throws, then fallback path tested
  - `fetch()` when Python crashes: restarts once, falls back on second failure
  - `close()`: terminates subprocess, idempotent
  - Session reuse: second `fetch()` doesn't spawn new process
  - Disabled via env: `health()` returns unavailable, `fetch()` uses fallback immediately
  - URL validation: rejects non-HTTP(S) URLs before spawning Python
  - Signal abort: terminates subprocess

**Acceptance:**
```bash
node --import tsx --test test/scrapling-bridge.test.ts  # all green
```

### Task 3.2: Wire Scrapling into semanticCrawl and fetchReadablePage

**Files:** modify `src/native-tools.ts`

**Produces:** `fetchReadablePage()` uses Scrapling with fallback.

- [ ] Import `ScraplingBridge` from `./scrapling-bridge.js`
- [ ] Modify `fetchReadablePage()`:
  - Gate behind `PI_SEARCH_SCRAPLING_ENABLED !== '0'`
  - Create `ScraplingBridge` instance (or accept one as parameter for session reuse)
  - Try `bridge.fetch(url)` first
  - Catch → fall back to existing `fetchText()` + `stripHtml()`
- [ ] Modify `semanticCrawl()`:
  - Create ONE `ScraplingBridge` instance before page loop
  - Pass bridge to `fetchReadablePage()` (or make `fetchReadablePage` accept it)
  - Call `bridge.close()` in finally block after page loop
- [ ] Remove old `fetchReadablePage` pure-HTTP path only if Scrapling disabled — keep it as the fallback

**Tests:**
- [ ] `npm test` must pass (existing tests unmodified)
- [ ] Manual integration test with Scrapling installed:
  ```bash
  pip install scrapling
  PI_SEARCH_SCRAPLING_ENABLED=1 node --import tsx src/cli.ts call fetch '{"url":"https://example.com"}'
  ```

### Task 3.3: Update Env Config and Forwarding

**Files:** modify `.env.example`, `src/local-config.ts`, `src/cli-backend.ts`

- [ ] Add env vars to `.env.example` under new `# ── Scrapling bridge ──` section:
  ```bash
  # ── Scrapling bridge ──
  PI_SEARCH_SCRAPLING_ENABLED=1
  PI_SEARCH_SCRAPLING_FETCHER=stealthy
  PI_SEARCH_SCRAPLING_SOLVE_CLOUDFLARE=1
  # PI_SEARCH_SCRAPLING_PROXY=
  ```
- [ ] Add to `.env.example` under `# ── Embedding sidecar ──`:
  ```bash
  # ── Embedding sidecar (local Python service) ──
  PI_SEARCH_EMBEDDING_ENABLED=1
  # PI_SEARCH_EMBEDDING_MODEL=all-MiniLM-L6-v2
  # PI_SEARCH_EMBEDDING_DIMENSIONS=384
  # PI_SEARCH_EMBEDDING_PORT=
  ```
  (Keep existing `EMBEDDING_SIDECAR_*` for external OpenAI API — different prefix, different use case)
- [ ] Add to `local-config.ts` `mappings` array:
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
- [ ] Add to `cli-backend.ts` `allowed` array:
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

**Acceptance:**
```bash
npm test                          # all tests pass
npm run typecheck                 # no errors
grep PI_SEARCH_SCRAPLING .env.example   # vars present
grep PI_SEARCH_EMBEDDING .env.example   # vars present  
grep scrapling src/local-config.ts      # mappings present
grep PI_SEARCH_SCRAPLING src/cli-backend.ts  # forwarding present
```

**Estimated effort:** 4-6 hours

---

## Phase 4: Integration Tests + Polish

**Value:** End-to-end validation, documentation, performance tuning.

**Prerequisite:** Phases 1-3 complete.

### Task 4.1: Integration Tests

**Files:** modify `test/fusion.test.ts` (add BM25+embedding fusion test), create `test/hybrid-search.test.ts`

- [ ] Add BM25 + embedding RRF fusion test to `test/fusion.test.ts`:
  - Create BM25 results (id + score)
  - Create vector results (id + score)
  - Fuse with `rrfMerge`
  - Assert items appearing in both lists ranked higher
  - Assert items in only one list still appear
- [ ] Create `test/hybrid-search.test.ts`:
  - Mock all subprocess/fetch dependencies
  - Test full pipeline: URL discovery → page fetch → chunk → BM25 index → embedding index → RRF fusion → result formatting
  - Test graceful degradation: Scrapling unavailable → uses fallback fetch
  - Test graceful degradation: sidecar unavailable → BM25 only
  - Test graceful degradation: both unavailable → BM25 with plain fetch
  - Test per-page failure isolation
  - Test per-chunk embedding failure isolation
  - Test empty results (no URLs found, all pages fail)
  - Test AbortSignal propagation
  - Test `fetch` tool contract: `buildFetchRoute` → `semanticCrawl` returns correct shape

**Acceptance:**
```bash
node --import tsx --test test/hybrid-search.test.ts  # all green
node --import tsx --test test/fusion.test.ts         # all green (including new tests)
```

### Task 4.2: Update README and Docs

**Files:** modify `README.md`, `SKILL.md`

- [ ] `README.md`:
  - Add "Hybrid Search" section describing BM25 + embeddings + Scrapling
  - Document new env vars
  - Document Python dependencies: `pip install scrapling fastapi uvicorn sentence-transformers`
  - Document graceful degradation behavior
  - Add "Quick Start" for hybrid search setup
- [ ] `SKILL.md`:
  - Update fetch tool description to mention semantic capabilities
  - Add guidance on when hybrid search is most useful (vs plain fetch)
  - Document Python dep requirement

### Task 4.3: Full Verification Gate

- [ ] Run `node --import tsx --test test/bm25.test.ts test/chunker.test.ts test/vector-index.test.ts test/embedding-client.test.ts test/sidecar-manager.test.ts test/scrapling-bridge.test.ts test/fusion.test.ts test/hybrid-search.test.ts`
- [ ] Run `npm test`
- [ ] Run `npm run typecheck`
- [ ] Run `npm audit --audit-level=high` (should be clean — no new deps)
- [ ] Run `npm pack --dry-run`; verify no Python/sidecar/test files ship in package (Python files in `sidecar/` are not in `package.json` `files` array)
- [ ] Run `git diff --check`; inspect full diff
- [ ] Manual integration test (if Scrapling + Python deps installed):
  ```bash
  # Test 1: BM25 only (fast path)
  PI_SEARCH_EMBEDDING_ENABLED=0 PI_SEARCH_SCRAPLING_ENABLED=0 \
    node --import tsx src/cli.ts call fetch '{"query":"test","url":"https://example.com","topK":3}'
  
  # Test 2: BM25 + embeddings
  PI_SEARCH_EMBEDDING_ENABLED=1 PI_SEARCH_SCRAPLING_ENABLED=0 \
    node --import tsx src/cli.ts call fetch '{"query":"test","searchQuery":"web development","maxPages":2,"topK":5}'
  
  # Test 3: Full pipeline with Scrapling
  PI_SEARCH_EMBEDDING_ENABLED=1 PI_SEARCH_SCRAPLING_ENABLED=1 \
    node --import tsx src/cli.ts call fetch '{"query":"test","searchQuery":"javascript frameworks","maxPages":2,"topK":5}'
  
  # Test 4: Graceful degradation (no Scrapling, no sidecar)
  PI_SEARCH_EMBEDDING_ENABLED=0 PI_SEARCH_SCRAPLING_ENABLED=0 \
    node --import tsx src/cli.ts call fetch '{"query":"test","url":"https://example.com"}'
  ```
- [ ] Verify all four modes return valid results (even if degraded)

### Task 4.4: Optional — @huggingface/transformers Alternate Path

**Gate:** Separate approval after Phase 2 burn-in.

- [ ] Evaluate `@huggingface/transformers` npm package:
  - Install size impact
  - CPU inference speed vs Python sidecar
  - Model loading time
- [ ] If superior: create `src/embedding-local.ts` that implements same `EmbeddingClient` interface using ONNX runtime
- [ ] Config: `PI_SEARCH_EMBEDDING_BACKEND=sidecar|local` (default `sidecar`)
- [ ] Same graceful degradation: `local` backend doesn't need Python at all

**Estimated effort:** 3-5 hours

---

## Files Summary

### New Files (9 source + 7 test)

| File | Phase | Purpose | Lines (est) |
|------|-------|---------|-------------|
| `src/bm25.ts` | 1 | BM25Index class | ~200 |
| `src/chunker.ts` | 1 | Sentence-boundary chunker | ~60 |
| `src/vector-index.ts` | 2 | Cosine similarity index | ~70 |
| `src/embedding-client.ts` | 2 | HTTP client for sidecar | ~80 |
| `src/sidecar-manager.ts` | 2 | Python process lifecycle | ~100 |
| `src/scrapling-bridge.ts` | 3 | Scrapling Python bridge | ~200 |
| `sidecar/app.py` | 2 | Python FastAPI embedding service | ~100 |
| `sidecar/requirements.txt` | 2 | Python deps | ~5 |
| `test/bm25.test.ts` | 1 | BM25 tests | ~150 |
| `test/chunker.test.ts` | 1 | Chunker tests | ~80 |
| `test/vector-index.test.ts` | 2 | Vector index tests | ~80 |
| `test/embedding-client.test.ts` | 2 | Embedding client tests | ~100 |
| `test/sidecar-manager.test.ts` | 2 | Sidecar manager tests | ~100 |
| `test/scrapling-bridge.test.ts` | 3 | Scrapling bridge tests | ~120 |
| `test/hybrid-search.test.ts` | 4 | Integration tests | ~120 |

### Modified Files (5)

| File | Phase | Changes |
|------|-------|---------|
| `src/native-tools.ts` | 1, 2, 3 | Replace `scoreText`, `chunkText`, `fetchReadablePage`; wire BM25 + embedding + Scrapling into `semanticCrawl` |
| `src/local-config.ts` | 3 | Add `scrapling.*` and `embedding.*` config mappings |
| `src/cli-backend.ts` | 3 | Add new env vars to `allowed` array |
| `.env.example` | 3 | Add `PI_SEARCH_SCRAPLING_*` and `PI_SEARCH_EMBEDDING_*` vars |
| `test/fusion.test.ts` | 4 | Add BM25+embedding RRF fusion test |

### No Changes Needed

| File | Reason |
|------|--------|
| `src/fusion.ts` | Reused as-is (rrfMerge already correct) |
| `src/http.ts` | Reused as-is (fallback path only) |
| `src/index.ts` | `buildFetchRoute` routes to `semanticCrawl` — no route changes needed |
| `src/tool-output.ts` | Reused as-is |
| `src/retry.ts` | Reused as-is |
| `package.json` | Zero new npm deps |
| `test/contract.test.ts` | Tool names unchanged |

---

## Dependencies Between Phases

```
Phase 1 (BM25 + Chunker) ──── independent, no deps
    │
    ├── Phase 2 (Embedding) ──── depends on Phase 1 (BM25 used in fusion)
    │
    └── Phase 3 (Scrapling) ──── independent of Phase 2, depends on Phase 1
         │
         └── Phase 4 (Integration) ──── depends on Phases 1, 2, 3
```

Phase 2 and Phase 3 are parallelizable but should be done sequentially by single writer to avoid merge conflicts in `src/native-tools.ts`.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Python not installed on user machine | Scrapling + embeddings unavailable | Graceful degradation; document requirement clearly |
| `sentence-transformers` model download blocks first run | Slow first embedding request | Pre-warm model on sidecar start; document `--preload` flag |
| Scrapling Python API changes | Bridge breaks | Pin scrapling version in docs; health check validates |
| BM25 memory for very large crawls | OOM if maxPages=25, all large pages | In-memory fine for < 10K chunks; typical crawl < 1K chunks |
| Port conflict for sidecar | Sidecar fails to start | Random available port via `net.createServer` trick |
| `StealthyFetcher` slow | Crawl takes longer | Use `Fetcher` for static sites; `StealthyFetcher` only when needed |
| Duplicate env var prefixes | Confusion with `EMBEDDING_SIDECAR_*` | `PI_SEARCH_EMBEDDING_*` distinct from `EMBEDDING_SIDECAR_*`; documented |
| Test instability from subprocess mocking | Flaky tests | Use fake/mock subprocess; no real Python in unit tests |
| Chunker splits mid-word on URLs/code | Broken chunks | Sentence-boundary regex is conservative; falls back to paragraph/fixed |
