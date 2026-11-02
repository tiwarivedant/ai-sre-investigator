import type { RetryNotice } from "./types";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 20_000 };

/** Raised when a retryable error can't be retried within the remaining time budget. */
export class RetryBudgetExceededError extends Error {
  constructor(
    readonly cause: unknown,
    readonly wantedDelayMs: number,
    readonly status?: number,
  ) {
    const wait = formatDuration(wantedDelayMs);
    const what = status === 429 ? "Rate limited by the provider (429)" : `Provider unavailable${status ? ` (${status})` : ""}`;
    super(`${what}: it asked us to wait ${wait}, which would not leave enough of the time budget to finish. Try again in about ${wait}.`);
  }
}

export interface RetryableInfo {
  status?: number;
  /** Server-suggested wait (Retry-After header, Gemini RetryInfo), if any. */
  retryAfterMs?: number;
}

/**
 * Retry `fn` with exponential backoff and full jitter when `classify` says the
 * error is retryable (429 rate limits; also 5xx/overloaded, since the SDKs'
 * own retries are disabled so there is one retry policy for every provider).
 * A server-provided retry-after wins over the computed delay. Never sleeps past
 * `deadline` (minus `reserveMs`): if the wait would leave too little time to use, fails fast instead.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    classify: (err: unknown) => RetryableInfo | null;
    deadline: number;
    /** Time that must remain after a wait for the retry to be worth it (e.g. one model turn). */
    reserveMs?: number;
    policy?: RetryPolicy;
    onRetry?: (n: RetryNotice) => void;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const info = opts.classify(err);
      if (!info || attempt >= policy.maxAttempts) throw err;
      const delayMs = backoffDelay(attempt, policy, info.retryAfterMs, random);
      // Fail fast rather than sleep away the budget and time out anyway.
      if (Date.now() + delayMs + (opts.reserveMs ?? 0) >= opts.deadline) throw new RetryBudgetExceededError(err, delayMs, info.status);
      opts.onRetry?.({ attempt, maxAttempts: policy.maxAttempts, delayMs, status: info.status });
      await sleep(delayMs);
    }
  }
}

export function backoffDelay(attempt: number, policy: RetryPolicy, retryAfterMs: number | undefined, random: () => number): number {
  // Never shorten a server-requested wait: a capped wait just fails again (e.g. a daily quota that
  // resets in hours). The deadline check then turns a long wait into an immediate, honest failure.
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return retryAfterMs;
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  // Full jitter, with a floor so we never hammer the API with a ~0ms retry.
  return Math.round(cap / 2 + random() * (cap / 2));
}

/** Parse a Retry-After header value: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export const isRetryableStatus = (status: number | undefined) => status === 429 || status === 529 || (status !== undefined && status >= 500);

/** 45s, 3m, 14h 12m */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
