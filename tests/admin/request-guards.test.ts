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
const {
  deleteAccount,
  importAccount,
  loadAccounts,
  loadAccountUsage,
  redeemResetCredit,
  refreshAccount,
  saveAccountEdits,
  setPrimary,
  startEditAccount,
  toggleProvider,
} = await import("../../public/admin/app-accounts.js");
const { renderAccounts } =
  await import("../../public/admin/app-accounts-render.js");
const {
  cancelOAuthFlow,
  logout,
  resolveConfirm,
  runAction,
  state,
  FREE_TIER_CURSOR_ID,
  setShowFreeTier,
} = await import("../../public/admin/app-core.js");
const {
  createKey,
  deleteKey,
  loadKeys,
  loadKeyUsage,
  revokeKey,
  rotateKey,
  saveKeyEdits,
  startCreateKey,
  startEditKey,
} = await import("../../public/admin/app-keys.js");
const { renderKeys, keyAccessHtml, selectedAccountScopes } =
  await import("../../public/admin/app-keys-render.js");
const { renderAttention, usageSlotHtml } =
  await import("../../public/admin/app-usage-render.js");
const { moveCursor, showAccount } =
  await import("../../public/admin/app-input.js");
const { completeOAuth, handleLogin, renderOAuthFlow, startOAuth } =
  await import("../../public/admin/app-oauth.js");
const { loadDashboard, requestDailyTokens, requestUsageDetail, switchToTab } =
  await import("../../public/admin/app-usage.js");
await import("../../public/admin/app.js");
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
const confirm = (accepted = true) => resolveConfirm(accepted);
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
  await handleLogin();
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
    logout();
    setShowFreeTier(false);
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
    switchToTab("accounts");
    renderAccounts();
    renderKeys();
    globals.fetch = async (url: RequestInfo | URL) => fresh(String(url));
  });

  afterEach(async () => {
    logout();
    await tick();
    await window.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  afterAll(() => window.happyDOM.cancelAsync());

  test("background actions report unexpected rejections", async () => {
    const reported: unknown[] = [];
    const consoleError = console.error;
    console.error = (error: unknown) => reported.push(error);
    const failure = new Error("Background action failed");
    try {
      runAction(Promise.reject(failure));
      await tick();
    } finally {
      console.error = consoleError;
    }
    expect(reported).toEqual([failure]);
    expect($("#toast-container").textContent).toContain(
      "Background action failed"
    );
    expect($("#toast-container .toast.error")).not.toBeNull();
  });

  const entries: {
    name: string;
    run: () => unknown;
    prepare?: () => void;
    confirm?: boolean;
  }[] = [
    {
      name: "create key",
      run: createKey,
      prepare: () => startCreateKey(),
    },
    {
      name: "save key",
      run: saveKeyEdits,
      prepare: () => startEditKey(key.id),
    },
    { name: "rotate key", run: () => rotateKey(key.id), confirm: true },
    { name: "revoke key", run: () => revokeKey(key.id), confirm: true },
    { name: "delete key", run: () => deleteKey(key.id), confirm: true },
    {
      name: "save account",
      run: saveAccountEdits,
      prepare: () => startEditAccount(account.id),
    },
    {
      name: "delete account",
      run: () => deleteAccount(account.id),
      confirm: true,
    },
    { name: "refresh account", run: () => refreshAccount(account.id) },
    { name: "primary", run: () => setPrimary(account.id) },
    {
      name: "provider",
      run: () => toggleProvider("codex", false),
      confirm: true,
    },
    {
      name: "reset credit",
      run: () => redeemResetCredit(account.id, "credit-preview"),
      confirm: true,
    },
    {
      name: "import",
      run: importAccount,
      prepare: () => {
        $("#import-access-token").value = "fake-access";
        $("#import-refresh-token").value = "fake-refresh";
      },
    },
    { name: "OAuth start", run: startOAuth },
    {
      name: "OAuth complete",
      run: completeOAuth,
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
    const joined = refreshAccount(account.id);
    response.release(failure());
    await joined;
    expect(after.disabled).toBe(false);
    expect(item.disabled).toBe(false);
    after.click();
    await tick();
    expect(calls).toBe(2);
  });

  test("clicking Import shows it busy until the import settles", async () => {
    const response = deferred();
    let calls = 0;
    globals.fetch = () => {
      calls++;
      return response.respond();
    };
    $("#import-access-token").value = "fake-access";
    $("#import-refresh-token").value = "fake-refresh";
    const button = $("#btn-import-account");
    button.click();
    await tick();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    button.click();
    await tick();
    expect(calls).toBe(1);
    response.release(failure());
    await tick();
    await tick();
    expect(button.disabled).toBe(false);
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
    const pending = refreshAccount(account.id);
    await tick();
    const repeated = refreshAccount(account.id);
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
    startEditAccount(account.id);
    const pending = [
      refreshAccount(account.id),
      refreshAccount("another-preview"),
      saveAccountEdits(),
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
      switchToTab("keys");
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
    const cancelled = deleteAccount(account.id);
    confirm(false);
    await cancelled;
    expect(state.pendingMutations.size).toBe(0);
    const accepted = deleteAccount(account.id);
    confirm();
    logout();
    await accepted;
    expect(calls).toBe(0);
  });

  test("a re-rendered OAuth completion stays busy and unlocks on failure", async () => {
    const response = deferred();
    globals.fetch = () => response.respond();
    state.activeOAuth = { provider: "claude", state: "flow-preview" };
    renderOAuthFlow(state.activeOAuth, "claude");
    $("#oauth-code").value = "fake-code";
    const pending = completeOAuth();
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
    const pending = rotateKey(key.id);
    $("#rotate-revoke-old").checked = true;
    confirm();
    await tick();
    expect(calls).toBe(2);
    logout();
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
        const pending = refreshAccount(account.id);
        if (boundary === "logout") logout();
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
    const previous = refreshAccount(account.id);
    logout();
    state.token = "same-admin-token";
    const pending = refreshAccount(account.id);
    old.release(Response.json({}));
    await previous;
    expect(state.pendingMutations.size).toBe(1);
    expect($('[data-action="refresh-account"]').disabled).toBe(true);
    const repeat = refreshAccount(account.id);
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
        loadAccounts(),
        loadKeys(),
        loadAccountUsage(),
        loadKeyUsage(),
        loadDashboard(),
        requestUsageDetail("key", key.id),
        requestDailyTokens(account.id),
      ];
      if (boundary === "logout") logout();
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
    const pending = refreshAccount(account.id);
    await tick();
    logout();
    const before = snapshot();
    reload.release(Response.json({ accounts: [account], usage: [] }));
    await pending;
    expect(snapshot()).toBe(before);
  });

  test("a late key creation cannot reveal its key after logout", async () => {
    const response = deferred();
    globals.fetch = () => response.respond();
    startCreateKey();
    const pending = createKey();
    logout();
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
    const previous = startOAuth();
    cancelOAuthFlow();
    const pending = startOAuth();
    old.release(Response.json({ state: "stale-flow" }));
    await previous;
    expect(state.activeOAuth).toBeNull();
    expect($("#btn-oauth-start").disabled).toBe(true);
    current.release(failure());
    await pending;
    expect($("#btn-oauth-start").disabled).toBe(false);
  });

  describe("free-tier visibility", () => {
    const all = (selector: string) =>
      Array.from(window.document.querySelectorAll(selector));
    const codex = (id: string, planType: string | null = "free") => ({
      ...account,
      id,
      label: id,
      createdAt: 1,
      quota: {
        fetchedAt: Date.now(),
        data: { provider: "codex", status: { planType } },
      },
    });
    beforeEach(() => {
      const accounts = [
        { ...codex("primary-free"), isPrimary: true },
        codex("paid", "plus"),
        codex("unknown", null),
        codex("idle-free"),
        codex("traffic-free"),
        {
          ...codex("claude-free"),
          provider: "claude",
          profile: {
            fetchedAt: Date.now(),
            data: { organizationType: "claude_free", plan: null },
          },
        },
      ];
      state.expandedAccountId = null;
      state.expandedKeyId = null;
      state.overviewReady = true;
      state.accounts = accounts;
      state.accountsById = new Map(accounts.map((entry) => [entry.id, entry]));
      state.accountUsageById = new Map([["traffic-free", { requestCount: 2 }]]);
    });

    test("groups idle free accounts at the bottom and reveals search matches", () => {
      renderAccounts();
      expect(
        all("#accounts-list .t-acc[data-account-id]").map((row) =>
          row.getAttribute("data-account-id")
        )
      ).toEqual(["primary-free", "paid", "unknown", "traffic-free"]);
      expect($(".free-tier-heading .group-name").textContent).toBe(
        "Free tier2"
      );
      expect($(".free-tier-heading").getAttribute("aria-expanded")).toBe(
        "false"
      );
      expect($("#free-tier-rows").hidden).toBe(true);
      expect($("#accounts-list").lastElementChild?.className).toBe(
        "free-tier-group"
      );
      state.accountFilter = "claude-free";
      renderAccounts();
      expect(
        $("#accounts-list .t-acc[data-account-id]").dataset.accountId
      ).toBe("claude-free");
      expect(state.showFreeTier).toBe(false);
    });

    test("remembers the group toggle, preserves focus, and includes expanded rows in keyboard navigation", () => {
      renderAccounts();
      $(".free-tier-heading").focus();
      $(".free-tier-heading").click();
      expect(state.showFreeTier).toBe(true);
      expect(window.localStorage.getItem("kleis_show_free_tier")).toBe("true");
      expect(window.document.activeElement).toBe($(".free-tier-heading"));
      expect(all("#free-tier-rows .t-acc[data-account-id]")).toHaveLength(2);
      state.cursorAccountId = "traffic-free";
      moveCursor("accounts", 1);
      expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
      moveCursor("accounts", 1);
      expect(state.cursorAccountId).toBe("idle-free");
      $(".free-tier-heading").click();
      expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
      expect(all("#free-tier-rows .t-acc[data-account-id]")).toHaveLength(0);
      expect(window.localStorage.getItem("kleis_show_free_tier")).toBe("false");
    });

    test("hides picker noise without losing existing or unsaved pins", () => {
      expect(keyAccessHtml("create")).not.toContain('value="idle-free"');
      expect(keyAccessHtml("create")).toContain('value="primary-free"');
      expect(
        keyAccessHtml("edit", { id: "pinned", accountScopes: ["idle-free"] })
      ).toContain('value="idle-free" selected');
      state.creatingKey = true;
      renderKeys();
      $("#key-label").value = "Unsaved label";
      $("#keys-list [data-action='toggle-free-tier']").click();
      expect(state.showFreeTier).toBe(true);
      $(".key-account-pin[data-provider='codex']").value = "idle-free";
      $("#keys-list [data-action='toggle-free-tier']").click();
      expect(state.showFreeTier).toBe(false);
      expect($("#key-label").value).toBe("Unsaved label");
      expect(selectedAccountScopes("create")).toEqual(["idle-free"]);
      expect($(".key-account-pin[data-provider='codex']").value).toBe(
        "idle-free"
      );
      expect($(".free-tier-heading").getAttribute("aria-expanded")).toBe(
        "false"
      );
    });

    test("never conceals traffic, removed accounts, or not-routed errors in by-account usage", () => {
      const id = "usage-key";
      state.usageDetails.set(`key:${id}:${state.keyUsageWindowMs}`, {
        data: {
          totals: { requestCount: 4 },
          accounts: [
            { providerAccountId: "idle-free", requestCount: 1 },
            { providerAccountId: "claude-free", requestCount: 0 },
            { providerAccountId: "removed", requestCount: 1 },
            { providerAccountId: "__missing__", requestCount: 2 },
          ],
        },
      });
      const html = usageSlotHtml("key", id);
      expect(html).toContain("idle-free");
      expect(html).not.toContain("claude-free");
      expect(html).toContain("Removed account");
      expect(html).toContain("Not routed");
      setShowFreeTier(true);
      expect(usageSlotHtml("key", id)).toContain("claude-free");
    });

    test("hides idle free alerts but retains primary and traffic alerts", () => {
      for (const entry of state.accounts) entry.expiresAt = 1;
      renderAttention();
      const html = $("#attention").innerHTML;
      expect(html).not.toContain('data-account-id="idle-free"');
      expect(html).toContain('data-account-id="primary-free"');
      expect(html).toContain('data-account-id="traffic-free"');
      setShowFreeTier(true);
      renderAttention();
      expect($("#attention").innerHTML).toContain(
        'data-account-id="idle-free"'
      );
    });

    test("following an account link reveals a tucked-away free account", async () => {
      await showAccount("idle-free");
      expect(state.showFreeTier).toBe(true);
      expect(state.expandedAccountId).toBe("idle-free");
      expect($("#free-tier-rows [data-detail-for='idle-free']")).not.toBeNull();
    });

    test("following a visible free account leaves the preference unchanged", async () => {
      await showAccount("traffic-free");
      expect(state.showFreeTier).toBe(false);
      expect(state.expandedAccountId).toBe("traffic-free");
      expect(
        $("#accounts-list [data-detail-for='traffic-free']")
      ).not.toBeNull();
    });

    test.each([
      ["j", "k"],
      ["ArrowDown", "ArrowUp"],
    ])(
      "%s / %s navigate through the disclosure and its expanded rows",
      (next, previous) => {
        const requests: string[] = [];
        globals.fetch = async (url: RequestInfo | URL) => {
          requests.push(String(url));
          return fresh(String(url));
        };
        renderAccounts();
        $("#accounts-list .row[data-account-id='traffic-free']").focus();
        keyboard(next);
        expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
        expect(window.document.activeElement).toBe($(".free-tier-heading"));
        keyboard("r");
        keyboard("Enter", ".free-tier-heading");
        expect(state.showFreeTier).toBe(true);
        expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
        keyboard(next);
        expect(state.cursorAccountId).toBe("idle-free");
        keyboard(previous);
        expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
        keyboard(" ", ".free-tier-heading");
        expect(state.showFreeTier).toBe(false);
        keyboard(previous);
        expect(state.cursorAccountId).toBe("traffic-free");
        keyboard(next);
        keyboard(next);
        expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
        keyboard("o");
        expect(state.showFreeTier).toBe(true);
        expect(requests).toEqual([]);
      }
    );

    test("the disclosure is navigable when all accounts are tucked away", () => {
      state.accounts = [codex("idle-free")];
      state.accountsById = new Map([["idle-free", state.accounts[0]]]);
      state.accountUsageById.clear();
      renderAccounts();
      keyboard("j");
      expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
      keyboard("Enter", ".free-tier-heading");
      keyboard("j");
      expect(state.cursorAccountId).toBe("idle-free");
      keyboard("k");
      expect(state.cursorAccountId).toBe(FREE_TIER_CURSOR_ID);
    });

    test("stale free profiles keep upgraded accounts in lists and pickers", () => {
      state.accountsById.get("claude-free").profile.fetchedAt =
        Date.now() - 3 * 86_400_000;
      renderAccounts();
      expect(
        $("#accounts-list .row[data-account-id='claude-free']").closest(
          "#free-tier-rows"
        )
      ).toBeNull();
      expect(keyAccessHtml("create")).toContain('value="claude-free"');
    });
  });
});
