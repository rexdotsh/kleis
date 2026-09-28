import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type FakeElement = {
  value: string;
  disabled: boolean;
  innerHTML: string;
  textContent: string;
  checked: boolean;
  dataset: Record<string, string>;
  style: { display: string };
  classList: {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
  };
  querySelector: () => null;
  appendChild: () => void;
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
      dataset: {},
      style: { display: "none" },
      classList: {
        contains: () => false,
        add: () => undefined,
        remove: () => undefined,
      },
      querySelector: () => null,
      appendChild: () => undefined,
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

const {
  cancelOAuthFlow,
  loadAccounts,
  logout,
  openEditKeyModal,
  saveKeyEdits,
  startOAuth,
  state,
} = await import("../../public/admin/app-data.js");

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

  test("editing a key preserves an account scope missing from the loaded list", async () => {
    const keyId = "key-scoped";
    const accountId = "missing-account";
    const key = {
      id: keyId,
      label: "scoped key",
      providerScopes: null,
      accountScopes: [accountId],
      modelScopes: null,
      expiresAt: null,
    };
    state.keysById = new Map([[keyId, key]]);
    state.accounts = [];
    const preservedInput = {
      value: accountId,
      checked: true,
      dataset: { preservedScope: "true" },
    };
    globalThis.document = {
      querySelector: element,
      querySelectorAll: (selector: string) =>
        selector === ".edit-key-scope-account" ? [preservedInput] : [],
      createElement: () => ({
        textContent: "",
        get innerHTML() {
          return this.textContent;
        },
        classList: { add: () => undefined },
        remove: () => undefined,
      }),
    } as unknown as Document;

    openEditKeyModal(keyId);
    expect(element("#edit-key-account-scopes").innerHTML).toContain(
      'value="missing-account" class="edit-key-scope-account" data-preserved-scope="true" checked'
    );
    expect(preservedInput.checked).toBe(true);

    let patchedBody: { accountScopes?: string[] | null } | undefined;
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === `/admin/keys/${keyId}`) {
        patchedBody = JSON.parse(String(init?.body));
        return Promise.resolve(Response.json({ key }));
      }
      if (path === "/admin/keys") {
        return Promise.resolve(Response.json({ keys: [] }));
      }
      if (path.startsWith("/admin/keys/usage?")) {
        return Promise.resolve(Response.json({ usage: [] }));
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }) as typeof fetch;
    element("#edit-key-label").value = "renamed";
    await saveKeyEdits();

    expect(patchedBody?.accountScopes).toEqual([accountId]);
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
