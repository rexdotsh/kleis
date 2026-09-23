import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type FakeElement = {
  value: string;
  disabled: boolean;
  innerHTML: string;
  textContent: string;
  checked: boolean;
  style: { display: string };
  classList: {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
  };
  querySelector: () => null;
};

const elements = new Map<string, FakeElement>();
const element = (selector: string) => {
  let current = elements.get(selector);
  if (!current) {
    current = {
      value: "",
      disabled: false,
      innerHTML: "",
      textContent: "",
      checked: false,
      style: { display: "none" },
      classList: {
        contains: () => false,
        add: () => undefined,
        remove: () => undefined,
      },
      querySelector: () => null,
    };
    elements.set(selector, current);
  }
  return current;
};

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;

globalThis.document = {
  querySelector: element,
  querySelectorAll: () => [],
} as unknown as Document;
globalThis.window = { location: { origin: "http://localhost" } } as Window &
  typeof globalThis;
globalThis.localStorage = { getItem: () => null } as unknown as Storage;

const { cancelOAuthFlow, loadAccounts, logout, startOAuth, state } =
  await import("../../public/admin/app-data.js");

describe("admin UI request state", () => {
  beforeEach(() => {
    globalThis.document = {
      querySelector: element,
      querySelectorAll: () => [],
    } as unknown as Document;
    globalThis.window = { location: { origin: "http://localhost" } } as Window &
      typeof globalThis;
    globalThis.localStorage = {
      getItem: () => null,
      removeItem: () => undefined,
    } as unknown as Storage;
    elements.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalLocalStorage;
  });

  test("ignores an older account response after a newer reload", async () => {
    let releaseOld: ((response: Response) => void) | undefined;
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOld = resolve;
    });
    let accountCalls = 0;
    globalThis.fetch = ((url: RequestInfo | URL) => {
      if (String(url).startsWith("/admin/accounts/usage?")) {
        return Promise.resolve(
          Response.json({ usage: [], windowMs: 86_400_000 })
        );
      }
      accountCalls++;
      return accountCalls === 1
        ? oldResponse
        : Promise.resolve(Response.json({ accounts: [], providers: [] }));
    }) as typeof fetch;

    const oldLoad = loadAccounts();
    const newLoad = loadAccounts();
    await newLoad;
    releaseOld?.(Response.json({ accounts: [{ id: "stale" }], providers: [] }));
    await oldLoad;

    expect(state.accounts).toEqual([]);
    expect(element("#accounts-list").innerHTML).not.toContain("stale");
  });

  test("cancelling while OAuth start is pending ignores the late flow", async () => {
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as typeof fetch;
    element("#oauth-provider").value = "claude";
    element("#oauth-claude-mode").value = "max";

    const starting = startOAuth();
    cancelOAuthFlow();
    release?.(
      Response.json({
        state: "cancelled-state",
        authorizationUrl: "https://claude.ai/oauth/authorize",
      })
    );
    await starting;

    expect(state.activeOAuth).toBeNull();
    expect(element("#oauth-flow-active").style.display).toBe("none");
    expect(element("#btn-oauth-start").disabled).toBe(false);
  });

  test("a response arriving after logout cannot restore account state", async () => {
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = ((url: RequestInfo | URL) =>
      String(url).startsWith("/admin/accounts/usage?")
        ? Promise.resolve(Response.json({ usage: [], windowMs: 86_400_000 }))
        : new Promise<Response>((resolve) => {
            release = resolve;
          })) as typeof fetch;

    const loading = loadAccounts();
    logout();
    release?.(
      Response.json({ accounts: [{ id: "after-logout" }], providers: [] })
    );
    await loading;

    expect(state.accounts).toEqual([]);
    expect(element("#accounts-list").innerHTML).not.toContain("after-logout");
  });
});
