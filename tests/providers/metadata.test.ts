import { describe, expect, test } from "bun:test";

import {
  parseImportedProviderAccountMetadata,
  parseProviderAccountMetadata,
  serializeProviderAccountMetadata,
  type ProviderAccountMetadata,
} from "../../src/providers/metadata";

describe("provider account metadata persistence", () => {
  test("strips legacy Claude wire configuration but keeps refresh mode", () => {
    const legacy = {
      provider: "claude",
      tokenType: "Bearer",
      scope: "user:inference",
      oauthMode: "console",
      oauthHost: "platform.claude.com",
      betaHeaders: ["old-beta"],
      userAgent: "old-cli",
      systemIdentity: "old identity",
      toolPrefix: "mcp_",
    };
    const expected = {
      provider: "claude",
      oauthMode: "console",
      oauthHost: "platform.claude.com",
    };
    expect(parseProviderAccountMetadata(JSON.stringify(legacy))).toEqual(
      expected
    );
    expect(
      parseImportedProviderAccountMetadata({
        provider: "claude",
        accountId: null,
        metadata: legacy,
      })
    ).toEqual(expected);
    expect(
      JSON.parse(
        serializeProviderAccountMetadata(legacy as ProviderAccountMetadata) ??
          "null"
      )
    ).toEqual(expected);
  });

  test("does not retain the Codex ID token or unused request profiles", () => {
    const legacy = {
      provider: "codex",
      tokenType: "Bearer",
      scope: "openid offline_access",
      idToken: "private-jwt",
      organizationIds: ["org-1"],
      chatgptAccountId: "acct-1",
      email: "user@example.com",
      requestProfile: { originator: "old-client" },
    };
    const expected = {
      provider: "codex",
      chatgptAccountId: "acct-1",
      email: "user@example.com",
    };
    expect(parseProviderAccountMetadata(JSON.stringify(legacy))).toEqual(
      expected
    );
    expect(
      JSON.parse(
        serializeProviderAccountMetadata(legacy as ProviderAccountMetadata) ??
          "null"
      )
    ).toEqual(expected);
  });
});
