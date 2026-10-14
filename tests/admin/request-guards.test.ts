import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const fakeElement = () => {
  const classes = new Set<string>();
  const children: unknown[] = [];
  return {
    value: "",
    disabled: false,
    hidden: true,
    innerHTML: "",
    textContent: "",
    checked: false,
    dataset: {},
    style: { display: "" },
    offsetWidth: 240,
    offsetHeight: 120,
    children,
    classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, on = !classes.has(name)) =>
        on ? classes.add(name) : classes.delete(name),
    },
    append: (...items: unknown[]) => children.push(...items),
    appendChild: (child: unknown) => children.push(child),
    querySelector: () => null,
    setAttribute: () => undefined,
    focus: () => undefined,
    remove: () => undefined,
  };
};
const elements = new Map<string, ReturnType<typeof fakeElement>>();
const element = (selector: string) => {
  let current = elements.get(selector);
  if (!current) {
    current = fakeElement();
    elements.set(selector, current);
  }
  return current;
};

const globals = globalThis as Record<string, unknown>;
const originalGlobals = Object.fromEntries(
  [
    "document",
    "window",
    "localStorage",
    "location",
    "history",
    "innerWidth",
    "innerHeight",
    "scrollX",
    "scrollY",
    "fetch",
  ].map((key) => [key, globals[key]])
);
const installGlobals = () => {
  globals.document = {
    querySelector: element,
    querySelectorAll: () => [],
    createElement: fakeElement,
  };
  globals.window = { location: { origin: "http://localhost" } };
  globals.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  globals.location = { hash: "" };
  globals.history = { replaceState: () => undefined };
  globals.innerWidth = 1200;
  globals.innerHeight = 800;
  globals.scrollX = 0;
  globals.scrollY = 0;
};

installGlobals();
const {
  cancelOAuthFlow,
  completeOAuth,
  createKey,
  deleteAccount,
  deleteKey,
  handleLogin,
  importAccount,
  loadAccounts,
  loadAccountUsage,
  loadDashboard,
  loadKeys,
  loadKeyUsage,
  logout,
  reauthorizeAccount,
  redeemResetCredit,
  refreshAccount,
  requestDailyTokens,
  requestUsageDetail,
  resolveConfirm,
  revokeKey,
  rotateKey,
  saveAccountEdits,
  saveKeyEdits,
  setPrimary,
  startOAuth,
  state,
  toggleProvider,
} = await import("../../public/admin/app-data.js");
const { renderAccounts, renderKeys } = await import(
  "../../public/admin/app-render.js"
);

const deferredResponse = () => {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return {
    respond: async () => (await promise).clone(),
    release: (response: Response) => release(response),
  };
};
const account = { id: "account-preview", provider: "codex", label: "Preview" };
const key = { id: "key-preview", key: "kleis_fake_preview", label: "Preview" };
const seedForms = () => {
  state.accounts = [{ ...account }];
  state.accountsById = new Map([[account.id, state.accounts[0]]]);
  state.providerStatuses = [{ provider: "codex", enabled: true }];
  state.keys = [{ ...key }];
  state.keysById = new Map([[key.id, state.keys[0]]]);
  state.editingAccountId = account.id;
  state.editingKeyId = key.id;
  state.creatingKey = true;
  element("#oauth-provider").value = "claude";
  element("#oauth-claude-mode").value = "max";
  element("#oauth-code").value = "fake-code";
  element("#import-provider").value = "codex";
  element("#import-access-token").value = "fake-access";
  element("#import-refresh-token").value = "fake-refresh";
};
type MutationCase = {
  name: string;
  run: () => unknown;
  confirm: boolean;
  prepare?: () => void;
};
const mutations: MutationCase[] = [
  { name: "create key", run: createKey, confirm: false },
  { name: "save key", run: saveKeyEdits, confirm: false },
  { name: "rotate key", run: () => rotateKey(key.id, null), confirm: true },
  { name: "revoke key", run: () => revokeKey(key.id), confirm: true },
  { name: "delete key", run: () => deleteKey(key.id), confirm: true },
  { name: "save account", run: saveAccountEdits, confirm: false },
  {
    name: "delete account",
    run: () => deleteAccount(account.id),
    confirm: true,
  },
  {
    name: "refresh account",
    run: () => refreshAccount(account.id),
    confirm: false,
  },
  { name: "set primary", run: () => setPrimary(account.id), confirm: false },
  {
    name: "toggle provider",
    run: () => toggleProvider("codex", false),
    confirm: true,
  },
  {
    name: "reset credit",
    run: () => redeemResetCredit(account.id, "credit-preview"),
    confirm: true,
  },
  { name: "import account", run: importAccount, confirm: false },
  { name: "start OAuth", run: startOAuth, confirm: false },
  {
    name: "complete OAuth",
    run: completeOAuth,
    confirm: false,
    prepare: () => {
      state.activeOAuth = { provider: "claude", state: "flow-preview" };
    },
  },
];

const freshResponse = (path: string) => {
  if (path === "/admin/accounts")
    return Response.json({ accounts: [], providers: [] });
  if (path === "/admin/keys") return Response.json({ keys: [] });
  return Response.json({ usage: [], totals: {} });
};
const signIn = async () => {
  element("#login-token").value = "same-admin-token";
  await handleLogin();
  await Bun.sleep(0);
};
const snapshot = () =>
  JSON.stringify({
    state: {
      ...state,
      accountsById: [...state.accountsById],
      keysById: [...state.keysById],
      accountUsageById: [...state.accountUsageById],
      keyUsageById: [...state.keyUsageById],
      usageDetails: [...state.usageDetails],
      visibleUsageDetails: [...state.visibleUsageDetails],
      pendingMutations: [...state.pendingMutations],
      pendingResetRedemptions: [...state.pendingResetRedemptions],
      revealedKeyIds: [...state.revealedKeyIds],
    },
    elements: [...elements],
  });

describe("admin mutation and session guards", () => {
  beforeEach(() => {
    installGlobals();
    elements.clear();
    logout();
    state.token = "same-admin-token";
    state.sessionActive = true;
    state.accountsLoaded = true;
    state.keysLoaded = true;
    seedForms();
  });

  afterEach(() => {
    logout();
    Object.assign(globals, originalGlobals);
  });

  for (const mutation of mutations) {
    test(`${mutation.name} ignores rapid repeats across re-renders and unlocks on failure`, async () => {
      mutation.prepare?.();
      const response = deferredResponse();
      let calls = 0;
      globals.fetch = () => {
        calls++;
        return response.respond();
      };

      const first = mutation.run();
      const repeated = mutation.run();
      if (mutation.confirm) resolveConfirm(true);
      await Bun.sleep(0);
      expect(calls).toBe(1);
      renderAccounts();
      renderKeys();
      for (const [selector, current] of elements) {
        if (current.disabled) elements.set(selector, fakeElement());
      }
      const afterRender = mutation.run();
      expect(element("#confirm").hidden).toBe(true);
      resolveConfirm(true);
      await Bun.sleep(0);
      expect(calls).toBe(1);

      response.release(
        Response.json({ message: "Try again" }, { status: 503 })
      );
      await Promise.all([first, repeated, afterRender]);
      expect(state.pendingMutations.size).toBe(0);
      const retry = mutation.run();
      if (mutation.confirm) resolveConfirm(true);
      await retry;
      expect(calls).toBe(2);
      expect(state.pendingMutations.size).toBe(0);
    });

    for (const status of [200, 401, 503]) {
      for (const newSession of [false, true]) {
        test(`${mutation.name} ignores ${status} after ${newSession ? "same-token sign-in" : "logout"}`, async () => {
          mutation.prepare?.();
          const response = deferredResponse();
          const calls: string[] = [];
          globals.fetch = (url: RequestInfo | URL) => {
            const path = String(url);
            calls.push(path);
            return calls.length === 1
              ? response.respond()
              : Promise.resolve(freshResponse(path));
          };
          const pending = mutation.run();
          if (mutation.confirm) resolveConfirm(true);
          await Bun.sleep(0);
          expect(calls).toHaveLength(1);
          if (newSession) await signIn();
          else logout();
          const before = snapshot();
          const callsBefore = [...calls];
          response.release(
            Response.json(
              {
                key: { ...key, id: "stale-key" },
                state: "stale-flow",
                authorizationUrl: "https://example.com/oauth",
                message: "Stale error",
                redeemRequestId: "stale-redemption",
              },
              { status }
            )
          );
          await pending;
          expect(calls).toEqual(callsBefore);
          expect(snapshot()).toBe(before);
        });
      }
    }
  }

  test("different targets and operations can run independently", async () => {
    const response = deferredResponse();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return response.respond();
    };
    const requests = [
      refreshAccount(account.id),
      refreshAccount("another-account"),
      saveAccountEdits(),
    ];
    expect(calls).toBe(3);
    response.release(Response.json({ message: "Try again" }, { status: 503 }));
    await Promise.all(requests);
  });

  test("a cancelled confirmation unlocks without sending a request", async () => {
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return Promise.resolve(
        Response.json({ message: "Try again" }, { status: 503 })
      );
    };
    const cancelled = deleteAccount(account.id);
    resolveConfirm(false);
    await cancelled;
    expect(calls).toBe(0);
    const retry = deleteAccount(account.id);
    resolveConfirm(true);
    await retry;
    expect(calls).toBe(1);
  });

  test("logout invalidates accepted confirmations before their continuations run", async () => {
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return Promise.resolve(Response.json({}));
    };
    const pending = deleteAccount(account.id);
    resolveConfirm(true);
    logout();
    await pending;
    expect(calls).toBe(0);
  });

  test("logout invalidates a pending reauthorization confirmation", async () => {
    state.activeOAuth = { provider: "claude", state: "flow-preview" };
    const pending = reauthorizeAccount(account.id);
    const repeated = reauthorizeAccount(account.id);
    resolveConfirm(true);
    logout();
    const before = snapshot();
    await Promise.all([pending, repeated]);
    expect(snapshot()).toBe(before);
  });

  test("an old completion cannot unlock the same operation in a new session", async () => {
    const oldResponse = deferredResponse();
    const newResponse = deferredResponse();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return calls === 1 ? oldResponse.respond() : newResponse.respond();
    };
    const oldRequest = refreshAccount(account.id);
    logout();
    state.sessionActive = true;
    state.token = "same-admin-token";
    const newRequest = refreshAccount(account.id);
    oldResponse.release(Response.json({}));
    await oldRequest;
    expect(state.pendingMutations.size).toBe(1);
    expect(
      element(
        `[data-action="refresh-account"][data-account-id="${account.id}"]`
      ).disabled
    ).toBe(true);
    await refreshAccount(account.id);
    expect(calls).toBe(2);
    newResponse.release(
      Response.json({ message: "Try again" }, { status: 503 })
    );
    await newRequest;
    expect(state.pendingMutations.size).toBe(0);
  });

  test("OAuth cancellation allows a new start without accepting the old result", async () => {
    const oldResponse = deferredResponse();
    const newResponse = deferredResponse();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return calls === 1 ? oldResponse.respond() : newResponse.respond();
    };
    const oldStart = startOAuth();
    cancelOAuthFlow();
    const newStart = startOAuth();
    oldResponse.release(Response.json({ state: "stale" }));
    await oldStart;
    expect(state.activeOAuth).toBeNull();
    expect(element("#btn-oauth-start").disabled).toBe(true);
    newResponse.release(
      Response.json({ message: "Try again" }, { status: 503 })
    );
    await newStart;
    expect(element("#btn-oauth-start").disabled).toBe(false);
  });

  test("the operation stays locked until its successful reload finishes", async () => {
    const response = deferredResponse();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return calls === 1
        ? Promise.resolve(Response.json({}))
        : response.respond();
    };
    const pending = refreshAccount(account.id);
    await Bun.sleep(0);
    expect(calls).toBe(3);
    await refreshAccount(account.id);
    expect(calls).toBe(3);
    response.release(Response.json({ accounts: [], usage: [] }));
    await pending;
    expect(state.pendingMutations.size).toBe(0);
    const retry = refreshAccount(account.id);
    await retry;
    expect(calls).toBe(6);
  });

  test("logout during rotation's revoke step suppresses its result and reload", async () => {
    const response = deferredResponse();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return calls === 1
        ? Promise.resolve(Response.json({ key }))
        : response.respond();
    };
    const pending = rotateKey(key.id, null);
    element("#rotate-revoke-old").checked = true;
    resolveConfirm(true);
    await Bun.sleep(0);
    expect(calls).toBe(2);
    logout();
    const before = snapshot();
    response.release(Response.json({}));
    await pending;
    expect(calls).toBe(2);
    expect(snapshot()).toBe(before);
  });

  for (const mutation of [
    { name: "account", run: () => refreshAccount(account.id) },
    { name: "key", run: createKey },
  ]) {
    test(`${mutation.name} reload started by a mutation is invalidated by logout`, async () => {
      const response = deferredResponse();
      let calls = 0;
      globals.fetch = () => {
        calls++;
        return calls === 1
          ? Promise.resolve(Response.json({ key }))
          : response.respond();
      };
      const pending = mutation.run();
      await Bun.sleep(0);
      expect(calls).toBe(3);
      logout();
      const before = snapshot();
      response.release(
        Response.json({ accounts: [account], keys: [key], usage: [] })
      );
      await pending;
      expect(snapshot()).toBe(before);
    });
  }

  const loads = [
    { name: "account usage", run: loadAccountUsage },
    { name: "key usage", run: loadKeyUsage },
    { name: "dashboard", run: loadDashboard },
    { name: "accounts", run: loadAccounts },
    { name: "keys", run: loadKeys },
    { name: "usage detail", run: () => requestUsageDetail("key", key.id) },
    { name: "daily tokens", run: () => requestDailyTokens(account.id) },
  ];
  for (const load of loads) {
    for (const newSession of [false, true]) {
      for (const status of [200, 401, 503]) {
        test(`${load.name} ignores ${status} after ${newSession ? "a new sign-in begins" : "logout"}`, async () => {
          const response = deferredResponse();
          globals.fetch = () => response.respond();
          const pending = load.run();
          if (newSession) {
            globals.fetch = (url: RequestInfo | URL) =>
              Promise.resolve(freshResponse(String(url)));
            await signIn();
          } else logout();
          const before = snapshot();
          response.release(
            Response.json(
              {
                usage: [
                  {
                    apiKeyId: key.id,
                    providerAccountId: account.id,
                    requestCount: 99,
                  },
                ],
                windowMs: 123,
                accounts: [{ ...account, id: "stale-account" }],
                keys: [{ ...key, id: "stale-key" }],
                totals: { requestCount: 99 },
                daily: [{ totalTokens: 99 }],
                message: "Stale error",
              },
              { status }
            )
          );
          await pending;
          expect(snapshot()).toBe(before);
        });
      }
    }
  }

  for (const kind of ["account", "key"]) {
    test(`logout invalidates ${kind} usage waiting for expanded details`, async () => {
      const response = deferredResponse();
      const id = kind === "account" ? account.id : key.id;
      state.expandedAccountId = kind === "account" ? id : null;
      state.expandedKeyId = kind === "key" ? id : null;
      globals.fetch = (url: RequestInfo | URL) =>
        String(url).includes(`/${id}/usage?`)
          ? response.respond()
          : Promise.resolve(
              Response.json({
                usage: [
                  { providerAccountId: id, apiKeyId: id, requestCount: 1 },
                ],
              })
            );
      const pending = kind === "account" ? loadAccountUsage() : loadKeyUsage();
      await Bun.sleep(0);
      expect(state.usageDetails.size).toBe(1);
      logout();
      const before = snapshot();
      response.release(Response.json({ models: [] }));
      await pending;
      expect(snapshot()).toBe(before);
    });
  }

  test("logout invalidates quota loads started by an account reload", async () => {
    const response = deferredResponse();
    globals.fetch = (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/admin/accounts")
        return Promise.resolve(Response.json({ accounts: [account] }));
      if (path === "/admin/accounts/quotas") return response.respond();
      return Promise.resolve(freshResponse(path));
    };
    await loadAccounts();
    logout();
    const before = snapshot();
    response.release(
      Response.json({ quotas: { [account.id]: { fetchedAt: 99, data: {} } } })
    );
    await Bun.sleep(0);
    expect(snapshot()).toBe(before);
  });

  for (const status of [200, 401, 503]) {
    test(`a ${status} verification result after logout cannot sign in or show an error`, async () => {
      const response = deferredResponse();
      globals.fetch = () => response.respond();
      element("#login-token").value = "pending-token";
      const pending = handleLogin();
      logout();
      const before = snapshot();
      response.release(Response.json({ message: "Stale error" }, { status }));
      await pending;
      expect(snapshot()).toBe(before);
      expect(element("#login-btn").disabled).toBe(false);
    });
  }
});
