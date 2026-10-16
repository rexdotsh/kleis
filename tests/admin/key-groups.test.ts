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
  "HTMLElement",
  "innerHeight",
];
const originals = new Map(names.map((name) => [name, globals[name]]));
const installGlobals = () => {
  for (const name of names)
    globals[name] = name === "window" ? window : Reflect.get(window, name);
};
installGlobals();
const { state, setShowRevokedKeys, logout } =
  await import("../../public/admin/app-core.js");
const { renderKeys, keyMenuItems } =
  await import("../../public/admin/app-keys-render.js");
const $ = (selector: string) =>
  window.document.querySelector(selector) as unknown as HTMLButtonElement;
const rows = (selector = "#keys-list .row[data-key-id]") =>
  Array.from(window.document.querySelectorAll(selector));
const ids = () => rows().map((row) => row.getAttribute("data-key-id"));
const key = (id: string, revokedAt: number | null = null) => ({
  id,
  key: `kleis_fake_preview_${id}`,
  label: id,
  revokedAt,
  createdAt: 1,
});

describe("revoked key group", () => {
  beforeEach(() => {
    installGlobals();
    for (const tab of window.document.querySelectorAll(".tab"))
      tab.classList.toggle("active", tab.getAttribute("data-tab") === "keys");
    Object.assign(state, {
      keys: [key("quiet"), key("old-laptop", 1), key("busy"), key("trial", 2)],
      keyUsageById: new Map([["busy", { requestCount: 20 }]]),
      creatingKey: false,
      expandedKeyId: null,
      editingKeyId: null,
      pendingExpandedKeyId: null,
      cursorKeyId: null,
      keyFilter: "",
      setupOpen: false,
      revealedKeyIds: new Set(),
      accounts: [],
      accountsById: new Map(),
      keysLoaded: true,
      sessionActive: true,
      usageDetails: new Map(),
    });
    state.keysById = new Map(
      state.keys.map((entry: { id: string }) => [entry.id, entry])
    );
    setShowRevokedKeys(false);
  });
  afterEach(() => {
    for (const name of names) globals[name] = originals.get(name);
  });
  afterAll(() => window.happyDOM.cancelAsync());

  test("shows only the active count, retains activity sorting, and collapses revoked keys", () => {
    renderKeys();
    expect($("#keys-count").textContent).toBe("2");
    expect($("#keys-foot")).toBeNull();
    expect(ids()).toEqual(["busy", "quiet"]);
    expect($(".revoked-heading .group-name").textContent).toBe("Revoked2");
    expect($(".revoked-heading").classList.contains("disclosure-heading")).toBe(
      true
    );
    expect($(".revoked-heading").getAttribute("aria-expanded")).toBe("false");
    expect($("#revoked-rows").hidden).toBe(true);
    expect($("#keys-list").textContent).not.toContain("most active first");
  });

  test("remembers saved visibility and renders revoked rows", () => {
    renderKeys();
    setShowRevokedKeys(true);
    renderKeys();
    expect(state.showRevokedKeys).toBe(true);
    expect(window.localStorage.getItem("kleis_show_revoked_keys")).toBe("true");
    expect(ids()).toEqual(["busy", "quiet", "old-laptop", "trial"]);
    expect(
      rows("#revoked-rows .revoked .tag").map((tag) => tag.textContent)
    ).toEqual(["Revoked", "Revoked"]);
    expect(rows("#revoked-rows .key-mask")).toHaveLength(4);
    setShowRevokedKeys(false);
    renderKeys();
    expect(window.localStorage.getItem("kleis_show_revoked_keys")).toBe(
      "false"
    );
    expect(ids()).toEqual(["busy", "quiet"]);
  });

  test("loads the remembered preference on a fresh core import and retains it on logout", async () => {
    setShowRevokedKeys(true);
    const url = new URL("../../public/admin/app-core.js", import.meta.url);
    const fresh = await import(`${url.href}?revoked-preference-test`);
    expect(fresh.state.showRevokedKeys).toBe(true);
    logout();
    expect(state.showRevokedKeys).toBe(true);
    expect(window.localStorage.getItem("kleis_show_revoked_keys")).toBe("true");
  });

  test.each(["old-laptop", "KLEIS_FAKE_PREVIEW_OLD", "legacy-model", "claude"])(
    "search %s reveals matching revoked keys inline without changing the preference",
    (filter) => {
      state.keys[1].modelScopes = ["legacy-model"];
      state.keys[1].providerScopes = ["claude"];
      state.keyFilter = ` ${filter} `;
      renderKeys();
      expect(ids()).toEqual(["old-laptop"]);
      expect($(".revoked-heading")).toBeNull();
      expect(state.showRevokedKeys).toBe(false);
      expect($("#keys-count").textContent).toBe("2");
      state.keyFilter = "";
      renderKeys();
      expect(ids()).toEqual(["busy", "quiet"]);
      expect($(".revoked-heading").getAttribute("aria-expanded")).toBe("false");
    }
  );

  test("searches both active and revoked keys in activity order and escapes no-match text", () => {
    state.keyFilter = "fake_preview";
    renderKeys();
    expect(ids()).toEqual(["busy", "quiet", "old-laptop", "trial"]);
    state.keyFilter = '<img src="x">';
    renderKeys();
    expect($("#keys-list").textContent).toContain(
      'No keys match “<img src="x">”'
    );
    expect($("#keys-list img")).toBeNull();
  });

  test("renders the group when there are only revoked keys", () => {
    state.keys = [key("old-laptop", 1)];
    renderKeys();
    expect($("#keys-count").textContent).toBe("0");
    expect($(".revoked-heading").getAttribute("aria-expanded")).toBe("false");
    setShowRevokedKeys(true);
    renderKeys();
    expect(ids()).toEqual(["old-laptop"]);
  });

  test("omits the disclosure when no keys are revoked and keeps the create action for an empty list", () => {
    state.keys = [key("active")];
    renderKeys();
    expect($(".revoked-heading")).toBeNull();
    state.keys = [];
    renderKeys();
    expect($("#keys-count").textContent).toBe("0");
    expect($("#keys-list").textContent).toContain("No API keys yet.");
    expect($('#keys-list [data-action="open-create-key"]')).not.toBeNull();
  });

  test("expired keys stay outside the revoked group but do not count as active", () => {
    state.keys.push({ ...key("expired"), expiresAt: 1 });
    renderKeys();
    expect($("#keys-count").textContent).toBe("2");
    expect(ids()).toEqual(["busy", "quiet", "expired"]);
  });

  test("keeps a just-revoked or linked key expanded without changing the saved preference", () => {
    state.expandedKeyId = "old-laptop";
    renderKeys();
    expect($(".revoked-heading").getAttribute("aria-expanded")).toBe("true");
    expect($('#revoked-rows [data-detail-for="old-laptop"]')).not.toBeNull();
    expect(state.showRevokedKeys).toBe(false);
    const actions = keyMenuItems(state.keysById.get("old-laptop"))
      .filter(Boolean)
      .map((item: { action?: string }) => item.action);
    expect(actions).toContain("edit-key");
    expect(actions).toContain("delete-key");
    expect(actions).not.toContain("copy-key");
  });

  test("clears concealed secrets when collapsed", () => {
    setShowRevokedKeys(true);
    state.revealedKeyIds.add("old-laptop");
    renderKeys();
    setShowRevokedKeys(false);
    renderKeys();
    expect(state.revealedKeyIds.has("old-laptop")).toBe(false);
  });

  test("preserves an unsaved create form when toggling the group", () => {
    state.creatingKey = true;
    renderKeys();
    $("#key-label").value = "Unsaved key";
    setShowRevokedKeys(true);
    renderKeys();
    expect($("#key-label").value).toBe("Unsaved key");
  });
});
