# Review: config.json reuse, first-start bootstrap, env allowlists, tool-name preservation

Repo: `/Users/rhinesharar/pi-extension-search-mcp`
Scope: uncommitted working-tree diff (9 modified + 3 untracked files) plus the target config at `/Users/rhinesharar/search-mcp/config.json`.
Mode: review only — no files were edited.

## Diff summary

New files: `src/local-config.ts` (maps search-mcp config keys → env vars), `src/bootstrap.ts` (first-start bootstrap + `reach_setup` tool handler), `test/local-config.test.ts`.
Modified: `src/index.ts` (loads config env, registers `reach_setup` tool, fires bootstrap), `src/cli.ts` (loads config env for CLI, adds `localConfig` summary to `config`), `src/cli-backend.ts` (expands CLI env allowlist), `src/reach-tools.ts` (routes `reach_setup`, expands external CLI allowlist), `test/backend.test.ts`, `test/cli.test.ts`, `test/native-tools.test.ts`, `README.md`, `SKILL.md`.

Validation run:
- `npm test` → 40/40 pass.
- `npm run typecheck` (`tsc --noEmit`) → clean.

---

## Blockers

### B1 — `install_all` bootstrap mode is broken (hyphen vs underscore mismatch)
- **File:** `src/bootstrap.ts:110`
- `runBootstrapMode` guards with `if (mode === 'install_core' || mode === 'install-all')` — note the **hyphen** in `install-all`.
- Every other surface uses the **underscore** form `install_all`:
  - `SetupAction` type: `src/bootstrap.ts:7` → `'install_all'`
  - `callSetupTool` switch: `src/bootstrap.ts:84` → `case 'install_all'`
  - `index.ts:174` tool parameter enum → `'install_all'`
  - `README.md:68` and `README.md:78` → `PI_SEARCH_BOOTSTRAP=install_all`
- **Effect:** Setting `PI_SEARCH_BOOTSTRAP=install_all` does NOT run `agent-reach install --channels=all` during bootstrap. `'install_all' !== 'install_core'` and `'install_all' !== 'install-all'`, so the guard is false and execution falls through `safe` (also false) into the default `agent-reach doctor --json` check-only branch. The documented "opt into startup installation" via `install_all` silently performs a doctor check instead.
- **Empirically confirmed:** `'install_all' matches install guard? false`.
- **Severity:** blocker — documented feature does not behave as specified; either the guard literal or the docs/enum must change.

### B2 — Bootstrap install modes bypass the `PI_SEARCH_ALLOW_INSTALL=1` gate
- **File:** `src/bootstrap.ts:109-114` (`runBootstrapMode`)
- The `reach_setup` *tool* path gates installs via `runAgentReachInstall` (`src/bootstrap.ts:128-136`): it returns `status: 'blocked'` unless `options.env?.PI_SEARCH_ALLOW_INSTALL === '1'`. This is tested (`test/native-tools.test.ts`, `test/cli.test.ts`).
- The *bootstrap* path does NOT apply this gate. For `install_core` (which does match the guard at line 110) it directly calls `runCommand('agent-reach', ['install', '--env=auto'], { env }, 300_000)` with no `PI_SEARCH_ALLOW_INSTALL` check.
- `README.md:68` states "install actions still require `PI_SEARCH_ALLOW_INSTALL=1` when invoked through `reach_setup`" — but bootstrap installs require no such confirmation.
- **Effect:** A single env var (`PI_SEARCH_BOOTSTRAP=install_core`) triggers unattended package installation on first start, with no double-gate. The two install entrypoints have inconsistent safety posture.
- **Severity:** blocker — safety inconsistency between the two install paths; bootstrap install lacks the confirmation gate that the tool path enforces.

---

## Medium

### M1 — Corrupt/invalid `config.json` crashes extension load (uncaught throw)
- **Files:** `src/local-config.ts:69-76` (`readJsonConfig`), consumed at `src/index.ts:43` (`loadSearchMcpEnvironment(process.env)`)
- `readJsonConfig` throws `new Error('Search MCP config must be a JSON object: ...')` on non-object JSON, and `JSON.parse` throws on malformed JSON. `loadSearchMcpEnvironment` does not catch — it only handles the file-not-exists case (`existsSync` → return `undefined`).
- In `index.ts` this runs inside the extension entry function, so a malformed `config.json` aborts tool registration for the whole extension.
- **Severity:** medium — should degrade to env-only with a warning instead of throwing.

### M2 — Three independent env allowlists have diverged
- **Files:** `src/cli-backend.ts:84` (`buildCliEnvironment`), `src/reach-tools.ts:593` (`externalEnvironment`), `src/bootstrap.ts:180` (`setupEnvironment`)
- Each maintains its own literal array. Confirmed divergence:
  - `setupEnvironment` (bootstrap) has `GROQ_API_KEY`, `OPENAI_API_KEY` — absent from the other two.
  - `setupEnvironment` is missing (present in `buildCliEnvironment`): `BROWSER_*`, `EMBEDDING_SIDECAR_*`, `SEARCH_LLM_*`, `OLLAMA_SEARCH_*`, `SEARXNG_BASE_URL`, `NITTER_BASE_URL`, `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `SEARCH_MCP_CONFIG_PATH`, all `*_BACKEND` / `PI_SEARCH_*_BACKEND` overrides.
  - `externalEnvironment` (reach-tools) has yet another subset (e.g. has `SEARXNG_BASE_URL`, `NITTER_BASE_URL`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`; lacks `BROWSER_*`, `EMBEDDING_SIDECAR_*`, `SEARCH_LLM_*`, `OLLAMA_SEARCH_*`).
- **Risk:** No shared source of truth → a key added to one allowlist may be forgotten in others (latent under-exposure for a backend that needs it, or over-exposure if a broad key is added carelessly). The three lists should derive from a common constant with per-context additions.
- **Severity:** medium — maintainability + latent correctness.

### M3 — Hardcoded absolute config path is non-portable
- **File:** `src/local-config.ts:3` → `DEFAULT_SEARCH_MCP_CONFIG_PATH = '/Users/rhinesharar/search-mcp/config.json'`
- Baked into source. `existsSync` provides a graceful no-op fallback on machines where the path does not exist, so it does not error elsewhere — but it silently does not load config anywhere except this one machine.
- Documented as intentional for "this local setup" (`README.md`), and overridable via `SEARCH_MCP_CONFIG_PATH`. Still, a machine-specific absolute path in shipped source is a portability smell.
- **Severity:** medium.

---

## Low

### L1 — Config file read multiple times per CLI invocation
- `src/cli.ts:19` calls `loadSearchMcpEnvironment` (reads + parses config); `src/cli.ts:74` `configResult` calls `loadedConfigSummary` (reads + parses the same file again). The `config` command reads the file twice. Not cached.
- **Severity:** low (perf only).

### L2 — String `"null"` accepted as a valid token value
- `src/local-config.ts:85-88` `isUsableScalar` accepts any non-empty string. The live config has `"apiToken": "null"` (a placeholder), so `SEARCH_LLM_API_TOKEN` would be set to the literal string `"null"`.
- **Severity:** low (data quality, not a secret leak).

### L3 — Fire-and-forget bootstrap can surface unhandled rejection
- `src/index.ts:45` → `void ensureFirstStartBootstrap(env)`. The function wraps `runBootstrapMode` in try/catch, but `writeState` (`src/bootstrap.ts:211-214`, does `mkdir`/`writeFile`) can throw on disk/permission errors; that rejection is unhandled.
- **Severity:** low.

---

## Preserved / positive

- **Existing tool names preserved.** `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`, `reach_status`, `social`, `video`, `feeds` are unchanged. `reach_setup` is purely additive; routing is correct end-to-end (`index.ts` → `CliSearchBackend` → `cli.ts call reach_setup` → `callNativeTool` → `callReachTool` → `callSetupTool`).
- **No secret values leak in outputs.** `loadedConfigSummary` returns key **names** only (`mappedKeys: ['BRAVE_API_KEY', ...]`), never values. Verified by running `npm run cli -- config`: output lists `mappedKeys` names only; no `ghp_…`/`tvly-dev-…`/Exa UUID appears. `status` output exposes no secrets. No `console.*` of env/config/secrets anywhere in `src/`.
- **`loadSearchMcpEnvironment` does not mutate `process.env`.** It builds a new merged object (`{ ...env, SEARCH_MCP_CONFIG_PATH }`); existing env wins (`if (merged[key]) continue`).
- **Safe default bootstrap.** Default `PI_SEARCH_BOOTSTRAP=check` runs `agent-reach doctor --json` only — no install, no browser, no cookies, no login. `off`/`0`/`false` disables entirely. State file `~/.pi-extension-search/bootstrap.json` written with `0o600` perms, dir `0o700`.
- **`reach_setup` install actions gated.** `runAgentReachInstall` returns `blocked` unless `PI_SEARCH_ALLOW_INSTALL=1`; covered by `test/native-tools.test.ts` and `test/cli.test.ts`.
- **Subprocess env is allowlisted.** Both `externalEnvironment` (reach-tools) and `setupEnvironment` (bootstrap) filter to a safe subset before spawning external commands — no full parent-env passthrough. `buildCliEnvironment` likewise allowlists for the CLI child.
- **Tests & typecheck green.** 40/40 tests pass; `tsc --noEmit` clean.

---

## Residual risks

- **Live secrets in a world-readable file.** `/Users/rhinesharar/search-mcp/config.json` is mode `0644` and contains real secrets (GitHub PAT `ghp_…`, Exa key, Brave key, Tavily key, ProductHunt token, YouTube API key — 3+ confirmed secret-prefix matches). This is a pre-existing condition of the search-mcp repo, but this extension now loads them by default into its process env and forwards a subset to spawned children, expanding the set of processes that hold these secrets. Recommend `chmod 0600 config.json`.
- **No test covers the `install_all` bootstrap dispatch** (the B1 hyphen bug). Tests only assert `reach_setup install_core` blocking, not bootstrap install modes.
- **No test covers corrupt/invalid `config.json` handling** (M1). A malformed config would throw at extension load with no regression test guarding the graceful-degradation path.
- **Allowlist drift is undetected by tests** (M2). There is no assertion that the three allowlists share a common base or that a newly mapped config key is reachable in every context that needs it.

---

acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Findings include file paths + severities: B1 src/bootstrap.ts:110 (blocker), B2 src/bootstrap.ts:109-114 (blocker), M1 src/local-config.ts:69-76 (medium), M2 cli-backend.ts:84/reach-tools.ts:593/bootstrap.ts:180 (medium), M3 src/local-config.ts:3 (medium), L1-L3 (low); plus preserved-name and no-leak verifications with commands run."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "40/40 tests pass (node:test)"
    },
    {
      "command": "npm run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit clean"
    },
    {
      "command": "npm run cli -- config",
      "result": "passed",
      "summary": "config output shows mappedKeys names only; no secret values leaked"
    },
    {
      "command": "grep -n 'install.all' src/bootstrap.ts",
      "result": "passed",
      "summary": "confirmed line 110 uses hyphen 'install-all' vs underscore 'install_all' elsewhere"
    },
    {
      "command": "diff of allowlist literals across cli-backend.ts/bootstrap.ts/reach-tools.ts",
      "result": "passed",
      "summary": "confirmed three env allowlists have diverged (GROQ/OPENAI only in bootstrap; BROWSER/EMBEDDING/LLM/OLLAMA missing from bootstrap)"
    }
  ],
  "validationOutput": [
    "npm test: tests 40, pass 40, fail 0",
    "tsc --noEmit: no errors",
    "config CLI: mappedKeys are key names only, no secret values present",
    "install_all guard check: 'install_all' matches install guard? false (B1 confirmed)"
  ],
  "residualRisks": [
    "config.json is world-readable (0644) with live secrets; extension now loads them by default — recommend chmod 0600",
    "No test covers the install_all bootstrap dispatch (B1 hyphen bug)",
    "No test covers corrupt/invalid config.json handling (M1)",
    "Allowlist drift across three files is undetected by tests (M2)"
  ],
  "noStagedFiles": true,
  "diffSummary": "Adds config.json→env mapping (src/local-config.ts), first-start bootstrap + reach_setup tool (src/bootstrap.ts), reach_setup registration/routing, and expands three env allowlists; 9 modified + 3 new files, +114/-5 lines.",
  "reviewFindings": [
    "blocker: src/bootstrap.ts:110 - runBootstrapMode checks 'install-all' (hyphen) but SetupAction/README/index.ts use 'install_all' (underscore); PI_SEARCH_BOOTSTRAP=install_all silently runs doctor instead of install",
    "blocker: src/bootstrap.ts:109-114 - bootstrap install_core spawns agent-reach install WITHOUT the PI_SEARCH_ALLOW_INSTALL=1 gate that reach_setup installs require; inconsistent safety between install entrypoints",
    "medium: src/local-config.ts:69-76 - readJsonConfig throws on invalid/non-object JSON; loadSearchMcpEnvironment does not catch, so corrupt config.json crashes extension load in index.ts:43",
    "medium: src/cli-backend.ts:84 + src/reach-tools.ts:593 + src/bootstrap.ts:180 - three independent env allowlists have diverged (GROQ/OPENAI only in bootstrap; BROWSER/EMBEDDING/LLM/OLLAMA/SEARXNG/NITTER/LISTENNOTES/PRODUCTHUNT/PATENTSVIEW missing from bootstrap); no shared source of truth",
    "medium: src/local-config.ts:3 - hardcoded absolute path /Users/rhinesharar/search-mcp/config.json is non-portable; graceful no-op fallback via existsSync but silently inactive elsewhere",
    "low: src/cli.ts:19,74 - config.json read twice per CLI config invocation (loadSearchMcpEnvironment + loadedConfigSummary), not cached",
    "low: src/local-config.ts:85-88 - isUsableScalar accepts literal string 'null' as a token; SEARCH_LLM_API_TOKEN can be set to 'null' from config placeholder",
    "low: src/index.ts:45 - void ensureFirstStartBootstrap(env) is fire-and-forget; writeState failures (disk/permissions) surface as unhandled rejections",
    "positive: existing tool names preserved (web_search, semantic_crawl, browse, research_sources, github, reach_status, social, video, feeds); reach_setup is additive with correct end-to-end routing",
    "positive: no secret values leak - loadedConfigSummary returns key names only; config/status CLI outputs contain no secret values; no console logging of env/secrets in src/",
    "positive: loadSearchMcpEnvironment does not mutate process.env; existing env wins via if(merged[key]) continue",
    "positive: default bootstrap is check-only (doctor, no install/browser/cookies/login); state file written 0o600 with dir 0o700",
    "positive: reach_setup install actions gated by PI_SEARCH_ALLOW_INSTALL=1 (tested); external/bootstrap subprocesses use allowlisted env (no full passthrough)"
  ],
  "manualNotes": "Review-only run; no files edited. Blockers B1 and B2 both sit in src/bootstrap.ts and should be resolved together: align the install_all literal (hyphen→underscore) and decide whether bootstrap installs must also honor PI_SEARCH_ALLOW_INSTALL=1 (recommended for parity with reach_setup). M1 and the missing tests for bootstrap-install dispatch and corrupt-config handling are the highest-value follow-ups after the blockers."
}