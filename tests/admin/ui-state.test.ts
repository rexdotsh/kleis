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
  cacheReadRate,
  cancelOAuthFlow,
  escapeHtml,
  loadAccounts,
  loadAccountUsage,
  requestUsageDetail,
  logout,
  normalizeUsage,
  startEditKey,
  saveKeyEdits,
  startOAuth,
  state,
} = await import("../../public/admin/app-data.js");
const { renderAccounts, renderDashboard, renderUsageSlot } = await import(
  "../../public/admin/app-render.js"
);

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

  test("usage loading, ready and empty states keep both account table shells", () => {
    const id = "stable-account";
    state.accountUsageWindowMs = 86_400_000;
    state.usageDetails = new Map();
    const slot = element(`[data-usage-for="account:${id}"]`);
    renderUsageSlot("account", id);
    expect(slot.innerHTML).toContain("By key");
    expect(slot.innerHTML).toContain("By model");
    expect(slot.innerHTML.match(/class="usage-panel"/g)).toHaveLength(2);
    expect(slot.innerHTML).toContain('class="row skeleton"');

    state.usageDetails.set(`account:${id}:86400000`, {
      status: "ready",
      data: { totals: { requestCount: 0 } },
    });
    renderUsageSlot("account", id);
    expect(slot.innerHTML.match(/class="usage-panel"/g)).toHaveLength(2);
    expect(slot.innerHTML).toContain("No usage in this window.");
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
    await requestUsageDetail("account", "cached");
    expect(calls).toBe(1);
    release?.(Response.json({ totals: { requestCount: 1 }, models: [] }));
    await loading;
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

  test("quota arrival does not insert or reorder account fact slots", () => {
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
    const before = element("#accounts-list").innerHTML.match(
      /class="fact-label">[^<]+/g
    );
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
    expect(
      element("#accounts-list").innerHTML.match(/class="fact-label">[^<]+/g)
    ).toEqual(before);
    state.expandedAccountId = null;
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
