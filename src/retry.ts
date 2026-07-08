export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const initialDelayMs = opts.initialDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 2_000;
  const backoffFactor = opts.backoffFactor ?? 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) break;
      const delay = Math.floor(Math.random() * (Math.min(initialDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs) + 1));
      await sleep(delay);
    }
  }

  throw lastError;
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return /timeout|etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|http 5\d\d/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
