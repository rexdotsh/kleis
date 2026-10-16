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

const { loadAccounts, loadAccountUsage } =
  await import("../../public/admin/app-accounts.js");
const { renderAccounts } =
  await import("../../public/admin/app-accounts-render.js");
const { cancelOAuthFlow, escapeHtml, logout, state } =
  await import("../../public/admin/app-core.js");
const { cacheReadRate, normalizeUsage } =
  await import("../../public/admin/app-render-shared.js");
const { startEditKey, saveKeyEdits } =
  await import("../../public/admin/app-keys.js");
const { startOAuth } = await import("../../public/admin/app-oauth.js");
const {
  loadDashboard,
  requestUsageDetail,
  scheduleUsagePrefetch,
  waitForUsageDetail,
} = await import("../../public/admin/app-usage.js");
const { renderDashboard, renderUsageSlot, renderAttention } =
  await import("../../public/admin/app-usage-render.js");

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
    state.accountsLoaded = true;
    state.overviewReady = false;
    state.dashboardData = null;
    state.dashboardError = null;
    state.dashboardLoading = false;
    state.accounts = [];
    state.accountsById = new Map();
    state.accountUsageById = new Map();
    state.keyUsageById = new Map();
    state.visibleUsageDetails = new Map();
    state.usageDetails = new Map();
    state.expandedAccountId = null;
    state.expandedKeyId = null;
    state.keysLoaded = false;
    state.accountFilter = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalLocalStorage;
  });

  test("escapes quotes and HTML syntax inside both text and attributes", () => {
    expect(escapeHtml(`A&B <tag> "quoted" 'single'`)).toBe(
      "A&amp;B &lt;tag&gt; &quot;quoted&quot; &#39;single&#39;"
    );
    expect(escapeHtml('" onmouseover="alert(1)')).toBe(
      "&quot; onmouseover=&quot;alert(1)"
    );
    expect(escapeHtml("&quot;")).toBe("&amp;quot;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  test("renders a known Claude plan in place of the sign-in fact", () => {
    const account = {
      id: "claude-plan-preview",
      provider: "claude",
      label: "alex@northwind.dev",
      metadata: { oauthMode: "max" },
      quota: {
        data: {
          provider: "claude",
          plan: { type: "max_20x", label: "Max 20x" },
          subscription: { extraUsage: { isEnabled: true, utilization: 12 } },
        },
      },
    };
    state.accounts = [account];
    state.accountsById = new Map([[account.id, account]]);
    state.expandedAccountId = account.id;
    renderAccounts();
    const html = element("#accounts-list").innerHTML;
    expect(html).toContain('Plan</div><div class="fact-value">Max 20x</div>');
    expect(html).toContain("claude.ai");
    expect(html).toContain("extra usage on");
  });

  test.each(["max", "console"])(
    "keeps the %s sign-in fact when the Claude plan is unknown",
    (mode) => {
      const account = {
        id: "claude-unknown-plan",
        provider: "claude",
        label: "sam@northwind.dev",
        metadata: { oauthMode: mode },
        quota: { data: { provider: "claude", plan: null } },
      };
      state.accounts = [account];
      state.accountsById = new Map([[account.id, account]]);
      state.expandedAccountId = account.id;
      renderAccounts();
      const html = element("#accounts-list").innerHTML;
      expect(html).toContain(
        `Sign-in</div><div class="fact-value">${mode === "console" ? "Console" : "claude.ai"}</div>`
      );
      expect(html).not.toContain('fact-label">Plan</div>');
    }
  );

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
        append: () => undefined,
        remove: () => undefined,
      }),
    } as unknown as Document;

    startEditKey(keyId);
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

  test("counts cache writes in the cached input denominator", () => {
    const metrics = normalizeUsage({
      inputTokens: 20,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
    });
    expect(metrics.inputTotalTokens).toBe(100);
    expect(
      cacheReadRate(metrics.inputTotalTokens, metrics.cacheReadTokens)
    ).toBe(70);
    expect(cacheReadRate(0, 0)).toBeNull();
  });

  test("renders cached input as a token share, not a request hit rate", () => {
    const metrics = {
      requestCount: 1,
      inputTokens: 20,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
    };
    renderDashboard({
      totals: metrics,
      byProvider: [{ ...metrics, provider: "claude" }],
    });
    const html = element("#dash-content").innerHTML;
    expect(html).toContain('Cached input</div><div class="val">70%');
    expect(html).toContain('<span class="num muted d">70%</span>');
    expect(html).not.toContain("cache hit");
  });

  test("renders no cached input rate when no usage was captured", () => {
    renderDashboard({ totals: { requestCount: 1 } });
    expect(element("#dash-content").innerHTML).toContain(
      'Cached input</div><div class="val">\u2014'
    );
  });

  test("keeps the dashboard structure in an empty time window", () => {
    renderDashboard({ totals: { requestCount: 0 } });
    const html = element("#dash-content").innerHTML;
    expect(html).toContain('class="kpis"');
    expect(html).toContain('class="plot"');
    expect(html).toContain('class="list dashboard-table"');
    expect(html).toContain("No usage in this window.");
  });

  test("usage skeletons are short and empty details omit table sections", () => {
    const id = "stable-account";
    state.accountUsageWindowMs = 86_400_000;
    state.usageDetails = new Map();
    const slot = element(`[data-usage-for="account:${id}"]`);
    renderUsageSlot("account", id);
    expect(slot.innerHTML).toContain("<span>Key</span>");
    expect(slot.innerHTML).toContain("<span>Model</span>");
    expect(slot.innerHTML).not.toContain("By key");
    expect(slot.innerHTML.match(/class="usage-panel"/g)).toHaveLength(2);
    expect(slot.innerHTML).toContain('class="row skeleton"');
    expect(slot.innerHTML.match(/class="row skeleton"/g)).toHaveLength(6);
    expect(slot.innerHTML).not.toContain('tabindex="0"');

    state.usageDetails.set(`account:${id}:86400000`, {
      status: "ready",
      data: { totals: { requestCount: 0 } },
    });
    renderUsageSlot("account", id);
    expect(slot.innerHTML).toBe("");
    state.usageDetails.set(`account:${id}:86400000`, {
      status: "error",
      error: "Unavailable",
    });
    renderUsageSlot("account", id);
    expect(slot.innerHTML.match(/class="usage-panel"/g)).toHaveLength(2);
    expect(slot.innerHTML).toContain("Unavailable");
  });

  test("deduplicates usage detail requests and caches each time window", async () => {
    state.token = "mock";
    state.usageDetails = new Map();
    state.accountUsageWindowMs = 86_400_000;
    let release: ((response: Response) => void) | undefined;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch;
    const loading = requestUsageDetail("account", "cached");
    const duplicate = requestUsageDetail("account", "cached");
    expect(duplicate).toBe(loading);
    expect(calls).toBe(1);
    release?.(Response.json({ totals: { requestCount: 1 }, models: [] }));
    await loading;
    await duplicate;
    await requestUsageDetail("account", "cached");
    expect(calls).toBe(1);

    state.accountUsageWindowMs = 3_600_000;
    const otherWindow = requestUsageDetail("account", "cached");
    release?.(Response.json({ totals: { requestCount: 2 }, models: [] }));
    await otherWindow;
    state.accountUsageWindowMs = 86_400_000;
    await requestUsageDetail("account", "cached");
    expect(calls).toBe(2);
    expect(state.usageDetails.size).toBe(2);
  });

  test("changing usage windows does not discard detail caches", async () => {
    state.expandedAccountId = null;
    state.accountUsageWindowMs = 3_600_000;
    const entry = {
      status: "ready",
      data: { totals: { requestCount: 1 } },
      updatedAt: Date.now(),
    };
    state.usageDetails = new Map([["account:cached:86400000", entry]]);
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ usage: [], windowMs: 3_600_000 })
      )) as typeof fetch;
    await loadAccountUsage();
    expect(state.usageDetails.get("account:cached:86400000")).toBe(entry);
  });

  test("restores natural quota facts and hides unused credits, actions and tables", () => {
    const account = {
      id: "quota-account",
      provider: "codex",
      label: "Preview",
      quota: null,
      expiresAt: Date.now() + 60_000,
    };
    state.accounts = [account];
    state.accountsById = new Map([[account.id, account]]);
    state.expandedAccountId = account.id;
    state.editingAccountId = null;
    state.accountFilter = "";
    state.accountUsageById = new Map();
    state.usageDetails = new Map([
      [
        `account:${account.id}:${state.accountUsageWindowMs}`,
        {
          status: "ready",
          data: { totals: { requestCount: 0 } },
          updatedAt: Date.now(),
        },
      ],
    ]);
    renderAccounts();
    const before = element("#accounts-list").innerHTML;
    expect(before).toContain("waiting for the first sync");
    expect(before).not.toContain("Reset credits");
    expect(before).not.toContain("hidden-action");
    expect(before).not.toContain("By key");
    expect(before).not.toContain("By model");
    state.accounts = [
      {
        ...account,
        quota: {
          data: {
            provider: "codex",
            status: {
              primaryWindow: { usedPercent: 20 },
              secondaryWindow: { usedPercent: 40 },
            },
          },
        },
      },
    ];
    renderAccounts();
    const after = element("#accounts-list").innerHTML;
    expect(after).toContain("20%");
    expect(after).toContain("40%");
    expect(after.match(/<span class="bar/g)).toHaveLength(2);
    expect(after).not.toContain("limit-windows");
    expect(after).not.toContain("Reset credits");
    expect(after).not.toContain('class="fact-sub">&nbsp;');
    state.accounts[0].expiresAt = Date.now() - 60_000;
    renderAccounts();
    const actions =
      element("#accounts-list").innerHTML.split('class="actions"')[1];
    expect(actions).toMatch(
      /^>\s*<button class="btn btn-primary btn-sm" data-action="reauthorize-account"/
    );
    state.expandedAccountId = null;
  });

  test("expanded Claude accounts chart daily tokens via Kleis; Codex accounts do not", async () => {
    const claude = { id: "claude-daily", provider: "claude", label: "Preview" };
    const codex = { id: "codex-daily", provider: "codex", label: "Preview" };
    state.token = "mock";
    state.accounts = [claude, codex];
    state.accountsById = new Map([
      [claude.id, claude],
      [codex.id, codex],
    ]);
    const daily = Array.from({ length: 30 }, (_, index) => ({
      date: `day-${index}`,
      dayStart: Date.UTC(2026, 8, 15) + index * 86_400_000,
      requestCount: index,
      totalTokens: index === 29 ? 2_000_000 : index * 1000,
    }));
    const calls: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      calls.push(String(url));
      return Promise.resolve(
        Response.json({ daily, totals: { totalTokens: 2_435_000 } })
      );
    }) as typeof fetch;

    state.expandedAccountId = claude.id;
    renderAccounts();
    let html = element("#accounts-list").innerHTML;
    expect(html).toContain("Daily tokens via Kleis");
    expect(html.match(/daily-bar zero/g)).toHaveLength(30);
    expect(calls).toEqual([
      `/admin/accounts/${claude.id}/daily-tokens?days=30`,
    ]);

    await state.usageDetails.get(`daily:${claude.id}`)?.promise;
    renderAccounts();
    html = element("#accounts-list").innerHTML;
    expect(html).toContain("2.4M tokens \u00b7 30 days");
    expect(html).toContain("Sep 15");
    expect(html).toContain('style="height:100%"');
    expect(html.match(/class="daily-bar/g)).toHaveLength(30);
    expect(html.match(/daily-bar zero/g)).toHaveLength(1);

    state.expandedAccountId = codex.id;
    renderAccounts();
    expect(element("#accounts-list").innerHTML).not.toContain("daily-tokens");
    expect(calls).toHaveLength(1);
  });

  test("prefetch loads daily tokens for a Claude account without recent traffic", async () => {
    const account = { id: "claude-quiet", provider: "claude" };
    state.token = "mock";
    state.accountsById = new Map([[account.id, account]]);
    const calls: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      calls.push(String(url));
      return Promise.resolve(Response.json({ daily: [] }));
    }) as typeof fetch;
    scheduleUsagePrefetch("account", account.id);
    await Bun.sleep(150);
    expect(calls).toEqual([
      `/admin/accounts/${account.id}/daily-tokens?days=30`,
    ]);
  });

  test("prefetch debounces targets, ignores no-traffic rows, and uses the cache", async () => {
    state.token = "mock";
    state.accountUsageWindowMs = 86_400_000;
    state.accountUsageById = new Map([
      ["first", { requestCount: 1 }],
      ["second", { requestCount: 1 }],
    ]);
    const calls: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      calls.push(String(url));
      return Promise.resolve(Response.json({ models: [] }));
    }) as typeof fetch;
    scheduleUsagePrefetch("account", "first");
    scheduleUsagePrefetch("account", "second");
    expect(calls).toHaveLength(0);
    await Bun.sleep(150);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/second/usage?");
    scheduleUsagePrefetch("account", "second");
    await Bun.sleep(150);
    expect(calls).toHaveLength(1);
    scheduleUsagePrefetch("account", "empty");
    await waitForUsageDetail("account", "empty");
    await Bun.sleep(150);
    expect(calls).toHaveLength(1);
  });

  test("opening waits for prefetched data but caps the wait at 300ms", async () => {
    state.token = "mock";
    state.accountUsageById = new Map([["slow", { requestCount: 1 }]]);
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as typeof fetch;
    const prefetched = requestUsageDetail("account", "slow");
    const start = Date.now();
    await waitForUsageDetail("account", "slow");
    expect(Date.now() - start).toBeGreaterThanOrEqual(290);
    expect(
      state.usageDetails.get(`account:slow:${state.accountUsageWindowMs}`)
        ?.status
    ).toBe("loading");
    release?.(Response.json({ models: [{ model: "ready", requestCount: 1 }] }));
    await prefetched;
    await waitForUsageDetail("account", "slow");
    expect(
      state.usageDetails.get(`account:slow:${state.accountUsageWindowMs}`)
        ?.status
    ).toBe("ready");
  });

  test("window changes retain visible details until fresh data arrives", async () => {
    state.token = "mock";
    state.accountUsageWindowMs = 3_600_000;
    state.expandedAccountId = "window-account";
    state.accountUsageById = new Map([["window-account", { requestCount: 1 }]]);
    state.visibleUsageDetails.set("account:window-account", {
      models: [{ model: "previous-model", requestCount: 1 }],
    });
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = ((url: RequestInfo | URL) =>
      String(url).includes("/window-account/usage?")
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(
            Response.json({
              windowMs: 3_600_000,
              usage: [{ providerAccountId: "window-account", requestCount: 2 }],
            })
          )) as typeof fetch;
    const loading = loadAccountUsage();
    await Bun.sleep(0);
    renderUsageSlot("account", "window-account");
    expect(
      element('[data-usage-for="account:window-account"]').innerHTML
    ).toContain("previous-model");
    expect(state.accountUsageById.get("window-account").requestCount).toBe(1);
    release?.(
      Response.json({ models: [{ model: "new-model", requestCount: 2 }] })
    );
    await loading;
    renderUsageSlot("account", "window-account");
    expect(
      element('[data-usage-for="account:window-account"]').innerHTML
    ).toContain("new-model");
    expect(state.accountUsageById.get("window-account").requestCount).toBe(2);
  });

  test("Overview waits for accounts and dashboard before painting attention and KPIs", async () => {
    state.accountsLoaded = false;
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ totals: { requestCount: 1 } })
      )) as typeof fetch;
    await loadDashboard();
    expect(element("#overview-loading").innerHTML).toContain('class="kpis"');
    expect(element("#dash-content").innerHTML).toBe("");
    state.accountsLoaded = true;
    renderDashboard(state.dashboardData);
    expect(element("#dash-content").innerHTML).toContain('class="kpis"');
    expect(element("#attention").innerHTML).toBe("");
    state.accounts = [
      {
        id: "needs-login",
        provider: "codex",
        label: "Preview",
        expiresAt: Date.now() - 60_000,
      },
    ];
    renderAttention();
    expect(element("#attention").innerHTML).toContain("Needs attention");
    state.accounts = [];
    renderAttention();
    expect(element("#attention").innerHTML).toBe("");
  });

  test("cold quotas finish before the first Overview paint", async () => {
    state.accountsLoaded = false;
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = ((url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/admin/accounts/failover")
        return Promise.resolve(Response.json({ enabled: false }));
      if (path === "/admin/accounts")
        return Promise.resolve(
          Response.json({
            accounts: [
              { id: "cold", provider: "codex", expiresAt: Date.now() + 60_000 },
            ],
          })
        );
      if (path === "/admin/accounts/quotas")
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Promise.resolve(
        Response.json({ usage: [], totals: { requestCount: 1 } })
      );
    }) as typeof fetch;
    await loadDashboard();
    await loadAccounts();
    expect(state.accountsLoaded).toBe(false);
    expect(state.overviewReady).toBe(false);
    expect(element("#dash-content").innerHTML).toBe("");
    release?.(
      Response.json({
        quotas: { cold: { error: "Sync failed", errorStatus: 401 } },
      })
    );
    await Bun.sleep(0);
    expect(state.overviewReady).toBe(true);
    expect(element("#attention").innerHTML).toContain("Needs attention");
    expect(element("#dash-content").innerHTML).toContain('class="kpis"');
  });

  test("refresh keeps cached quotas and usage visible while detail revalidates", async () => {
    const quota = {
      fetchedAt: Date.now(),
      data: { provider: "codex", status: {} },
    };
    const account = {
      id: "refresh-account",
      provider: "codex",
      label: "Preview",
      quota,
    };
    state.token = "mock";
    state.accounts = [account];
    state.accountsById = new Map([[account.id, account]]);
    state.expandedAccountId = null;
    state.keysLoaded = false;
    state.accountUsageWindowMs = 86_400_000;
    const cacheKey = `account:${account.id}:86400000`;
    state.usageDetails = new Map([
      [
        cacheKey,
        {
          status: "ready",
          updatedAt: Date.now(),
          data: {
            totals: { requestCount: 1 },
            models: [{ model: "cached-model", requestCount: 1 }],
          },
        },
      ],
    ]);
    let release: ((response: Response) => void) | undefined;
    let releaseQuotas: ((response: Response) => void) | undefined;
    globalThis.fetch = ((url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/admin/accounts/failover")
        return Promise.resolve(Response.json({ enabled: false }));
      if (path === "/admin/accounts/quotas")
        return new Promise<Response>((resolve) => {
          releaseQuotas = resolve;
        });
      if (path === "/admin/accounts")
        return Promise.resolve(
          Response.json({ accounts: [{ ...account, quota: null }] })
        );
      if (path.startsWith("/admin/accounts/usage?"))
        return Promise.resolve(Response.json({ usage: [] }));
      if (path.startsWith(`/admin/accounts/${account.id}/usage?`))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }) as typeof fetch;
    await loadAccounts();
    expect(state.accounts[0].quota).toBe(quota);
    expect(releaseQuotas).toBeDefined();
    expect(state.usageDetails.get(cacheKey)?.updatedAt).toBe(0);
    const refreshing = requestUsageDetail("account", account.id);
    renderUsageSlot("account", account.id);
    expect(
      element(`[data-usage-for="account:${account.id}"]`).innerHTML
    ).toContain("cached-model");
    release?.(
      Response.json({
        totals: { requestCount: 2 },
        models: [{ model: "fresh-model", requestCount: 2 }],
      })
    );
    await refreshing;
    expect(
      element(`[data-usage-for="account:${account.id}"]`).innerHTML
    ).toContain("fresh-model");
    releaseQuotas?.(
      Response.json({
        quotas: { [account.id]: { ...quota, fetchedAt: quota.fetchedAt + 1 } },
      })
    );
    await Bun.sleep(0);
    expect(state.accounts[0].quota.fetchedAt).toBe(quota.fetchedAt + 1);
  });

  test("ignores an older account response after a newer reload", async () => {
    let releaseOld: ((response: Response) => void) | undefined;
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOld = resolve;
    });
    let accountCalls = 0;
    globalThis.fetch = ((url: RequestInfo | URL) => {
      if (String(url) === "/admin/accounts/failover")
        return Promise.resolve(Response.json({ enabled: false }));
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
      String(url) === "/admin/accounts/failover"
        ? Promise.resolve(Response.json({ enabled: false }))
        : String(url).startsWith("/admin/accounts/usage?")
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
