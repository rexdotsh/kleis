import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type FakeElement = {
  value: string;
  disabled: boolean;
  innerHTML: string;
  textContent: string;
  style: { display: string };
  classes: Set<string>;
  classList: {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
    toggle: (name: string, force?: boolean) => void;
  };
  querySelector: () => null;
};

const elements = new Map<string, FakeElement>();
const element = (selector: string) => {
  let current = elements.get(selector);
  if (!current) {
    const classes = new Set<string>();
    current = {
      value: "",
      disabled: false,
      innerHTML: "",
      textContent: "",
      style: { display: "none" },
      classes,
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => {
          classes.add(name);
        },
        remove: (name) => {
          classes.delete(name);
        },
        toggle: (name, force) => {
          if (force ?? !classes.has(name)) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
      },
      querySelector: () => null,
    };
    elements.set(selector, current);
  }
  return current;
};

const globals = globalThis as Record<string, unknown>;
const originalGlobals = {
  document: globals.document,
  window: globals.window,
  localStorage: globals.localStorage,
  location: globals.location,
  history: globals.history,
  fetch: globals.fetch,
};

let removedTokens = 0;
const installGlobals = () => {
  globals.document = { querySelector: element, querySelectorAll: () => [] };
  globals.window = { location: { origin: "http://localhost" } };
  globals.location = { hash: "" };
  globals.history = { replaceState: () => undefined };
  globals.localStorage = {
    getItem: () => "saved-admin-token",
    setItem: () => undefined,
    removeItem: () => {
      removedTokens++;
    },
  };
};

installGlobals();
const { restoreSession } = await import("../../public/admin/app-data.js");

const respondToVerification = (status: number): string[] => {
  const requested: string[] = [];
  globals.fetch = (url: RequestInfo | URL) => {
    const path = String(url);
    requested.push(path);
    if (path === "/admin/accounts/providers") {
      return Promise.resolve(Response.json({ message: "nope" }, { status }));
    }
    // Leave dashboard data requests pending; only session handling is tested.
    return new Promise<Response>(() => undefined);
  };
  return requested;
};

describe("admin session restore", () => {
  beforeEach(() => {
    elements.clear();
    removedTokens = 0;
    installGlobals();
  });

  afterEach(() => {
    Object.assign(globals, originalGlobals);
  });

  test("keeps the saved token when verification fails for a non-auth reason", async () => {
    const requested = respondToVerification(503);

    await restoreSession();

    expect(requested[0]).toBe("/admin/accounts/providers");
    expect(removedTokens).toBe(0);
    expect(element("#login-gate").classes.has("hidden")).toBe(true);
    expect(element("#app").classes.has("visible")).toBe(true);
  });

  test("clears the saved token only when the server rejects it", async () => {
    respondToVerification(401);

    await restoreSession();

    expect(removedTokens).toBe(1);
    expect(element("#login-gate").classes.has("hidden")).toBe(false);
    expect(element("#app").classes.has("visible")).toBe(false);
  });
});
