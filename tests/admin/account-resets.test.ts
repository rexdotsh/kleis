import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/admin/" });
const globals = globalThis as Record<string, unknown>;
const names = ["document", "window", "localStorage"];
const originals = new Map(names.map((name) => [name, globals[name]]));
const installGlobals = () => {
  globals.document = dom.document;
  globals.window = dom;
  globals.localStorage = dom.localStorage;
};
installGlobals();
const { state } = await import("../../public/admin/app-core.js");
const { renderAccounts, bindingWindow, resetCountdown } =
  await import("../../public/admin/app-accounts-render.js");
const { accountWindows, limitSeverity } =
  await import("../../public/admin/app-render-shared.js");

const NOW = Date.UTC(2026, 9, 16, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const window = (percent: number, resetsAt: number | null, label = "5h") => ({
  label,
  percent,
  resetsAt,
});
const account = () => ({
  id: "fake-codex",
  label: "juniper",
  provider: "codex",
  expiresAt: NOW + 5 * HOUR,
  lastRefreshStatus: "success",
  quota: {
    fetchedAt: NOW,
    data: {
      provider: "codex",
      status: {
        primaryWindow: { usedPercent: 40, resetAt: (NOW + HOUR) / 1000 },
        secondaryWindow: {
          usedPercent: 82,
          resetAt: (NOW + 3 * DAY + 4 * HOUR) / 1000,
        },
      },
    },
  },
});
const $ = (selector: string) => dom.document.querySelector(selector);

beforeEach(() => {
  installGlobals();
  setSystemTime(NOW);
  dom.document.body.innerHTML =
    '<span id="accounts-count"></span><div id="accounts-list"></div>';
  Object.assign(state, {
    accounts: [account()],
    expandedAccountId: null,
    editingAccountId: null,
    accountFilter: "",
    providerStatuses: [],
    accountUsageById: new Map(),
    usageDetails: new Map(),
    overviewReady: false,
    showFreeTier: false,
  });
});
afterEach(() => setSystemTime());
afterAll(async () => {
  for (const name of names) globals[name] = originals.get(name);
  await dom.happyDOM.abort();
});

describe("binding reset window", () => {
  test("chooses the fullest window with a known reset, not the soonest", () => {
    const fullest = window(82, NOW + 3 * DAY, "7d");
    expect(
      bindingWindow([window(100, null), window(40, NOW + HOUR), fullest])
    ).toBe(fullest);
  });

  test("ties choose the later reset regardless of input order", () => {
    const later = window(80, NOW + DAY, "7d");
    const earlier = window(80, NOW + HOUR);
    expect(bindingWindow([earlier, later])).toBe(later);
    expect(bindingWindow([later, earlier])).toBe(later);
  });

  test("uses unrounded utilization and accepts zero usage with a reset", () => {
    expect(
      bindingWindow([window(40.1, NOW + DAY), window(40.2, NOW + HOUR)])
        ?.percent
    ).toBe(40.2);
    expect(bindingWindow([window(0, NOW + HOUR)])?.percent).toBe(0);
  });

  test("retains past resets until the next sync", () => {
    expect(
      bindingWindow([window(100, NOW - HOUR), window(80, NOW + DAY)])?.percent
    ).toBe(100);
  });

  test("returns no window for unknown or invalid resets", () => {
    expect(bindingWindow([])).toBeNull();
    expect(
      bindingWindow([
        window(0, null),
        window(80, Number.NaN),
        window(100, Number.POSITIVE_INFINITY),
      ])
    ).toBeNull();
  });
});

describe("reset countdown", () => {
  test.each([
    [38 * MINUTE, "in 38m"],
    [2 * HOUR + 14 * MINUTE, "in 2h 14m"],
    [HOUR, "in 1h 0m"],
    [DAY - 1, "in 23h 59m"],
    [DAY, "in 1d 0h"],
    [3 * DAY + 4 * HOUR + 59 * MINUTE, "in 3d 4h"],
    [MINUTE - 1, "in <1m"],
    [0, "now"],
    [-HOUR, "now"],
  ])("formats a reset %i ms away as %s", (offset, expected) => {
    expect(resetCountdown(NOW + offset)).toBe(expected);
  });

  test.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "unknown reset %s shows a dash",
    (timestamp) => {
      expect(resetCountdown(timestamp)).toBe("\u2014");
    }
  );
});

describe("reset data normalization", () => {
  test("reads Codex epoch seconds and Claude ISO resets", () => {
    expect(accountWindows(account())[0].resetsAt).toBe(NOW + HOUR);
    const claude = {
      quota: {
        data: {
          provider: "claude",
          subscription: {
            fiveHour: {
              utilization: 40,
              resetsAt: new Date(NOW + HOUR).toISOString(),
            },
            sevenDay: {
              utilization: 82,
              resetsAt: new Date(NOW + DAY).toISOString(),
            },
          },
        },
      },
    };
    expect(accountWindows(claude).map((entry) => entry.resetsAt)).toEqual([
      NOW + HOUR,
      NOW + DAY,
    ]);
  });

  test("anchors Codex relative resets to the snapshot, preferring absolute resets", () => {
    const relative = {
      quota: {
        fetchedAt: NOW - HOUR,
        data: {
          provider: "codex",
          status: {
            primaryWindow: { usedPercent: 40, resetAfterSeconds: 7200 },
            secondaryWindow: {
              usedPercent: 82,
              resetAt: (NOW + DAY) / 1000,
              resetAfterSeconds: 60,
            },
          },
        },
      },
    };
    expect(accountWindows(relative).map((entry) => entry.resetsAt)).toEqual([
      NOW + HOUR,
      NOW + DAY,
    ]);
    setSystemTime(NOW + 2 * HOUR);
    expect(accountWindows(relative)[0].resetsAt).toBe(NOW + HOUR);
    expect(resetCountdown(accountWindows(relative)[0].resetsAt)).toBe("now");
  });

  test("does not invent a reset without a snapshot time", () => {
    expect(
      accountWindows({
        quota: {
          data: {
            provider: "codex",
            status: {
              primaryWindow: { usedPercent: 40, resetAfterSeconds: 3600 },
            },
          },
        },
      })[0].resetsAt
    ).toBeNull();
  });
});

describe("account reset rows", () => {
  test("labels the column and uses the same binding window on desktop and phone", () => {
    renderAccounts();
    expect($(".group")?.textContent).toContain("Resets");
    expect($(".group")?.textContent).not.toContain("Token expires");
    expect($(".reset")?.textContent).toBe("7d in 3d 4h");
    expect($(".reset")?.classList.contains("warn")).toBe(true);
    expect($(".l2")?.textContent).toBe("5h 40% · 7d 82% · 7d resets in 3d 4h");
    expect($(".row")?.textContent).not.toContain("expires");
  });

  test("updates countdowns on render without fetching", () => {
    renderAccounts();
    setSystemTime(NOW + HOUR);
    renderAccounts();
    expect($(".reset")?.textContent).toBe("7d in 3d 3h");
  });

  test("named windows stay in the expanded details, not the row's binding window", () => {
    const preview = account();
    const status = preview.quota.data.status;
    state.accounts = [
      {
        ...preview,
        quota: {
          ...preview.quota,
          data: {
            provider: "codex",
            status: {
              ...status,
              additionalRateLimits: [
                {
                  limitName: "Review",
                  primaryWindow: {
                    usedPercent: 100,
                    resetAt: (NOW + DAY) / 1000,
                  },
                },
              ],
            },
          },
        },
      },
    ];
    renderAccounts();
    expect($(".reset")?.textContent).toBe("7d in 3d 4h");
    expect($(".meters")?.textContent).not.toContain("Review");
  });

  test("unused windows have no reset, and expired tokens lead the phone summary", () => {
    const preview = account();
    state.accounts = [
      {
        ...preview,
        expiresAt: NOW,
        quota: {
          ...preview.quota,
          data: {
            provider: "codex",
            status: {
              primaryWindow: { usedPercent: 0 },
              secondaryWindow: { usedPercent: 0 },
            },
          },
        },
      },
    ];
    state.expandedAccountId = preview.id;
    renderAccounts();
    expect($(".reset")?.textContent).toBe("\u2014");
    expect($(".name .token-note")?.textContent).toBe("Token expired");
    expect($(".name .token-note")?.classList.contains("err")).toBe(true);
    expect($(".l2")?.textContent).toBe("Token expired · 5h 0% · 7d 0%");
    expect($(".name .dot")?.classList.contains("err")).toBe(true);
    expect($(".detail")?.textContent).toContain("expired");
    expect($('[data-action="reauthorize-account"]')).not.toBeNull();
  });

  test.each([
    [{ lastRefreshStatus: "failed" }, "Reauthorize"],
    [{ expiresAt: null, lastRefreshStatus: "failed" }, "Reauthorize"],
    [{ expiresAt: null }, undefined],
    [{}, undefined],
  ])("only expired or failing tokens get a note: %j", (overrides, note) => {
    state.accounts = [{ ...account(), ...overrides }];
    renderAccounts();
    expect($(".token-note")?.textContent).toBe(note);
  });

  test.each([401, 403])(
    "rejected tokens (%i) get an actionable note",
    (errorStatus) => {
      const preview = account();
      state.accounts = [
        { ...preview, quota: { ...preview.quota, errorStatus } },
      ];
      renderAccounts();
      expect($(".token-note")?.textContent).toBe("Reauthorize");
    }
  );

  test("active token expiry remains in expanded detail only", () => {
    state.expandedAccountId = account().id;
    renderAccounts();
    expect($(".row")?.textContent).not.toContain("expires");
    expect($(".detail")?.textContent).toContain("expires in 5h");
  });

  test.each([
    [79.9, ""],
    [80, "warn"],
    [99.9, "warn"],
    [100, "err"],
  ])("bar and reset severity at %i%% is %s", (percent, severity) => {
    expect(limitSeverity(percent)).toBe(severity);
    const preview = account();
    preview.quota.data.status.secondaryWindow.usedPercent = percent;
    state.accounts = [preview];
    renderAccounts();
    expect($(".reset")?.classList.contains(severity || "muted")).toBe(true);
    expect(
      $(".meters .meter:last-child")?.classList.contains(severity || "warn")
    ).toBe(Boolean(severity));
  });
});
