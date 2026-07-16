import type { BackendCallResult } from './backend.js';
import type { BrowserRequest } from './browser-policy.js';
import {
  validateBrowserRequest,
  validateNavigationUrl,
  validateSelector,
  validateText,
  validateExpression,
  validateCookiesArray,
  validateScrollCoord,
  validateWaitMs,
  dnsPreflight,
  freezeAllowedDomains,
  checkDomainAllowed,
  extractCookieMetadata,
  validateAllowedDomainsDns,
  isSensitiveAction,
} from './browser-policy.js';
import {
  runCommand,
  runBatchStdin,
  runScreenshot,
  closeSession,
  createRuntimeRoot,
  cleanupRuntimeRoot,
  generateNamespace,
  verifyVersion,
  type AgentBrowserSession,
  type AgentBrowserProcessOptions,
} from './agent-browser-process.js';
import { jsonTextResult, textResult } from './tool-output.js';

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(["']?(?:cookie|value|token|password|secret|authorization)["']?)\s*[:=]\s*["']?[^,\s}"']+["']?/gi, '$1=***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .slice(0, 2000);
}

// ── Types ──

export interface AgentBrowserAdapterOptions {
  executablePath?: string;
  runtimeRoot?: string;
  env?: Record<string, string | undefined> | undefined;
  signal?: AbortSignal;
}

export interface AgentBrowserStatus {
  version: string;
  executable: string;
  backend: 'agent-browser';
}

// ── Screenshot limits ──

export const SCREENSHOT_MAX_BYTES = 10_000_000;
export const SCREENSHOT_MAX_DIMENSION = 8_000;

// ── Adapter ──

export class AgentBrowserAdapter {
  private session: AgentBrowserSession;
  private executablePath: string;
  private allowedDomains: string[] = [];
  private domainsFrozen = false;
  private _closed = false;
  private _sessionStarted = false;

  constructor(options: AgentBrowserAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? '';
    this.session = {
      runtimeRoot: options.runtimeRoot ?? '',
      namespace: '',
    };
  }

  get closed(): boolean {
    return this._closed;
  }

  get sessionInfo(): AgentBrowserSession {
    return this.session;
  }

  /**
   * Perform a status check - verify executable and version without launching browser.
   */
  async status(): Promise<AgentBrowserStatus & BackendCallResult> {
    const version = await verifyVersion(this.executablePath);
    return {
      version,
      executable: this.executablePath,
      backend: 'agent-browser',
      content: [{ type: 'text', text: `agent-browser ${version} ready` }],
      details: { version, executable: this.executablePath, backend: 'agent-browser' },
    };
  }

  /**
   * Execute a browser action. Validation errors return as results, never throws.
   */
  async execute(rawArgs: Record<string, unknown>, options: AgentBrowserProcessOptions = {}): Promise<BackendCallResult> {
    if (this._closed) {
      return { content: [{ type: 'text', text: 'Session closed' }], details: { error: 'Session closed' } };
    }

    let request: BrowserRequest;
    try {
      request = validateBrowserRequest(rawArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], details: { error: message } };
    }

    try {
      return await this.dispatch(request, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], details: { error: message } };
    }
  }

  /**
   * Close the session - shutdown daemon and cleanup runtime root.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (this._sessionStarted && this.session.namespace && this.session.runtimeRoot) {
      await closeSession(this.session, { executablePath: this.executablePath });
    }
    if (this.session.runtimeRoot) {
      await cleanupRuntimeRoot(this.session.runtimeRoot);
    }
  }

  /**
   * Set allowed domains. Can only be set once before any navigation.
   */
  setAllowedDomains(domains: string[]): void {
    if (this.domainsFrozen) {
      throw new Error('Allowed domains already frozen for this session');
    }
    this.allowedDomains = freezeAllowedDomains(domains);
    this.domainsFrozen = true;
  }

  // ── Private dispatch ──

  private async dispatch(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    switch (request.action) {
      case 'status':
        return this.status();
      case 'navigate':
        return this.handleNavigate(request, options);
      case 'evaluate':
        return this.handleEvaluate(request, options);
      case 'text':
        return this.handleText(request, options);
      case 'html':
        return this.handleHtml(request, options);
      case 'screenshot':
        return this.handleScreenshot(request, options);
      case 'click':
        return this.handleClick(request, options);
      case 'type':
        return this.handleType(request, options);
      case 'scroll':
        return this.handleScroll(request, options);
      case 'close':
        return this.handleClose();
      case 'tabs':
        return this.handleTabs(options);
      case 'cookies':
        return this.handleCookies(request, options);
      case 'set_cookies':
        return this.handleSetCookies(request, options);
      case 'snapshot':
        return this.handleSnapshot(options);
      case 'fill':
        return this.handleFill(request, options);
      case 'wait':
        return this.handleWait(request, options);
      case 'get_url':
        return this.handleGetUrl(options);
      case 'get_title':
        return this.handleGetTitle(options);
      default:
        return jsonTextResult({ error: `Unsupported browser action: ${(request as { action: string }).action}` });
    }
  }

  private async ensureSession(options: AgentBrowserProcessOptions): Promise<void> {
    if (!this.session.runtimeRoot) {
      const root = options.runtimeRoot ?? await createRuntimeRoot();
      this.session = {
        runtimeRoot: root,
        namespace: generateNamespace(),
      };
    }
    if (!this.session.namespace) {
      this.session.namespace = generateNamespace();
    }
    this._sessionStarted = true;
  }

  private mergeOptions(options: AgentBrowserProcessOptions): AgentBrowserProcessOptions {
    const merged: AgentBrowserProcessOptions = {
      executablePath: this.executablePath,
      ...options,
    };
    if (this.session.runtimeRoot) merged.runtimeRoot = this.session.runtimeRoot;
    if (this.session.namespace) merged.namespace = this.session.namespace;
    if (this.allowedDomains.length > 0) merged.allowedDomains = this.allowedDomains;
    return merged;
  }

  // ── Action handlers ──

  private async handleNavigate(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (!request.url) {
      // Open without navigation (launch browser)
      await this.ensureSession(options);
      const merged = this.mergeOptions(options);
      const result = await runCommand(['open', 'about:blank'], merged);
      return jsonTextResult(result.success ? { ok: true, message: 'Browser launched' } : { ok: false, error: result.error });
    }

    const url = validateNavigationUrl(request.url);
    const hostname = new URL(url).hostname.toLowerCase();

    // DNS preflight
    await dnsPreflight(hostname, options.signal);

    // Domain containment: default to navigation hostname if not set
    if (!this.domainsFrozen) {
      const domains = request.allowedDomains && request.allowedDomains.length > 0 ? request.allowedDomains : [hostname];
      this.setAllowedDomains(domains);
      await validateAllowedDomainsDns(this.allowedDomains, options.signal);
    }

    if (this.allowedDomains.length > 0) {
      if (!checkDomainAllowed(hostname, this.allowedDomains)) {
        return jsonTextResult({
          ok: false,
          error: `Navigation to ${hostname} blocked by domain policy. Allowed domains: ${this.allowedDomains.join(', ')}. Add ${hostname} to allowedDomains to permit.`,
        });
      }
    }

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use 'open' command (not 'navigate')
    const result = await runCommand(['open', url], merged);
    return jsonTextResult(result.success ? { ok: true, url } : { ok: false, error: result.error });
  }

  private async handleEvaluate(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (isSensitiveAction('evaluate') && options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
      return jsonTextResult({ error: 'evaluate disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.' });
    }
    const expression = request.expression ? validateExpression(request.expression) : '';
    if (!expression) {
      return jsonTextResult({ error: 'expression is required' });
    }

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch mode for sensitive payload — never argv
    const results = await runBatchStdin(
      [{ args: ['eval', expression], sensitive: true }],
      merged,
    );

    const result = results[0];
    if (!result?.success) {
      return jsonTextResult({ error: result?.error || 'Evaluation failed' });
    }

    return textResult(String(result.data ?? ''), { raw: result.data });
  }

  private async handleText(_request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['read', '--json'], merged);
    if (!result.success) {
      const fallback = await runCommand(['eval', 'document.body.innerText'], merged);
      return textResult(String(fallback.data ?? ''), { raw: fallback.data });
    }
    const data = result.data as { text?: string } | undefined;
    return textResult(data?.text ?? String(result.data ?? ''), { raw: result.data });
  }

  private async handleHtml(_request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['eval', 'document.documentElement.outerHTML'], merged);
    return textResult(String(result.data ?? ''), { raw: result.data });
  }

  private async handleScreenshot(_request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    const shotResult = await runScreenshot(merged);
    if ('error' in shotResult) {
      return jsonTextResult({ error: shotResult.error });
    }

    return {
      content: [{
        type: 'image',
        mediaType: shotResult.mediaType,
        data: shotResult.data,
        width: shotResult.width,
        height: shotResult.height,
        byteLength: shotResult.byteLength,
      }],
      details: {
        mediaType: shotResult.mediaType,
        width: shotResult.width,
        height: shotResult.height,
        byteLength: shotResult.byteLength,
      },
    };
  }

  private async handleClick(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = request.selector ? validateSelector(request.selector) : '';
    if (!selector) {
      return jsonTextResult({ error: 'selector is required' });
    }
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['click', selector], merged);
    return jsonTextResult(result.success ? { ok: true, selector } : { ok: false, error: result.error });
  }

  private async handleType(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = request.selector ? validateSelector(request.selector) : '';
    const text = request.text ? validateText(request.text) : '';
    if (!selector) return jsonTextResult({ error: 'selector is required' });
    if (!text) return jsonTextResult({ error: 'text is required' });

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch for sensitive text payload — never argv
    const results = await runBatchStdin(
      [{ args: ['type', selector, text], sensitive: true }],
      merged,
    );
    const result = results[0];
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async handleScroll(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const x = validateScrollCoord(request.x, 'x');
    const y = validateScrollCoord(request.y, 'y');
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const direction = y > 0 ? 'down' : y < 0 ? 'up' : x > 0 ? 'right' : x < 0 ? 'left' : 'down';
    const px = Math.abs(y || x);
    const result = await runCommand(['scroll', direction, String(px)], merged);
    return jsonTextResult(result.success ? { ok: true } : { ok: false, error: result.error });
  }

  private async handleClose(): Promise<BackendCallResult> {
    await this.ensureSession({});
    const result = await runCommand(['close'], this.mergeOptions({}));
    return jsonTextResult(result.success ? { ok: true, message: 'Browser closed' } : { error: sanitizeErrorMessage(result.error ?? 'Close failed') });
  }

  private async handleTabs(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['tab', 'list', '--json'], merged);
    if (!result.success) {
      return jsonTextResult({ error: result.error || 'Failed to get tabs' });
    }
    const data = result.data as { tabs?: unknown[] } | undefined;
    const tabs = Array.isArray(data?.tabs) ? data.tabs : (Array.isArray(result.data) ? result.data : []);
    return jsonTextResult(tabs);
  }

  private async handleCookies(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const args = ['cookies', 'get', '--json'];

    if (request.urls && request.urls.length > 0) {
      args.push('--url', request.urls[0]!);
    }

    const result = await runCommand(args, merged);
    if (!result.success) {
      return jsonTextResult({ error: sanitizeErrorMessage(result.error || 'Failed to get cookies') });
    }

    // Return metadata only (no values)
    const cookieData = result.data as { cookies?: unknown[] } | unknown;
    const cookies = Array.isArray(cookieData) ? cookieData : (cookieData && typeof cookieData === 'object' && Array.isArray((cookieData as { cookies?: unknown[] }).cookies) ? (cookieData as { cookies: unknown[] }).cookies : []);
    const metadata = extractCookieMetadata(cookies as Array<{ name: string; value: string; domain: string; path: string; expires: number | undefined; httpOnly: boolean; secure: boolean; sameSite?: string }>);
    return jsonTextResult(metadata);
  }

  private async handleSetCookies(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (isSensitiveAction('set_cookies') && options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
      return jsonTextResult({ error: 'set_cookies disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.' });
    }
    if (!Array.isArray(request.cookies)) {
      return jsonTextResult({ error: 'cookies is required and must be an array' });
    }
    validateCookiesArray(request.cookies);

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch to pass cookie values securely
    const commands = request.cookies.map((cookie) => {
      const c = cookie as Record<string, unknown>;
      const args = ['cookies', 'set', String(c.name), String(c.value ?? '')];
      if (typeof c.domain === 'string') args.push('--domain', c.domain);
      if (typeof c.path === 'string') args.push('--path', c.path);
      if (c.secure === true) args.push('--secure');
      if (c.httpOnly === true) args.push('--httpOnly');
      if (typeof c.sameSite === 'string') args.push('--sameSite', c.sameSite);
      if (typeof c.expires === 'number') args.push('--expires', String(c.expires));
      return { args, sensitive: true };
    });
    const results = await runBatchStdin(commands, merged);
    const failed = results.find(result => !result.success);
    if (failed) return jsonTextResult({ error: sanitizeErrorMessage(failed.error ?? 'Failed to set cookies') });
    return jsonTextResult({ ok: true, count: request.cookies.length });
  }

  private async handleSnapshot(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['snapshot'], merged);
    if (!result.success) {
      return jsonTextResult({ error: result.error || 'Snapshot failed' });
    }
    return jsonTextResult(result.data);
  }

  private async handleFill(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = request.selector ? validateSelector(request.selector) : '';
    const text = request.text ? validateText(request.text) : '';
    if (!selector) return jsonTextResult({ error: 'selector is required' });
    if (!text) return jsonTextResult({ error: 'text is required' });

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch for sensitive text payload — never argv
    const results = await runBatchStdin(
      [{ args: ['fill', selector, text], sensitive: true }],
      merged,
    );
    const result = results[0];
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async handleWait(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const ms = validateWaitMs(request.waitMs ?? 1000);
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    if (request.selector) {
      const selector = validateSelector(request.selector);
      // agent-browser wait takes <sel|ms> as positional arg
      const result = await runCommand(['wait', selector], merged);
      return jsonTextResult(result.success ? { ok: true } : { ok: false, error: result.error });
    }

    // Wait for time
    const result = await runCommand(['wait', String(ms)], merged);
    return jsonTextResult(result.success ? { ok: true } : { ok: false, error: result.error });
  }

  private async handleGetUrl(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['get', 'url'], merged);
    return textResult(String(result.data ?? ''), { raw: result.data });
  }

  private async handleGetTitle(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['get', 'title'], merged);
    return textResult(String(result.data ?? ''), { raw: result.data });
  }
}
