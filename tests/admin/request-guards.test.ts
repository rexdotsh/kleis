import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Window } from "happy-dom";

const window = new Window({
  url: "http://localhost/admin/",
  settings: { disableJavaScriptEvaluation: true },
});
window.document.write(
  await Bun.file(
    new URL("../../public/admin/index.html", import.meta.url)
  ).text()
);
const globals = globalThis as Record<string, unknown>;
const names = [
  "window",
  "document",
  "localStorage",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "MutationObserver",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "innerWidth",
  "innerHeight",
  "scrollX",
  "scrollY",
  "fetch",
];
const originals = new Map(
  names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
);
function installGlobals() {
  for (const name of names.filter((name) => name !== "fetch")) {
    let value = name === "window" ? window : Reflect.get(window, name);
    if (
      ["matchMedia", "requestAnimationFrame", "cancelAnimationFrame"].includes(
        name
      )
    )
      value = value.bind(window);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
}
installGlobals();
const data = await import("../../public/admin/app-data.js");
const { renderAccounts, renderKeys, renderOAuthFlow } = await import(
  "../../public/admin/app-render.js"
);
await import("../../public/admin/app.js");
const { state } = data;
const $ = (selector: string) =>
  window.document.querySelector(selector) as unknown as HTMLButtonElement;
const account = {
  id: "account-preview",
  provider: "codex",
  label: "Preview account",
  expiresAt: Date.now() + 3_600_000,
  quota: { data: { provider: "codex", status: {} } },
};
const key = {
  id: "key-preview",
  key: "kleis_fake_preview",
  label: "Preview key",
};
const replacement = {
  ...key,
  id: "replacement-preview",
  key: "kleis_fake_replacement",
};
const tick = () => Bun.sleep(0);
const confirm = (accepted = true) => data.resolveConfirm(accepted);
const keyboard = (key: string, selector = "body") =>
  window.document
    .querySelector(selector)
    ?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true })
    );
const menu = (kind: "account" | "key", action: string) => {
  $(`[data-menu="${kind}"]`).click();
  return $(`#menu [data-action="${action}"]`);
};
function deferred() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return {
    respond: async () => (await promise).clone(),
    release: (response: Response) => release(response),
  };
}
const failure = () => Response.json({ message: "Try again" }, { status: 503 });
const fresh = (path: string) => {
  if (path === "/admin/accounts")
    return Response.json({
      accounts: state.accounts,
      providers: state.providerStatuses,
    });
  if (path === "/admin/keys") return Response.json({ keys: state.keys });
  return Response.json({ usage: [], totals: {} });
};
const signIn = async () => {
  $("#login-token").value = "same-admin-token";
  await data.handleLogin();
  await tick();
};
const snapshot = () =>
  JSON.stringify({
    token: state.token,
    active: state.sessionActive,
    seq: state.sessionRequestSeq,
    accounts: state.accounts,
    keys: state.keys,
    accountUsage: [...state.accountUsageById],
    keyUsage: [...state.keyUsageById],
    details: [...state.usageDetails],
    dashboard: state.dashboardData,
    expanded: state.expandedKeyId,
    revealed: [...state.revealedKeyIds],
    html: [
      "#accounts-list",
      "#keys-list",
      "#dash-content",
      "#toast-container",
      "#login-error",
      "#oauth-flow-active",
    ].map((selector) => $(selector).innerHTML),
  });

describe("admin mutation and session guards", () => {
  beforeEach(() => {
    installGlobals();
    data.logout();
    $("#menu").hidden = true;
    $("#toast-container").replaceChildren();
    state.token = "same-admin-token";
    state.sessionActive = true;
    state.accounts = [structuredClone(account)];
    state.accountsById = new Map([[account.id, state.accounts[0]]]);
    state.providerStatuses = [{ provider: "codex", enabled: true }];
    state.keys = [{ ...key }];
    state.keysById = new Map([[key.id, state.keys[0]]]);
    state.accountsLoaded = true;
    state.keysLoaded = true;
    state.expandedAccountId = account.id;
    state.expandedKeyId = key.id;
    $("#app").classList.add("visible");
    data.switchToTab("accounts");
    renderAccounts();
    renderKeys();
    globals.fetch = async (url: RequestInfo | URL) => fresh(String(url));
  });

  afterEach(async () => {
    data.logout();
    await tick();
    window.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  afterAll(() => window.happyDOM.cancelAsync());

  const entries: {
    name: string;
    run: () => unknown;
    prepare?: () => void;
    confirm?: boolean;
  }[] = [
    {
      name: "create key",
      run: data.createKey,
      prepare: () => data.startCreateKey(),
    },
    {
      name: "save key",
      run: data.saveKeyEdits,
      prepare: () => data.startEditKey(key.id),
    },
    { name: "rotate key", run: () => data.rotateKey(key.id), confirm: true },
    { name: "revoke key", run: () => data.revokeKey(key.id), confirm: true },
    { name: "delete key", run: () => data.deleteKey(key.id), confirm: true },
    {
      name: "save account",
      run: data.saveAccountEdits,
      prepare: () => data.startEditAccount(account.id),
    },
    {
      name: "delete account",
      run: () => data.deleteAccount(account.id),
      confirm: true,
    },
    { name: "refresh account", run: () => data.refreshAccount(account.id) },
    { name: "primary", run: () => data.setPrimary(account.id) },
    {
      name: "provider",
      run: () => data.toggleProvider("codex", false),
      confirm: true,
    },
    {
      name: "reset credit",
      run: () => data.redeemResetCredit(account.id, "credit-preview"),
      confirm: true,
    },
    {
      name: "import",
      run: data.importAccount,
      prepare: () => {
        $("#import-access-token").value = "fake-access";
        $("#import-refresh-token").value = "fake-refresh";
      },
    },
    { name: "OAuth start", run: data.startOAuth },
    {
      name: "OAuth complete",
      run: data.completeOAuth,
      prepare: () => {
        state.activeOAuth = { provider: "claude", state: "flow-preview" };
        renderOAuthFlow(state.activeOAuth, "claude");
        $("#oauth-code").value = "fake-code";
      },
    },
  ];
  for (const entry of entries) {
    test(`${entry.name} is wired to one operation/target lock`, async () => {
      entry.prepare?.();
      const response = deferred();
      let calls = 0;
      globals.fetch = () => {
        calls++;
        return response.respond();
      };
      const pending = entry.run();
      const repeated = entry.run();
      if (entry.confirm) confirm();
      await tick();
      expect(calls).toBe(1);
      response.release(failure());
      await Promise.all([pending, repeated]);
      expect(state.pendingMutations.size).toBe(0);
    });
  }

  test("keyboard and menu share a lock; re-rendered controls stay busy and failure unlocks them", async () => {
    const response = deferred();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return response.respond();
    };
    state.cursorAccountId = account.id;
    keyboard("r");
    const before = $('[data-action="refresh-account"]');
    expect(before.disabled).toBe(true);
    renderAccounts();
    const after = $('[data-action="refresh-account"]');
    expect(after).not.toBe(before);
    expect(after.disabled).toBe(true);
    expect(after.getAttribute("aria-busy")).toBe("true");
    const item = menu("account", "refresh-account");
    expect(item.disabled).toBe(true);
    item.click();
    keyboard("r", "#menu");
    keyboard("Escape", "#menu");
    keyboard("r");
    expect(calls).toBe(1);
    const joined = data.refreshAccount(account.id);
    response.release(failure());
    await joined;
    expect(after.disabled).toBe(false);
    expect(item.disabled).toBe(false);
    after.click();
    await tick();
    expect(calls).toBe(2);
  });

  test("a successful mutation stays locked through its reload", async () => {
    const reload = deferred();
    let calls = 0;
    globals.fetch = (_url: RequestInfo | URL, init: RequestInit) => {
      calls++;
      return init?.method === "POST"
        ? Promise.resolve(Response.json({}))
        : reload.respond();
    };
    const pending = data.refreshAccount(account.id);
    await tick();
    const repeated = data.refreshAccount(account.id);
    expect(calls).toBe(3);
    renderAccounts();
    expect($('[data-action="refresh-account"]').disabled).toBe(true);
    reload.release(Response.json({ accounts: [account], usage: [] }));
    await Promise.all([pending, repeated]);
    expect($('[data-action="refresh-account"]').disabled).toBe(false);
  });

  test("different targets and operations run independently", async () => {
    const response = deferred();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return response.respond();
    };
    data.startEditAccount(account.id);
    const pending = [
      data.refreshAccount(account.id),
      data.refreshAccount("another-preview"),
      data.saveAccountEdits(),
    ];
    expect(calls).toBe(3);
    response.release(failure());
    await Promise.all(pending);
  });

  for (const order of [
    "menu first",
    "rotation first",
    "menu revoke finished",
  ]) {
    test(`rotation and menu/keyboard revoke share one request: ${order}`, async () => {
      const creation = deferred();
      const revocation = deferred();
      let revokes = 0;
      let created = false;
      globals.fetch = (url: RequestInfo | URL, init: RequestInit) => {
        const path = String(url);
        if (path === "/admin/keys" && init?.method === "POST")
          return creation.respond();
        if (path.endsWith("/revoke")) {
          revokes++;
          return revocation.respond();
        }
        if (path === "/admin/keys")
          return Promise.resolve(
            Response.json({
              keys: [
                ...state.keys.filter((value) => value.id !== replacement.id),
                ...(created ? [replacement] : []),
              ],
            })
          );
        return Promise.resolve(fresh(path));
      };
      data.switchToTab("keys");
      state.cursorKeyId = key.id;
      keyboard("r");
      $("#rotate-revoke-old").checked = true;
      confirm();
      await tick();
      if (order === "rotation first") {
        created = true;
        creation.release(Response.json({ key: replacement }));
        await tick();
        renderKeys();
        expect(menu("key", "revoke-key").disabled).toBe(true);
        keyboard("Escape", "#menu");
        keyboard("Backspace");
      } else menu("key", "revoke-key").click();
      confirm();
      await tick();
      expect(revokes).toBe(1);
      if (order === "menu revoke finished") {
        revocation.release(Response.json({}));
        await tick();
      }
      created = true;
      creation.release(Response.json({ key: replacement }));
      await tick();
      expect(revokes).toBe(1);
      revocation.release(Response.json({}));
      await tick();
      expect(state.pendingMutations.size).toBe(0);
      expect($("#toast-container").textContent).toContain(
        "API key rotated and previous key revoked"
      );
      expect($("#toast-container").textContent).not.toContain("failed");
    });
  }

  test("cancelled confirmations unlock; logout also invalidates an accepted confirmation", async () => {
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return Promise.resolve(Response.json({}));
    };
    const cancelled = data.deleteAccount(account.id);
    confirm(false);
    await cancelled;
    expect(state.pendingMutations.size).toBe(0);
    const accepted = data.deleteAccount(account.id);
    confirm();
    data.logout();
    await accepted;
    expect(calls).toBe(0);
  });

  test("a re-rendered OAuth completion stays busy and unlocks on failure", async () => {
    const response = deferred();
    globals.fetch = () => response.respond();
    state.activeOAuth = { provider: "claude", state: "flow-preview" };
    renderOAuthFlow(state.activeOAuth, "claude");
    $("#oauth-code").value = "fake-code";
    const pending = data.completeOAuth();
    const before = $("#btn-oauth-complete");
    renderOAuthFlow(state.activeOAuth, "claude");
    const after = $("#btn-oauth-complete");
    expect(after).not.toBe(before);
    expect(after.disabled).toBe(true);
    response.release(failure());
    await pending;
    expect(after.disabled).toBe(false);
    expect($("#oauth-flow-error").textContent).toContain("Try again");
  });

  test("logout during rotation's shared revoke step suppresses its completion", async () => {
    const response = deferred();
    let calls = 0;
    globals.fetch = () =>
      ++calls === 1
        ? Promise.resolve(Response.json({ key: replacement }))
        : response.respond();
    const pending = data.rotateKey(key.id);
    $("#rotate-revoke-old").checked = true;
    confirm();
    await tick();
    expect(calls).toBe(2);
    data.logout();
    const before = snapshot();
    response.release(Response.json({}));
    await pending;
    expect(snapshot()).toBe(before);
    expect(calls).toBe(2);
  });

  for (const status of [200, 401, 503]) {
    for (const boundary of ["logout", "sign-in"]) {
      test(`a stale mutation's ${status} cannot affect ${boundary} state or start reloads`, async () => {
        const response = deferred();
        let calls = 0;
        globals.fetch = (url: RequestInfo | URL) =>
          ++calls === 1
            ? response.respond()
            : Promise.resolve(fresh(String(url)));
        const pending = data.refreshAccount(account.id);
        if (boundary === "logout") data.logout();
        else await signIn();
        const before = snapshot();
        const callsBefore = calls;
        response.release(Response.json({ message: "Stale error" }, { status }));
        await pending;
        expect(snapshot()).toBe(before);
        expect(calls).toBe(callsBefore);
      });
    }
  }

  test("an old completion cannot unlock the same operation in the next session", async () => {
    const old = deferred();
    const current = deferred();
    let calls = 0;
    globals.fetch = () => (++calls === 1 ? old.respond() : current.respond());
    const previous = data.refreshAccount(account.id);
    data.logout();
    state.token = "same-admin-token";
    const pending = data.refreshAccount(account.id);
    old.release(Response.json({}));
    await previous;
    expect(state.pendingMutations.size).toBe(1);
    expect($('[data-action="refresh-account"]').disabled).toBe(true);
    const repeat = data.refreshAccount(account.id);
    expect(calls).toBe(2);
    current.release(failure());
    await Promise.all([pending, repeat]);
  });

  for (const boundary of ["logout", "sign-in"]) {
    test(`usage, lists and detail loads are invalidated by ${boundary}`, async () => {
      const response = deferred();
      globals.fetch = () => response.respond();
      state.expandedAccountId = null;
      state.expandedKeyId = null;
      const pending = [
        data.loadAccounts(),
        data.loadKeys(),
        data.loadAccountUsage(),
        data.loadKeyUsage(),
        data.loadDashboard(),
        data.requestUsageDetail("key", key.id),
        data.requestDailyTokens(account.id),
      ];
      if (boundary === "logout") data.logout();
      else {
        globals.fetch = async (url: RequestInfo | URL) => fresh(String(url));
        await signIn();
      }
      const before = snapshot();
      response.release(
        Response.json({
          accounts: [account],
          keys: [key],
          usage: [
            {
              apiKeyId: key.id,
              providerAccountId: account.id,
              requestCount: 99,
            },
          ],
          totals: { requestCount: 99 },
          windowMs: 123,
        })
      );
      await Promise.all(pending);
      expect(snapshot()).toBe(before);
    });
  }

  test("a mutation-triggered list reload cannot repopulate signed-out state", async () => {
    const reload = deferred();
    globals.fetch = (_url: RequestInfo | URL, init: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(Response.json({}))
        : reload.respond();
    const pending = data.refreshAccount(account.id);
    await tick();
    data.logout();
    const before = snapshot();
    reload.release(Response.json({ accounts: [account], usage: [] }));
    await pending;
    expect(snapshot()).toBe(before);
  });

  test("a late key creation cannot reveal its key after logout", async () => {
    const response = deferred();
    globals.fetch = () => response.respond();
    data.startCreateKey();
    const pending = data.createKey();
    data.logout();
    const before = snapshot();
    response.release(Response.json({ key: replacement }));
    await pending;
    expect(snapshot()).toBe(before);
  });

  test("OAuth cancellation permits a new start without accepting or unlocking the old one", async () => {
    const old = deferred();
    const current = deferred();
    let calls = 0;
    globals.fetch = () => (++calls === 1 ? old.respond() : current.respond());
    const previous = data.startOAuth();
    data.cancelOAuthFlow();
    const pending = data.startOAuth();
    old.release(Response.json({ state: "stale-flow" }));
    await previous;
    expect(state.activeOAuth).toBeNull();
    expect($("#btn-oauth-start").disabled).toBe(true);
    current.release(failure());
    await pending;
    expect($("#btn-oauth-start").disabled).toBe(false);
  });
});
