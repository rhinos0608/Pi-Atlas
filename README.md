# search-mcp Pi extension

Pi extension that exposes search, crawl, browse, research, and GitHub tools through a package-local native CLI backend.

## Tools

Public Pi tool names stay stable:

- `web_search` — native web search with collated source findings
- `semantic_crawl` — native URL/search crawl with relevant text chunks
- `browse` — native URL fetch/readable text extraction
- `research_sources` — native academic/community/public-source search
- `github` — native GitHub repository, file, tree, search, trending, and code search actions
- `social` — Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, and Instagram read/search family
- `video` — YouTube and Bilibili search/metadata/subtitle family
- `feeds` — native RSS/Atom feed reader

## Local use

```bash
cd pi-extension-search-mcp
npm install
pi -e ./src/index.ts
```

## CLI

The extension routes tool execution through the local CLI by default.

```bash
npm run cli -- status
npm run cli -- config
npm run cli -- call browse '{"url":"https://example.com"}'
npm run cli -- call social '{"platform":"v2ex","action":"hot","limit":5}'
npm run cli -- call feeds '{"url":"https://example.com/feed.xml"}'
```

Installed package binary:

```bash
pi-extension-search status
pi-extension-search call web_search '{"query":"pi agent extensions"}'
```

CLI output is always JSON:

```json
{
  "ok": true,
  "data": {
    "content": [{ "type": "text", "text": "..." }]
  }
}
```

## Slash commands

User-facing setup/status is exposed as Pi slash commands, not LLM tools:

- `/reach-status [family]` — inspect channels/backends and active backend, e.g. `/reach-status social`
- `/reach-setup [status|plan|install_core|install_all|install_channels channels|import_cookies]` — show setup plan, run setup, or import existing browser cookies

Install actions are allowed by default for this local extension; set `PI_SEARCH_ALLOW_INSTALL=0` to opt out. Existing browser cookies are imported automatically after successful setup when available; set `PI_SEARCH_IMPORT_BROWSER_COOKIES=0` to opt out. New logins, OpenCLI Chrome extension install, QR scan, and API key entry may still require user action.

## Configuration

Default backend is native CLI. Set `SEARCH_BACKEND=mcp` to use the legacy MCP stdio adapter.

For this local setup, the extension automatically reads `/Users/rhinesharar/search-mcp/config.json` and maps known values into runtime environment variables (`GITHUB_TOKEN`, `EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `CRAWL4AI_*`, `DEEP_RESEARCH_*`, and related service keys). Existing environment variables win. Override path with `SEARCH_MCP_CONFIG_PATH`.

Agent-Reach-inspired family routing uses ordered backends per platform. Native zero-config channels run directly; login-backed platforms probe known CLIs and report `active_backend` through `/reach-status`. New family tools require the default `native-cli` backend; legacy `SEARCH_BACKEND=mcp` only supports the original search-mcp tools.

On first extension startup, bootstrap defaults to `install_all` and records status in `~/.pi-extension-search/bootstrap.json`. Set `PI_SEARCH_BOOTSTRAP=off` to disable, or `PI_SEARCH_ALLOW_INSTALL=0` to block installs. After successful install, it runs `agent-reach configure --from-browser` against local browsers to reuse existing cookies when available.

Optional MCP fallback environment variables:

- `SEARCH_BACKEND` — `native-cli` default; set `mcp` for legacy stdio backend
- `SEARCH_MCP_COMMAND` — executable to spawn for MCP fallback, default `search-mcp`
- `SEARCH_MCP_ARGS_JSON` — JSON string array of arguments, default `[]`
- `SEARCH_MCP_CWD` — working directory for the spawned MCP server
- `SEARCH_MCP_FORWARD_ENV_JSON` — JSON string array of extra environment variable names to forward to MCP fallback
- `SEARCH_MCP_CONFIG_PATH` — optional config path; default `/Users/rhinesharar/search-mcp/config.json`
- `PI_SEARCH_BOOTSTRAP` — first-start bootstrap mode: `install_all` default, `check`, `off`, `safe`, or `install_core`
- `PI_SEARCH_ALLOW_INSTALL` — set to `0`, `false`, `no`, or `off` to block install actions
- `PI_SEARCH_IMPORT_BROWSER_COOKIES` — set to `0`, `false`, `no`, or `off` to skip browser cookie import
- `PI_SEARCH_BROWSER_COOKIE_BROWSERS` — comma-separated browser import order, default `chrome,firefox,edge,brave,opera`

The MCP fallback forwards only an allowlisted environment to avoid leaking parent process secrets. External family backends also receive a small allowlist only: PATH/HOME/temp locale/proxy vars plus known platform auth vars.

Per-platform backend override examples:

- `TWITTER_BACKEND=OpenCLI`
- `PI_SEARCH_REDDIT_BACKEND=rdt`
- `BILIBILI_BACKEND=OpenCLI`

## Package contract

`package.json` declares:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
