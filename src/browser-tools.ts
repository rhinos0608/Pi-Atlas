import type { BackendCallResult } from './backend.js'
import {
  isBrowserAutomationDisabled,
  openCdpSession,
  cdpListTargets,
  cdpNavigate,
  cdpEvaluate,
  cdpGetText,
  cdpGetHtml,
  cdpScreenshot,
  cdpClick,
  cdpType,
  cdpScroll,
  cdpCloseTarget,
  cdpGetCookiesRaw,
  cdpSetCookies,
} from './cdp.js'

import { textResult as guardedTextResult } from './tool-output.js'
import { AgentBrowserAdapter } from './agent-browser.js'
import { resolveAgentBrowserExecutable } from './agent-browser-process.js'
import { extractCookieMetadata, validateLegacyLoopbackEndpoint } from './browser-policy.js'

export type BrowserAction = 'status' | 'tabs' | 'navigate' | 'evaluate' | 'text' | 'html' | 'screenshot' | 'click' | 'type' | 'scroll' | 'close' | 'cookies' | 'set_cookies'

// ── Backend selection ──

export type BrowserBackend = 'agent-browser' | 'cdp'

export function resolveBrowserBackend(env?: Record<string, string | undefined>): BrowserBackend {
  const raw = env?.PI_SEARCH_BROWSER_BACKEND?.trim().toLowerCase()
  if (raw === 'cdp') return 'cdp'
  return 'agent-browser'
}

// ── Persistent adapter ──

let _adapter: AgentBrowserAdapter | null = null

async function getAdapter(env?: Record<string, string | undefined>): Promise<AgentBrowserAdapter> {
  if (!_adapter) {
    const executablePath = await resolveAgentBrowserExecutable(env?.BROWSER_EXECUTABLE_PATH)
    _adapter = new AgentBrowserAdapter({ env, executablePath })
  }
  return _adapter
}

export async function closeBrowserSession(): Promise<void> {
  if (_adapter) {
    const a = _adapter
    _adapter = null
    await a.close()
  }
}

// ── CDP endpoint ──

function getCdpEndpoint(args: Record<string, unknown>, env: Record<string, string | undefined>): string | undefined {
  const endpoint = (typeof args.endpoint === 'string' && args.endpoint.trim())
    ? args.endpoint.trim()
    : (env.BROWSER_CDP_ENDPOINT?.trim())
  return endpoint || undefined
}

// ── Main entry point ──

export async function browser(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> } = {},
): Promise<BackendCallResult> {
  const env = options.env ?? process.env

  if (isBrowserAutomationDisabled(env)) {
    return textResult({ ok: false, message: 'Browser automation disabled by PI_SEARCH_BROWSER_AUTOMATION. Set it to 1 or unset to enable.' })
  }

  const backend = resolveBrowserBackend(env)

  if (backend === 'cdp') {
    return legacyCdpBrowser(args, options)
  }

  return agentBrowserRoute(args, options)
}

// ── Agent-browser route ──

async function agentBrowserRoute(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> },
): Promise<BackendCallResult> {
  const env = options.env ?? process.env
  const adapter = await getAdapter(env)
  return adapter.execute(args, { env, ...(options.signal ? { signal: options.signal } : {}) })
}

// ── Legacy CDP route (rollback path) ──

async function legacyCdpBrowser(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> },
): Promise<BackendCallResult> {
  const env = options.env ?? process.env
  const endpoint = getCdpEndpoint(args, env)

  if (!endpoint) {
    throw new Error('CDP endpoint is required. Set BROWSER_CDP_ENDPOINT env or pass endpoint param.')
  }

  validateLegacyLoopbackEndpoint(endpoint)
  const action = typeof args.action === 'string' ? args.action : 'status'

  if (action === 'status') {
    return textResult({
      endpoint,
      browserAutomationEnabled: true,
      backend: 'cdp',
      websocketAvailable: typeof globalThis.WebSocket === 'function',
    })
  }



  const signal = options.signal
  const session = await openCdpSession(endpoint, signal)
  try {
    switch (action) {
      case 'tabs':
        return textResult(await cdpListTargets(session))
      case 'navigate': {
        const url = requireString(args.url, 'url')
        return textResult(await cdpNavigate(session, url))
      }
      case 'evaluate': {
        const expression = requireString(args.expression, 'expression')
        return textResult(await cdpEvaluate(session, expression))
      }
      case 'text':
        return textResult(await cdpGetText(session))
      case 'html':
        return textResult(await cdpGetHtml(session))
      case 'screenshot':
        return textResult(await cdpScreenshot(session))
      case 'click': {
        const selector = requireString(args.selector, 'selector')
        return textResult(await cdpClick(session, selector))
      }
      case 'type': {
        const selector = requireString(args.selector, 'selector')
        const text = requireString(args.text, 'text')
        return textResult(await cdpType(session, selector, text))
      }
      case 'scroll': {
        const x = typeof args.x === 'number' ? args.x : 0
        const y = typeof args.y === 'number' ? args.y : 0
        return textResult(await cdpScroll(session, x, y))
      }
      case 'close':
        return textResult(await cdpCloseTarget(session))
      case 'cookies': {
        const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === 'string') : undefined
        const rawCookies = await cdpGetCookiesRaw(session, urls)
        // Return metadata only (no values) — consistent with agent-browser path
        const metadata = extractCookieMetadata(rawCookies as Array<{ name: string; value: string; domain: string; path: string; expires: number | undefined; httpOnly: boolean; secure: boolean; sameSite?: string }>)
        return textResult(metadata)
      }
      case 'set_cookies': {
        const cookies = args.cookies
        if (!Array.isArray(cookies)) throw new Error('cookies is required and must be an array')
        for (const c of cookies) {
          if (typeof c !== 'object' || c === null || typeof (c as Record<string, unknown>).name !== 'string' || !(c as Record<string, unknown>).name) {
            throw new Error('each cookie must be an object with a non-empty string name')
          }
        }
        return textResult(await cdpSetCookies(session, cookies))
      }
      default:
        throw new Error(`Unsupported browser action: ${action}`)
    }
  } finally {
    session.close()
  }
}

// ── Helpers ──

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function textResult(data: unknown): BackendCallResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) ?? String(data)
  return guardedTextResult(text, data)
}
