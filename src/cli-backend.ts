import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendCallOptions, BackendCallResult, SearchBackend } from './backend.js';

interface CliEnvelope {
  ok: boolean;
  data?: BackendCallResult;
  error?: {
    code: string;
    message: string;
  };
}

export class CliSearchBackend implements SearchBackend {
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'),
  ) {}

  async callTool(name: string, args: Record<string, unknown>, options: BackendCallOptions = {}): Promise<BackendCallResult> {
    const envelope = await this.run(['call', name, JSON.stringify(args)], options.signal, options.timeout);
    if (!envelope.ok) throw new Error(envelope.error?.message ?? 'CLI backend failed');
    if (!envelope.data) throw new Error('CLI backend returned no data.');
    return envelope.data;
  }

  async close(): Promise<void> {}

  private run(args: string[], signal?: AbortSignal, timeout?: number): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', this.cliPath, ...args], {
        env: buildCliEnvironment(this.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;

      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        if (timer) clearTimeout(timer);
      };
      const abort = () => child.kill('SIGTERM');
      const timer = timeout
        ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeout)
        : undefined;

      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      child.on('close', (code) => {
        cleanup();
        const output = Buffer.concat(stdout).toString('utf8');
        const diagnostics = Buffer.concat(stderr).toString('utf8').trim();
        if (timedOut) {
          reject(new Error(`CLI backend timed out after ${timeout}ms${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        let parsed: CliEnvelope;
        try {
          parsed = JSON.parse(output) as CliEnvelope;
        } catch (error) {
          reject(new Error(`CLI backend returned invalid JSON: ${String(error)}${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        if (code !== 0 && parsed.ok) {
          reject(new Error(`CLI backend exited with code ${code ?? 1}${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        resolve(parsed);
      });
    });
  }
}

export function buildCliEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'LANG',
    'LC_ALL',
    'PYTHONIOENCODING',
    'NODE_OPTIONS',
    'GITHUB_TOKEN',
    'SEARCH_BACKEND',
    'PI_SEARCH_BOOTSTRAP',
    'PI_SEARCH_ALLOW_INSTALL',
    'PI_SEARCH_IMPORT_BROWSER_COOKIES',
    'PI_SEARCH_BROWSER_COOKIE_BROWSERS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'TWITTER_AUTH_TOKEN',
    'TWITTER_CT0',
    'OPENCLI_HOST',
    'OPENCLI_PORT',
    'OPENCLI_TOKEN',
    'BRAVE_API_KEY',
    'EXA_API_KEY',
    'TAVILY_API_KEY',
    'REDDIT_CLIENT_ID',
    'REDDIT_CLIENT_SECRET',
    'REDDIT_USER_AGENT',
    'YOUTUBE_API_KEY',
    'SEARXNG_BASE_URL',
    'NITTER_BASE_URL',
    'LISTENNOTES_API_KEY',
    'PRODUCTHUNT_API_TOKEN',
    'PATENTSVIEW_API_KEY',
    'CRAWL4AI_BASE_URL',
    'CRAWL4AI_API_TOKEN',
    'DEEP_RESEARCH_BASE_URL',
    'DEEP_RESEARCH_WORKER_BASE_URL',
    'DEEP_RESEARCH_API_TOKEN',
    'DEEP_RESEARCH_MODEL',
    'DEEP_RESEARCH_WORKER_MODEL',
    'EMBEDDING_SIDECAR_PROVIDER',
    'EMBEDDING_SIDECAR_BASE_URL',
    'EMBEDDING_SIDECAR_API_TOKEN',
    'EMBEDDING_SIDECAR_DIMENSIONS',
    'EMBEDDING_SIDECAR_CODE_MODEL',
    'SEARCH_LLM_PROVIDER',
    'SEARCH_LLM_API_TOKEN',
    'SEARCH_LLM_BASE_URL',
    'OLLAMA_SEARCH_BASE_URL',
    'OLLAMA_SEARCH_API_KEY',
    'BROWSER_EXECUTABLE_PATH',
    'BROWSER_PROXY_SERVER',
    'BROWSER_CDP_ENDPOINT',
    'BROWSER_PROFILE_DIR',
    'SEARCH_MCP_CONFIG_PATH',
    'TWITTER_BACKEND',
    'PI_SEARCH_TWITTER_BACKEND',
    'REDDIT_BACKEND',
    'PI_SEARCH_REDDIT_BACKEND',
    'XIAOHONGSHU_BACKEND',
    'PI_SEARCH_XIAOHONGSHU_BACKEND',
    'FACEBOOK_BACKEND',
    'PI_SEARCH_FACEBOOK_BACKEND',
    'INSTAGRAM_BACKEND',
    'PI_SEARCH_INSTAGRAM_BACKEND',
    'YOUTUBE_BACKEND',
    'PI_SEARCH_YOUTUBE_BACKEND',
    'BILIBILI_BACKEND',
    'PI_SEARCH_BILIBILI_BACKEND',
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key]]] : [])),
  );
}
