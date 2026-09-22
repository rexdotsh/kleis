import { describe, expect, test } from "bun:test";

import {
  CodexAuthRefreshError,
  sendCodexWithAuthReplay,
} from "../../src/http/codex-auth-replay";

describe("Codex auth replay", () => {
  const originalAccount = { id: "account-1", accessToken: "expired-token" };
  const refreshedAccount = { id: "account-1", accessToken: "fresh-token" };

  test("refreshes and replays exactly once after a 401", async () => {
    const sentTokens: string[] = [];
    let refreshCount = 0;
    const result = await sendCodexWithAuthReplay({
      account: originalAccount,
      send: (account) => {
        sentTokens.push(account.accessToken);
        return Promise.resolve({
          response: new Response(null, {
            status: sentTokens.length === 1 ? 401 : 200,
          }),
        });
      },
      refresh: () => {
        refreshCount++;
        return Promise.resolve(refreshedAccount);
      },
    });

    expect(sentTokens).toEqual(["expired-token", "fresh-token"]);
    expect(refreshCount).toBe(1);
    expect(result.attempt.response.status).toBe(200);
    expect(result.replayed).toBe(true);
  });

  test("returns a second 401 without another replay", async () => {
    let sendCount = 0;
    let refreshCount = 0;
    const result = await sendCodexWithAuthReplay({
      account: originalAccount,
      send: () => {
        sendCount++;
        return Promise.resolve({
          response: new Response(null, { status: 401 }),
        });
      },
      refresh: () => {
        refreshCount++;
        return Promise.resolve(refreshedAccount);
      },
    });

    expect(sendCount).toBe(2);
    expect(refreshCount).toBe(1);
    expect(result.attempt.response.status).toBe(401);
  });

  test("never refreshes a successful response", async () => {
    let refreshCount = 0;
    const result = await sendCodexWithAuthReplay({
      account: originalAccount,
      send: () =>
        Promise.resolve({ response: new Response(null, { status: 200 }) }),
      refresh: () => {
        refreshCount++;
        return Promise.resolve(refreshedAccount);
      },
    });

    expect(refreshCount).toBe(0);
    expect(result.replayed).toBe(false);
  });

  test("surfaces refresh failures separately from replay failures", async () => {
    await expect(
      sendCodexWithAuthReplay({
        account: originalAccount,
        send: () =>
          Promise.resolve({ response: new Response(null, { status: 401 }) }),
        refresh: () => Promise.reject(new Error("refresh failed")),
      })
    ).rejects.toBeInstanceOf(CodexAuthRefreshError);
  });
});
