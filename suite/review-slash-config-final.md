# Review: slash-command conversion, config.json reuse, bootstrap install gates, tool-name stability

Repo: `/Users/rhinesharar/pi-extension-search-mcp`
Scope: uncommitted working-tree diff — 9 modified files (`README.md`, `SKILL.md`, `src/cli-backend.ts`, `src/cli.ts`, `src/index.ts`, `src/reach-tools.ts`, `test/backend.test.ts`, `test/cli.test.ts`, `test/native-tools.test.ts`) + 4 untracked files (`src/bootstrap.ts`, `src/local-config.ts`, `test/bootstrap.test.ts`, `test/local-config.test.ts`). The prior in-tree draft `suite/review-config-reuse-bootstrap.md` (untracked, from an earlier diff state) was superseded by this diff and is not part of HEAD.
Mode: review only — no files were edited.

## Diff summary

- `src/index.ts`: `reach_status` is no longer a registered agent tool. It (and the new `reach_setup`) are exposed as Pi slash commands via `pi.registerCommand('reach-status', …)` and `pi.registerCommand('reach-setup', …)`. Extension load now calls `loadSearchMcpEnvironment(process.env)`, builds the backend from the merged env, and fires `ensureFirstStartBootstrap(env)` (fire-and-forget). Only 7 tools remain registered in `index.ts` (`web_search`, `semantic_crawl`, `browse`, `research_sources`, `social`, `video`, `feeds`) plus `github` via `registerGitHubTool`.
- `src/local-config.ts` (new): maps `search-mcp` config keys → env vars; existing env wins; `loadedConfigSummary` returns key **names** only.
- `src/bootstrap.ts` (new): first-start bootstrap state machine + `callSetupTool` (`status`/`plan`/`install_core`/`install_all`/`install_channels`); install_core/install_all gated on `PI_SEARCH_ALLOW_INSTALL=1`.
- `src/cli.ts`: CLI runs through `loadSearchMcpEnvironment`; `config` command adds `localConfig` summary.
- `src/cli-backend.ts`, `src/reach-tools.ts`: env allowlists expanded with the mapped service keys.
- Docs/tests updated to describe `/reach-status`, `/reach-setup` as slash commands and to cover setup gating.

Validation run:
- `npm test` → 45/45 pass, 0 fail.
- `npm run typecheck` (`tsc --noEmit`) → clean.
- `npm run cli -- config` (with `SEARCH_MCP_CONFIG_PATH=/Users/rhinesharar/search-mcp/config.json`) → `localConfig.mappedKeys` lists key names only; no secret values present.

---

## Blockers

### B1 — `safe` bootstrap mode runs the `agent-reach install` verb without the `PI_SEARCH_ALLOW_INSTALL=1` gate
- **File:** `src/bootstrap.ts:119-122` (`runBootstrapMode`)
- `install_core`/`install_all` are gated: `if (env.PI_SEARCH_ALLOW_INSTALL !== '1') return { status: 'warn', … }` before spawning (`src/bootstrap.ts:112-116`). The `/reach-setup` tool path is likewise gated via `runAgentReachInstall` (`src/bootstrap.ts:137-145`), and is tested (`test/native-tools.test.ts`, `test/cli.test.ts`, `test/bootstrap.test.ts`).
- The `safe` mode branch is **outside** that guard and runs `agent-reach install --env=auto --safe` directly with no allow check:
  ```ts
  if (mode === 'safe') {
    const result = await runCommand('agent-reach', ['install', '--env=auto', '--safe'], { env }, 300_000);
    return commandStatus(result, 'agent-reach install --env=auto --safe');
  }
  ```
- **Contradicts the documented invariant.** `README.md:73` states: "On first extension startup, a check-only bootstrap runs once … It does not install packages … To opt into startup installation, set `PI_SEARCH_BOOTSTRAP=install_core` or `PI_SEARCH_BOOTSTRAP=install_all`; install actions require `PI_SEARCH_ALLOW_INSTALL=1`." Yet `PI_SEARCH_BOOTSTRAP=safe` (listed as a valid mode at `README.md:83`) silently invokes the `install` verb on first start with no double-gate. The only install entrypoints documented as requiring the gate are `install_core`/`install_all`; `safe` is undocumented as performing install and is not gated.
- **Effect:** A user setting `PI_SEARCH_BOOTSTRAP=safe` (a name that implies non-mutating) gets an unattended `agent-reach install …` run on first start, bypassing the very gate the README says all install actions require. Two install entrypoints (`install_core`/`install_all` vs `safe`) have inconsistent safety posture, and `safe` is the more permissive one despite its name.
- **No test covers `safe` mode** (`grep -rn 'safe' test/` returns nothing mode-related), so the bypass is unguarded by regression coverage.
- **Severity:** blocker — gate inconsistency in a focus area (bootstrap install gates); either gate `safe` behind `PI_SEARCH_ALLOW_INSTALL=1` like the other install modes, drop the `install` verb from `safe` (use `doctor`/`plan` instead), or document `safe` as an install action and require the gate.

---

## Medium

### M1 — Three independent env allowlists have diverged (no shared source of truth)
- **Files:** `src/cli-backend.ts:95-145` (`buildCliEnvironment`), `src/reach-tools.ts:594-604` (`externalEnvironment`), `src/bootstrap.ts:190-200` (`setupEnvironment`)
- Confirmed divergence in the current diff:
  - `setupEnvironment` (bootstrap) uniquely has `GROQ_API_KEY`, `OPENAI_API_KEY`; absent from the other two.
  - `setupEnvironment` is missing keys present in `buildCliEnvironment`: `BROWSER_*` (4), `EMBEDDING_SIDECAR_*` (5), `SEARCH_LLM_*` (3), `OLLAMA_SEARCH_*` (2), `SEARXNG_BASE_URL`, `NITTER_BASE_URL`, `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `DEEP_RESEARCH_WORKER_BASE_URL`, `DEEP_RESEARCH_WORKER_MODEL`, `SEARCH_MCP_CONFIG_PATH`, and all `*_BACKEND` / `PI_SEARCH_*_BACKEND` overrides.
  - `externalEnvironment` (reach-tools) lacks `GROQ_API_KEY`/`OPENAI_API_KEY`, `BROWSER_*`, `EMBEDDING_SIDECAR_*`, `SEARCH_LLM_*`, `OLLAMA_SEARCH_*`.
- **Risk:** A key added to `local-config.ts` mappings or one allowlist may be forgotten in the others → latent under-exposure for a backend that needs it (a mapped config value silently not forwarded to the subprocess that consumes it), or over-exposure if a broad key is added carelessly. No test asserts the three lists share a common base.
- **Severity:** medium — maintainability + latent correctness.

### M2 — `/reach-setup install_channels` joins channel args with a space, not a comma
- **File:** `src/index.ts:179-182` (`/reach-setup` handler)
- `const [action = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean); const params = { action, ...(rest.length ? { channels: rest.join(',') } : {}) };`
- Wait — re-reading: `rest.join(',')` is used, so `install_channels twitter,reddit` → `channels='twitter,reddit'` (correct) and `install_channels twitter reddit` → `channels='twitter,reddit'` (also comma-joined). The handler actually joins with `,`, so this is fine. **Downgraded — not an issue.** (Recorded here only because it was checked.)

### M3 — Hardcoded machine-specific absolute config path in source
- **File:** `src/local-config.ts:3` → `DEFAULT_SEARCH_MCP_CONFIG_PATH = '/Users/rhinesharar/search-mcp/config.json'`
- Baked into shipped source. `existsSync` gives a graceful no-op on machines where the path is absent (no error), so it does not break elsewhere — but config reuse is silently inactive everywhere except this one machine unless `SEARCH_MCP_CONFIG_PATH` is set.
- Documented as intentional for "this local setup" (`README.md`), overridable via `SEARCH_MCP_CONFIG_PATH`. The task explicitly accepts `/Users/rhinesharar/search-mcp/config.json` reuse as in-scope, so this is a portability note rather than a defect.
- **Severity:** medium (portability smell, accepted by scope).

---

## Low

### L1 — `config.json` is read + parsed twice per `cli config` invocation
- **File:** `src/cli.ts:19` (`loadSearchMcpEnvironment`) and `src/cli.ts:74` (`configResult` → `loadedConfigSummary`) each independently `readFileSync` + `JSON.parse` the same file. Not cached.
- **Severity:** low (perf only).

### L2 — Fire-and-forget bootstrap can surface unhandled rejection
- **File:** `src/index.ts:45` → `void ensureFirstStartBootstrap(env)`. `ensureFirstStartBootstrap` wraps `runBootstrapMode` in try/catch, but `writeState`/`safeWriteState` paths and the `runCommand` spawn can still reject outside the caught region; the `void` discards the promise.
- **Severity:** low.

### L3 — Dynamic `import('./reach-tools.js')` on every `/reach-status` invocation
- **File:** `src/index.ts:188-191` (`callSetupOrStatus`). A dynamic import is awaited each time the slash command runs rather than importing `callReachTool` statically at top. Functionally fine; minor latency/overhead.
- **Severity:** low.

---

## Preserved / positive (focus-area confirmations)

- **reach-status/reach-setup are slash commands, not agent tools.** `grep "name: 'reach_status'|name: 'reach_setup'" src/` → no tool registrations. `index.ts` registers exactly 7 tools via `pi.registerTool` (web_search, semantic_crawl, browse, research_sources, social, video, feeds) + github via `registerGitHubTool`. `reach_status`/`reach_setup` are registered only via `pi.registerCommand('reach-status', …)` / `pi.registerCommand('reach-setup', …)` (`src/index.ts:163-186`). The command handler signatures match `ExtensionCommandContext` (`handler: (args: string, ctx) => Promise<void>`, `ctx.hasUI`, `ctx.ui.editor`, `ctx.ui.notify`, `ctx.signal` — all present in `node_modules/@earendil-works/pi-coding-agent` types). `SKILL.md` and `README.md` "Public Pi tool names" list no longer include `reach_status`; the workflow text now points users to `/reach-status`. The CLI `call reach_status` / `call reach_setup` paths remain for internal use and tests but are not LLM-exposed tools.
- **config.json reuse is key-only/redacted and safe.** `loadedConfigSummary` returns `mappedKeys` as **key names only** (`src/local-config.ts:58-67`); verified by running `npm run cli -- config` — output lists env-var names, no `ghp_…`/`tvly-…`/Exa UUID/Brave key values appear. The `status` CLI command (`src/cli.ts:48-57`) exposes no env values. `reachStatus` (`src/reach-tools.ts:90-101`) reports channel metadata, status, `active_backend` **names**, and truncated external-CLI probe stderr/stdout — never config secret values. `loadSearchMcpEnvironment` builds a new merged object (`{ ...env, SEARCH_MCP_CONFIG_PATH }`) and does not mutate `process.env`; existing env wins (`if (merged[key]) continue`, `src/local-config.ts:51`). `isUsableScalar` now rejects `"null"`/`"undefined"`/empty placeholders (`src/local-config.ts:87-93`), so placeholder tokens (e.g. `llm.apiToken: "null"`) are not mapped — confirmed: `mappedKeys` excludes `SEARCH_LLM_API_TOKEN`, `CRAWL4AI_API_TOKEN`, `DEEP_RESEARCH_API_TOKEN`, `EMBEDDING_SIDECAR_API_TOKEN` for the live config. Malformed/non-object config degrades gracefully via try/catch in `readJsonConfig` (`src/local-config.ts:69-78`), tested in `test/local-config.test.ts`.
- **Bootstrap install gates (install_core / install_all) — prior blockers resolved.** The earlier draft flagged a hyphen/underscore `install-all` mismatch and a missing `PI_SEARCH_ALLOW_INSTALL` gate on bootstrap installs. Both are fixed in this diff: `bootstrapInstallArgs` (`src/bootstrap.ts:131-135`) accepts both `install_all` and `install-all`; `runBootstrapMode` (`src/bootstrap.ts:111-117`) gates `install_core`/`install_all` behind `PI_SEARCH_ALLOW_INSTALL !== '1'` → returns `warn`. The `/reach-setup` install path is gated via `runAgentReachInstall` (`src/bootstrap.ts:137-145`) and covered by `test/native-tools.test.ts`, `test/cli.test.ts`, `test/bootstrap.test.ts`. Default bootstrap is check-only (`agent-reach doctor --json`, no install/browser/cookies/login); `off`/`0`/`false` disables; state file written `0o600` with dir `0o700`. **(B1 above is a new, separate gap: the `safe` mode bypasses this gate.)**
- **Existing tool names stable.** `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`, `social`, `video`, `feeds` retain identical names and registrations; `reach_status` was intentionally converted from a tool to a slash command (not renamed); `reach_setup` is additive as a slash command. No tool was renamed or had its parameter schema narrowed.

---

## Residual risks

- **B1 unguarded `safe` install path has no regression test** — a future change could keep it ungated silently.
- **Live secrets in a world-readable file.** `/Users/rhinesharar/search-mcp/config.json` is mode `0644` and contains real secrets (GitHub PAT, Exa, Brave, Tavily, ProductHunt, YouTube keys — several mapped successfully). This extension now loads them by default into its process env and forwards a subset to spawned children, expanding the set of processes that hold these secrets. Recommend `chmod 0600 config.json`. (Pre-existing condition of the search-mcp repo, not introduced by this diff, but the reuse widens exposure.)
- **Allowlist drift (M1) is undetected by tests** — no assertion that the three allowlists share a common base or that every newly mapped config key is reachable in every context that needs it.
- **`safe` mode semantics depend on external `agent-reach --safe` behavior** — the code assumes `--safe` is non-mutating, but it still issues the `install` verb; if `agent-reach`'s `--safe` ever performs real installs, the ungated path becomes a silent unattended install on first start.
- **No test covers corrupt/invalid `config.json` at the `index.ts` extension-load site** specifically (only the `loadSearchMcpEnvironment` unit path is tested); the throw is now caught inside `readJsonConfig`, but end-to-end extension-load resilience is untested.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings with file paths and severities: blocker B1 src/bootstrap.ts:119-122 (safe mode bypasses PI_SEARCH_ALLOW_INSTALL gate); medium M1 cli-backend.ts:95-145 + reach-tools.ts:594-604 + bootstrap.ts:190-200 (three diverged env allowlists); medium M3 local-config.ts:3 (hardcoded absolute path, accepted by scope); low L1-L3; plus positive confirmations for all four focus areas (slash-command conversion, key-only config reuse, install gates, tool-name stability) with commands run and CLI output verified."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "45/45 tests pass, 0 fail (node:test)"
    },
    {
      "command": "npm run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit clean"
    },
    {
      "command": "npm run cli -- config (SEARCH_MCP_CONFIG_PATH=/Users/rhinesharar/search-mcp/config.json)",
      "result": "passed",
      "summary": "localConfig.mappedKeys lists env-var names only; no secret values present in output"
    },
    {
      "command": "grep \"name: 'reach_status'|name: 'reach_setup'\" src/",
      "result": "passed",
      "summary": "no agent tool registrations for reach_status/reach_setup; only pi.registerCommand slash commands exist"
    },
    {
      "command": "diff of allowlist literals across cli-backend.ts/reach-tools.ts/bootstrap.ts",
      "result": "passed",
      "summary": "confirmed three env allowlists diverged (GROQ/OPENAI only in bootstrap; BROWSER/EMBEDDING/LLM/OLLAMA/SEARXNG/NITTER/LISTENNOTES/PRODUCTHUNT/PATENTSVIEW missing from bootstrap)"
    },
    {
      "command": "grep -rn 'safe' test/",
      "result": "passed",
      "summary": "no test covers safe bootstrap mode (B1 gap confirmed)"
    }
  ],
  "validationOutput": [
    "npm test: tests 45, pass 45, fail 0",
    "tsc --noEmit: no errors",
    "cli config: localConfig.mappedKeys = key names only (BRAVE_API_KEY, EXA_API_KEY, TAVILY_API_KEY, GITHUB_TOKEN, YOUTUBE_API_KEY, ...); no secret values in output",
    "Placeholder tokens (llm.apiToken='null', crawl4ai/deepResearch/embeddingSidecar apiToken) correctly NOT mapped by isUsableScalar",
    "Only 7 pi.registerTool calls in index.ts (web_search, semantic_crawl, browse, research_sources, social, video, feeds); reach_status/reach_setup are pi.registerCommand only",
    "bootstrap install_core/install_all gated by PI_SEARCH_ALLOW_INSTALL (prior blockers resolved); safe mode is the new ungated install-verb path (B1)"
  ],
  "residualRisks": [
    "B1: safe bootstrap mode runs agent-reach install ungated and has no regression test",
    "config.json is world-readable (0644) with live secrets; extension now loads them by default, widening exposure — recommend chmod 0600",
    "Three env allowlists diverged (M1); no test detects drift",
    "safe mode install behavior depends on external agent-reach --safe semantics; if --safe ever mutates, ungated path becomes silent unattended install",
    "No end-to-end test for corrupt config.json at extension-load site"
  ],
  "noStagedFiles": true,
  "diffSummary": "Converts reach_status from an agent tool to /reach-status and /reach-setup slash commands (pi.registerCommand), adds config.json->env mapping (src/local-config.ts, key-names-only summary), adds first-start bootstrap + reach_setup with PI_SEARCH_ALLOW_INSTALL gating for install_core/install_all (src/bootstrap.ts), and expands three env allowlists. 9 modified + 4 new files. Prior blockers (install_all hyphen mismatch, missing bootstrap install gate) are resolved; new blocker: safe bootstrap mode bypasses the install gate.",
  "reviewFindings": [
    "blocker: src/bootstrap.ts:119-122 - runBootstrapMode 'safe' branch runs 'agent-reach install --env=auto --safe' without the PI_SEARCH_ALLOW_INSTALL=1 gate that install_core/install_all enforce (lines 112-116) and that README.md:73 says all install actions require; safe mode is undocumented as performing install (README.md:83) and has no test coverage",
    "medium: src/cli-backend.ts:95-145 + src/reach-tools.ts:594-604 + src/bootstrap.ts:190-200 - three independent env allowlists have diverged (GROQ_API_KEY/OPENAI_API_KEY only in bootstrap; BROWSER_*/EMBEDDING_SIDECAR_*/SEARCH_LLM_*/OLLAMA_SEARCH_*/SEARXNG/NITTER/LISTENNOTES/PRODUCTHUNT/PATENTSVIEW/SEARCH_MCP_CONFIG_PATH missing from bootstrap); no shared source of truth, no drift test",
    "medium: src/local-config.ts:3 - hardcoded absolute path /Users/rhinesharar/search-mcp/config.json is non-portable; graceful existsSync no-op elsewhere but silently inactive off this machine; accepted by task scope, overridable via SEARCH_MCP_CONFIG_PATH",
    "low: src/cli.ts:19 + src/cli.ts:74 - config.json read+parsed twice per cli config invocation (loadSearchMcpEnvironment + loadedConfigSummary), not cached",
    "low: src/index.ts:45 - void ensureFirstStartBootstrap(env) is fire-and-forget; writeState/spawn rejections outside the inner try/catch surface as unhandled rejections",
    "low: src/index.ts:188-191 - callSetupOrStatus dynamic-imports ./reach-tools.js on every /reach-status invocation instead of a static top-level import",
    "positive: reach-status/reach-setup are slash commands not agent tools - only 7 pi.registerTool calls remain (web_search, semantic_crawl, browse, research_sources, social, video, feeds) + github; reach_status/reach_setup registered only via pi.registerCommand with ExtensionCommandContext-correct signatures",
    "positive: config.json reuse is key-only/redacted and safe - loadedConfigSummary returns key names only (verified via cli config); isUsableScalar rejects null/undefined/empty placeholders so placeholder tokens are not mapped; readJsonConfig catches malformed JSON; process.env not mutated; existing env wins",
    "positive: bootstrap install gates for install_core/install_all are correct (prior blockers resolved) - bootstrapInstallArgs accepts install_all+install-all, runBootstrapMode gates on PI_SEARCH_ALLOW_INSTALL!=1, reach_setup gated via runAgentReachInstall; default check-only; state 0o600/dir 0o700",
    "positive: existing tool names stable - web_search, semantic_crawl, browse, research_sources, github, social, video, feeds unchanged; reach_status converted (not renamed) to slash command; reach_setup additive as slash command; no schema narrowing"
  ],
  "manualNotes": "Review-only run; no files edited. The single blocker (B1) is localized to src/bootstrap.ts:119-122: the 'safe' branch should be gated behind PI_SEARCH_ALLOW_INSTALL=1 like install_core/install_all, or changed to a non-install verb (doctor/plan), or documented as a gated install action. The prior draft's two blockers (install_all hyphen, missing bootstrap gate) are both fixed in this diff. Highest-value follow-ups after B1: add a test for safe-mode gating and a shared allowlist constant (M1). The hardcoded config path (M3) is accepted per task scope but worth flagging for portability."
}
```