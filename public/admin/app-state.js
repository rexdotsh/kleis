const DEFAULT_KEY_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const USAGE_DETAIL_TTL_MS = 30_000;
const DAILY_TOKEN_DAYS = 30;
const ADMIN_TOKEN_STORAGE_KEY = "kleis_admin_token";
const PROVIDER_ORDER = ["codex", "claude"];

const readPersistedToken = () =>
  localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "";

function persistToken(token) {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

function clearPersistedToken() {
  localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

const state = {
  token: readPersistedToken(),
  sessionActive: false,
  sessionRequestSeq: 0,
  pendingMutations: new Map(),
  dashboardAbort: null,
  accountUsageRequestSeq: 0,
  keyUsageRequestSeq: 0,
  accounts: [],
  accountsLoaded: false,
  overviewReady: false,
  accountsById: new Map(),
  providerStatuses: [],
  accountUsageById: new Map(),
  accountUsageWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  keys: [],
  keysById: new Map(),
  keyUsageById: new Map(),
  keyUsageWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  keysLoaded: false,
  showRevokedKeys: false,
  keyFilter: "",
  accountFilter: "",
  expandedAccountId: null,
  pendingExpandedAccountId: null,
  showAllReauthorize: false,
  expandedKeyId: null,
  pendingExpandedKeyId: null,
  cursorAccountId: null,
  cursorKeyId: null,
  enteringDetail: null,
  motionAnchor: null,
  editingKeyId: null,
  editingAccountId: null,
  creatingKey: false,
  setupOpen: false,
  setupKeyId: null,
  usageDetails: new Map(),
  visibleUsageDetails: new Map(),
  activeOAuth: null,
  reauthorizeAccountId: null,
  oauthRequestSeq: 0,
  accountsRequestSeq: 0,
  keysRequestSeq: 0,
  revealedKeyIds: new Set(),
  dashboardWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  dashboardData: null,
  dashboardError: null,
  dashboardLoading: false,
  dashboardRequestSeq: 0,
  pendingResetRedemptions: new Map(),
};

const APP_ORIGIN = window.location.origin;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function syncDashboardWindowButtons() {
  for (const btn of $$("#dash-window-selector .dash-window-btn")) {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.window) === state.dashboardWindowMs
    );
  }
}

function syncAccountWindowButtons() {
  for (const btn of $$("#accounts-window-selector .dash-window-btn")) {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.window) === state.accountUsageWindowMs
    );
  }
}

function syncKeyWindowButtons() {
  for (const btn of $$("#keys-window-selector .dash-window-btn")) {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.window) === state.keyUsageWindowMs
    );
  }
}

const prefetchTimers = new Map();

export {
  DEFAULT_KEY_USAGE_WINDOW_MS,
  USAGE_DETAIL_TTL_MS,
  DAILY_TOKEN_DAYS,
  PROVIDER_ORDER,
  readPersistedToken,
  persistToken,
  clearPersistedToken,
  state,
  APP_ORIGIN,
  $,
  $$,
  syncDashboardWindowButtons,
  syncAccountWindowButtons,
  syncKeyWindowButtons,
  prefetchTimers,
};
