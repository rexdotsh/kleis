import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../src/db";
import {
  findProviderAccountById,
  listProviderAccounts,
  replaceProviderAccountCredentials,
} from "../../src/db/repositories/provider-accounts";
import { apiKeys, providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import {
  completeProviderOAuth,
  startProviderOAuth,
} from "../../src/domain/providers/provider-service";

describe("OAuth account reauthorization", () => {
  const originalFetch = globalThis.fetch;
  const codexId = "e402c63b-3916-40ed-8d56-7258ccfd0631";
  const claudeId = "9a249097-40c4-4e8d-895a-251f45494c2a";
  let client: ReturnType<typeof createClient>;
  let database: Database;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kleis-reauthorize-"));
    client = createClient({ url: `file:${join(directory, "test.db")}` });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const now = Date.now();
    await database.insert(providerAccounts).values([
      {
        id: codexId,
        provider: "codex",
        accountId: "acct-1",
        label: "Codex account",
        isPrimary: true,
        accessToken: "old-codex-access",
        refreshToken: "old-codex-refresh",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: claudeId,
        provider: "claude",
        label: "Claude account",
        isPrimary: true,
        enabled: false,
        accessToken: "old-claude-access",
        refreshToken: "old-claude-refresh",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    client.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("replaces selected Claude credentials without changing the account or its status", async () => {
    const start = await startProviderOAuth(
      database,
      "claude",
      { options: { mode: "max", replaceAccountId: claudeId } },
      Date.now()
    );
    const authorization = new URL(start.authorizationUrl);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback"
    );
    expect(authorization.searchParams.get("scope")).toContain(
      "user:sessions:claude_code"
    );
    globalThis.fetch = ((url, init) => {
      expect(url).toBe("https://platform.claude.com/v1/oauth/token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        grant_type: "authorization_code",
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
      });
      return Promise.resolve(
        Response.json({
          access_token: "new-claude-access",
          refresh_token: "new-claude-refresh",
          expires_in: 3600,
        })
      );
    }) as typeof fetch;

    const replaced = await completeProviderOAuth(
      database,
      "claude",
      { state: start.state, code: "auth-code" },
      Date.now()
    );

    expect(replaced).toMatchObject({
      id: claudeId,
      label: "Claude account",
      isPrimary: true,
      enabled: false,
      accessToken: "new-claude-access",
      refreshToken: "new-claude-refresh",
    });
    expect(
      (await listProviderAccounts(database)).filter(
        (a) => a.provider === "claude"
      )
    ).toHaveLength(1);
    await expect(
      completeProviderOAuth(
        database,
        "claude",
        { state: start.state, code: "auth-code" },
        Date.now()
      )
    ).rejects.toThrow("missing or expired");
  });

  test("keeps Max and Console logins separate even for the same Claude user", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          access_token: crypto.randomUUID(),
          refresh_token: crypto.randomUUID(),
          expires_in: 3600,
          account: { uuid: "shared-user" },
          organization: { uuid: "same-organization" },
        })
      )) as typeof fetch;

    for (const mode of ["max", "console"] as const) {
      const started = await startProviderOAuth(
        database,
        "claude",
        { options: { mode } },
        Date.now()
      );
      await completeProviderOAuth(
        database,
        "claude",
        { state: started.state, code: "auth-code" },
        Date.now()
      );
    }

    const connected = (await listProviderAccounts(database)).filter(
      (account) => account.provider === "claude" && account.id !== claudeId
    );
    expect(connected).toHaveLength(2);
    expect(
      connected
        .map((account) =>
          account.metadata?.provider === "claude"
            ? account.metadata.oauthMode
            : null
        )
        .sort()
    ).toEqual(["console", "max"]);
    expect(connected.every((account) => account.accountId === null)).toBe(true);
  });

  test("reauthorizes a Claude row with a legacy user ID without changing its identity", async () => {
    await database
      .update(providerAccounts)
      .set({ accountId: "legacy-user-id" })
      .where(eq(providerAccounts.id, claudeId));
    const started = await startProviderOAuth(
      database,
      "claude",
      {
        options: { mode: "max", replaceAccountId: claudeId },
      },
      Date.now()
    );
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          account: { uuid: "legacy-user-id" },
        })
      )) as typeof fetch;

    const reauthorized = await completeProviderOAuth(
      database,
      "claude",
      {
        state: started.state,
        code: "auth-code",
      },
      Date.now()
    );
    expect(reauthorized).toMatchObject({
      id: claudeId,
      accountId: "legacy-user-id",
      refreshToken: "new-refresh",
    });
  });

  test("hides tokens in a duplicate-identity reauthorization conflict", async () => {
    await database.insert(providerAccounts).values({
      id: "f0301b40-0e10-4788-8887-06c9974ba33f",
      provider: "claude",
      accountId: "already-connected",
      accessToken: "another-access",
      refreshToken: "another-refresh",
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await expect(
      replaceProviderAccountCredentials(database, claudeId, {
        provider: "claude",
        accountId: "already-connected",
        accessToken: "sensitive-new-access",
        refreshToken: "sensitive-new-refresh",
        expiresAt: Date.now() + 3_600_000,
        metadata: null,
        now: Date.now(),
      })
    ).rejects.toThrow("already connected to another account");
    expect(
      (await findProviderAccountById(database, claudeId))?.refreshToken
    ).toBe("old-claude-refresh");
  });

  test("replaces the selected Codex account only when the OAuth identity matches", async () => {
    await database.insert(apiKeys).values({
      id: "key-scoped-to-codex",
      key: "kleis_reauthorize_contract_key",
      accountScopeJson: JSON.stringify([codexId]),
      createdAt: Date.now(),
    });
    const tokenFor = (accountId: string) =>
      `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.signature`;
    const start = await startProviderOAuth(
      database,
      "codex",
      { options: { mode: "browser", replaceAccountId: codexId } },
      Date.now()
    );
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          access_token: "new-codex-access",
          refresh_token: "new-codex-refresh",
          expires_in: 3600,
          id_token: tokenFor("acct-1"),
        })
      )) as typeof fetch;

    const replaced = await completeProviderOAuth(
      database,
      "codex",
      { state: start.state, code: "auth-code" },
      Date.now()
    );
    expect(replaced).toMatchObject({
      id: codexId,
      accountId: "acct-1",
      label: "Codex account",
      isPrimary: true,
      accessToken: "new-codex-access",
    });
    const scopedKey = await database.query.apiKeys.findFirst();
    expect(scopedKey?.accountScopeJson).toBe(JSON.stringify([codexId]));

    const mismatch = await startProviderOAuth(
      database,
      "codex",
      { options: { mode: "browser", replaceAccountId: codexId } },
      Date.now()
    );
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          access_token: "wrong-account-access",
          refresh_token: "wrong-account-refresh",
          expires_in: 3600,
          id_token: tokenFor("acct-2"),
        })
      )) as typeof fetch;
    await expect(
      completeProviderOAuth(
        database,
        "codex",
        { state: mismatch.state, code: "auth-code" },
        Date.now()
      )
    ).rejects.toThrow("identity does not match");
    expect(
      (await findProviderAccountById(database, codexId))?.accessToken
    ).toBe("new-codex-access");
  });

  test("rejects a target from a different provider before starting OAuth", async () => {
    await expect(
      startProviderOAuth(
        database,
        "codex",
        { options: { replaceAccountId: claudeId } },
        Date.now()
      )
    ).rejects.toThrow("not found");
  });

  test("keeps the replacement target through the Codex headless device flow", async () => {
    const token = `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: "acct-1" })).toString("base64url")}.signature`;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/deviceauth/usercode")) {
        return Promise.resolve(
          Response.json({
            device_auth_id: "device-1",
            user_code: "code-1",
            interval: 1,
          })
        );
      }
      if (url.endsWith("/deviceauth/token")) {
        return Promise.resolve(
          Response.json({
            authorization_code: "auth-code",
            code_verifier: "verifier",
          })
        );
      }
      if (url.endsWith("/oauth/token")) {
        return Promise.resolve(
          Response.json({
            access_token: "headless-access",
            refresh_token: "headless-refresh",
            expires_in: 3600,
            id_token: token,
          })
        );
      }
      return Promise.reject(new Error("Unexpected OAuth URL"));
    }) as typeof fetch;

    const start = await startProviderOAuth(
      database,
      "codex",
      { options: { mode: "headless", replaceAccountId: codexId } },
      Date.now()
    );
    const replaced = await completeProviderOAuth(
      database,
      "codex",
      { state: start.state },
      Date.now()
    );

    expect(replaced).toMatchObject({
      id: codexId,
      accessToken: "headless-access",
      refreshToken: "headless-refresh",
      isPrimary: true,
    });
  });
});
