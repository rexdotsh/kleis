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
  requestIdHash: null,
};

test("100 identical rejections followed by recovery still emit the suppressed summary", async () => {
  let now = 0;
  const logger = createUpstreamFailureLogger({
    now: () => now,
    flushIntervalMs: 5,
  });
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 100; index++) {
      logger.log({
        ...failure,
        elapsedMs: index,
        requestIdHash: index.toString(16).padStart(8, "0"),
      });
    }
    expect(log).toHaveBeenCalledTimes(1);
    now = 59_999;
    await Bun.sleep(15);
    expect(log).toHaveBeenCalledTimes(1);
    now = 60_000;
    await Bun.sleep(15);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      provider: failure.provider,
      status: 429,
      suppressedCount: 99,
      summaryReason: "window_expired",
    });
    logger.log(failure);
    expect(log).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 10; index++) logger.log(failure);
    now = 120_000;
    await Bun.sleep(15);
    expect(log).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(log.mock.calls[3]?.[0])).suppressedCount).toBe(10);
  } finally {
    logger.flush();
    log.mockRestore();
  }
});

test("failure groups are isolated by provider, account, endpoint, status and code", () => {
  const logger = createUpstreamFailureLogger({ now: () => 0 });
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
      logger.log(fields);
      logger.log(fields);
    }
    expect(warn).toHaveBeenCalledTimes(6);
    expect(error).toHaveBeenCalledTimes(1);
    logger.flush();
    expect(warn).toHaveBeenCalledTimes(12);
    expect(error).toHaveBeenCalledTimes(2);
  } finally {
    logger.flush();
    warn.mockRestore();
    error.mockRestore();
  }
});

test("eviction at the 256-key limit reports suppressed counts before discarding a group", () => {
  const logger = createUpstreamFailureLogger({ now: () => 0 });
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 256; index++) {
      logger.log({ ...failure, providerAccountId: `fake-account-${index}` });
    }
    for (let index = 0; index < 99; index++) {
      logger.log({ ...failure, providerAccountId: "fake-account-0" });
    }
    expect(log).toHaveBeenCalledTimes(256);
    logger.log({ ...failure, providerAccountId: "fake-account-256" });
    expect(log).toHaveBeenCalledTimes(258);
    expect(JSON.parse(String(log.mock.calls[256]?.[0]))).toMatchObject({
      providerAccountId: "fake-account-0",
      suppressedCount: 99,
      summaryReason: "evicted",
    });
    logger.log({ ...failure, providerAccountId: "fake-account-256" });
    expect(log).toHaveBeenCalledTimes(258);
    logger.log({ ...failure, providerAccountId: "fake-account-0" });
    expect(log).toHaveBeenCalledTimes(259);
  } finally {
    logger.flush();
    log.mockRestore();
  }
});

test("shutdown flushes a partial window exactly once without another failure", () => {
  const logger = createUpstreamFailureLogger({ now: () => 0 });
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 100; index++) logger.log(failure);
    expect(log).toHaveBeenCalledTimes(1);
    logger.flush();
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      suppressedCount: 99,
      summaryReason: "shutdown",
      windowMs: 0,
    });
    logger.flush();
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    logger.flush();
    log.mockRestore();
  }
});

test("a new rejection at window expiry preserves the prior count before restarting suppression", () => {
  let now = 0;
  const logger = createUpstreamFailureLogger({ now: () => now });
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 100; index++) logger.log(failure);
    now = 60_000;
    logger.log(failure);
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      suppressedCount: 99,
      summaryReason: "window_expired",
    });
    expect(
      JSON.parse(String(log.mock.calls[2]?.[0])).suppressedCount
    ).toBeUndefined();
    logger.flush();
    expect(log).toHaveBeenCalledTimes(3);
  } finally {
    logger.flush();
    log.mockRestore();
  }
});

test("the periodic summary timer does not keep a process alive", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import { createUpstreamFailureLogger } from "./src/http/upstream-failure-log";
    const logger = createUpstreamFailureLogger();
    logger.log(${JSON.stringify(failure)});
  `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 2000 }
  );
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  }).toMatchObject({ exitCode: 0 });
});

test("graceful SIGTERM hooks flush suppressed failures before process exit", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import { createUpstreamFailureLogger } from "./src/http/upstream-failure-log";
    import { createGracefulShutdown } from "./src/http/graceful-shutdown";
    const logger = createUpstreamFailureLogger();
    const shutdown = createGracefulShutdown();
    shutdown.beforeExit(async () => { logger.flush(); });
    shutdown.install();
    for (let index = 0; index < 100; index++) logger.log(${JSON.stringify(failure)});
    process.kill(process.pid, "SIGTERM");
    await Bun.sleep(10000);
  `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 8000 }
  );
  const output = result.stderr.toString();
  expect({ exitCode: result.exitCode, output }).toMatchObject({ exitCode: 0 });
  const logs = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs).toHaveLength(2);
  expect(logs[1]).toMatchObject({
    event: "proxy_upstream_response_failed",
    suppressedCount: 99,
    summaryReason: "shutdown",
  });
}, 10_000);
