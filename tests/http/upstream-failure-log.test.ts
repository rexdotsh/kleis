import { expect, spyOn, test } from "bun:test";
import { createUpstreamFailureLogger } from "../../src/http/upstream-failure-log";

const failure = {
  provider: "claude" as const,
  providerAccountId: "fake-account",
  endpoint: "messages",
  status: 429,
  errorType: "rate_limit_error",
  errorCode: "rate_limit_exceeded",
  elapsedMs: 10,
  requestId: null,
};

test("100 identical rejections log once, with suppressed counts in subsequent minute windows", () => {
  let now = 0;
  const logFailure = createUpstreamFailureLogger(() => now);
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 100; index++) {
      logFailure({
        ...failure,
        elapsedMs: index,
        requestId: `fake-request-${index}`,
      });
    }
    expect(log).toHaveBeenCalledTimes(1);
    now = 59_999;
    logFailure(failure);
    expect(log).toHaveBeenCalledTimes(1);
    now = 60_000;
    logFailure(failure);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      ...failure,
      suppressedCount: 100,
    });
    for (let index = 0; index < 10; index++) logFailure(failure);
    now = 120_000;
    logFailure(failure);
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(log.mock.calls[2]?.[0])).suppressedCount).toBe(10);
  } finally {
    log.mockRestore();
  }
});

test("failure groups are isolated by provider, account, endpoint, status and code", () => {
  const logFailure = createUpstreamFailureLogger(() => 0);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (const fields of [
      failure,
      { ...failure, provider: "codex" as const },
      { ...failure, providerAccountId: "other-account" },
      { ...failure, endpoint: "responses" },
      { ...failure, status: 503 },
      { ...failure, errorCode: "server_error" },
      { ...failure, errorType: "overloaded_error" },
    ]) {
      logFailure(fields);
      logFailure(fields);
    }
    expect(warn).toHaveBeenCalledTimes(6);
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("failure-key storage evicts the oldest key at a fixed 256-key limit", () => {
  const logFailure = createUpstreamFailureLogger(() => 0);
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 257; index++) {
      logFailure({ ...failure, providerAccountId: `fake-account-${index}` });
    }
    expect(log).toHaveBeenCalledTimes(257);
    logFailure({ ...failure, providerAccountId: "fake-account-256" });
    expect(log).toHaveBeenCalledTimes(257);
    logFailure({ ...failure, providerAccountId: "fake-account-0" });
    expect(log).toHaveBeenCalledTimes(258);
  } finally {
    log.mockRestore();
  }
});
