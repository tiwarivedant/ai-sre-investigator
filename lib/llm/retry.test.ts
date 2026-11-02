import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@google/genai";
import { backoffDelay, DEFAULT_RETRY, formatDuration, parseRetryAfter, RetryBudgetExceededError, withRetry } from "./retry";
import { classifyAnthropicError } from "./anthropic";
import { classifyGeminiError } from "./gemini";

const rateLimited = { status: 429 };
const classify = (e: unknown) => ((e as { status?: number }).status === 429 ? { status: 429 } : null);

describe("withRetry", () => {
  it("retries 429s with backoff and then succeeds", async () => {
    const sleeps: number[] = [];
    const notices: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        if (++calls < 3) throw rateLimited;
        return "ok";
      },
      { classify, deadline: Date.now() + 60_000, sleep: async (ms) => void sleeps.push(ms), random: () => 1, onRetry: (n) => notices.push(n.attempt) },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]); // exponential: base, 2x base
    expect(notices).toEqual([1, 2]);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 400 };
        },
        { classify, deadline: Date.now() + 60_000, sleep: async () => {} },
      ),
    ).rejects.toEqual({ status: 400 });
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw rateLimited;
        },
        { classify, deadline: Date.now() + 60_000, sleep: async () => {} },
      ),
    ).rejects.toBe(rateLimited);
    expect(calls).toBe(DEFAULT_RETRY.maxAttempts);
  });

  it("honours a server retry-after and fails fast if it would overrun the deadline", async () => {
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw rateLimited;
        },
        { classify: () => ({ status: 429, retryAfterMs: 30_000 }), deadline: Date.now() + 5_000, sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toBeInstanceOf(RetryBudgetExceededError);
    expect(sleeps).toEqual([]);
  });
});

it("fails fast when the wait would not leave a usable turn (reserve)", async () => {
  const sleeps: number[] = [];
  const err = await withRetry(
    async () => {
      throw rateLimited;
    },
    // 60s requested, 78s left, but a turn needs 20s afterwards: not worth waiting.
    { classify: () => ({ status: 429, retryAfterMs: 60_000 }), deadline: Date.now() + 78_000, reserveMs: 20_000, sleep: async (ms) => void sleeps.push(ms) },
  ).catch((e) => e);
  expect(err).toBeInstanceOf(RetryBudgetExceededError);
  expect(err.message).toMatch(/Rate limited by the provider \(429\): it asked us to wait 60s/);
  expect(sleeps).toEqual([]);
});

describe("backoffDelay", () => {
  it("is jittered within [cap/2, cap] and capped", () => {
    expect(backoffDelay(1, DEFAULT_RETRY, undefined, () => 0)).toBe(500);
    expect(backoffDelay(3, DEFAULT_RETRY, undefined, () => 1)).toBe(4000);
    expect(backoffDelay(20, DEFAULT_RETRY, undefined, () => 1)).toBe(DEFAULT_RETRY.maxDelayMs);
    expect(backoffDelay(1, DEFAULT_RETRY, 7000, () => 0)).toBe(7000);
    // Server-requested waits are never shortened (a daily quota resets in hours, not 60s).
    expect(backoffDelay(1, DEFAULT_RETRY, 51_155_000, () => 0)).toBe(51_155_000);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("provider error classification", () => {
  it("Anthropic: 429 is retryable with retry-after; 400/401 are not", () => {
    const e429 = Anthropic.APIError.generate(429, { error: { type: "rate_limit_error" } }, "slow down", new Headers({ "retry-after": "2" }));
    expect(classifyAnthropicError(e429)).toEqual({ status: 429, retryAfterMs: 2000 });
    expect(classifyAnthropicError(Anthropic.APIError.generate(400, {}, "bad", new Headers()))).toBeNull();
    expect(classifyAnthropicError(Anthropic.APIError.generate(401, {}, "auth", new Headers()))).toBeNull();
    expect(classifyAnthropicError(Anthropic.APIError.generate(529, {}, "overloaded", new Headers()))?.status).toBe(529);
  });

  it("Gemini: 429 is retryable and RetryInfo delay is used; timeouts are not retried", () => {
    const e429 = new ApiError({ status: 429, message: '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"17s"}]}}' });
    expect(classifyGeminiError(e429)).toEqual({ status: 429, retryAfterMs: 17_000 });
    expect(classifyGeminiError(new ApiError({ status: 400, message: "bad" }))).toBeNull();
    const abort = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(classifyGeminiError(abort)).toBeNull();
  });
});

describe("daily quota", () => {
  it("fails immediately with the real wait instead of retrying a quota that resets in hours", async () => {
    let calls = 0;
    const err = await withRetry(
      async () => {
        calls++;
        throw rateLimited;
      },
      { classify: () => ({ status: 429, retryAfterMs: 51_155_000 }), deadline: Date.now() + 78_000, reserveMs: 20_000, sleep: async () => {} },
    ).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.message).toMatch(/wait 14h 13m/);
  });

  it("formats durations", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(180_000)).toBe("3m");
    expect(formatDuration(51_155_000)).toBe("14h 13m");
  });
});
