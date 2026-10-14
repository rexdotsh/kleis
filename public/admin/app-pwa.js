import {
  $,
  loadAccounts,
  loadDashboard,
  loadKeys,
  resolveConfirm,
  state,
  toast,
} from "./app-data.js";

const root = document.documentElement;
const standalone = root.classList.contains("standalone");
const sheetLayout = matchMedia("(max-width: 640px) and (pointer: coarse)");
const RESUME_REFRESH_MS = 60_000;
const UPDATE_CHECK_MS = 5 * 60_000;
const PULL_THRESHOLD = 72;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTyping = (element) =>
  element instanceof HTMLElement &&
  (element.isContentEditable ||
    element.matches(
      "textarea, select, input:not([type=checkbox], [type=radio], [type=button], [type=submit])"
    ));

// Nothing would be lost by reloading or refreshing right now.
const isIdle = () =>
  !(
    state.creatingKey ||
    state.editingKeyId ||
    state.editingAccountId ||
    state.activeOAuth ||
    $("#login-token").value
  ) &&
  $("#menu").hidden &&
  $("#confirm").hidden &&
  !isTyping(document.activeElement);

function refreshAll() {
  if (!state.sessionActive) return;
  loadDashboard();
  loadAccounts();
  loadKeys();
}

/* Service worker and updates */

let registration = null;
let updateReady = false;
let lastUpdateCheck = 0;

function checkForUpdate() {
  if (!registration || Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return;
  lastUpdateCheck = Date.now();
  registration.update().catch(() => undefined);
}

// A new worker takes over as soon as it has cached the new shell. The open
// page keeps running the code it loaded, so it reloads when that is free (on
// return to the app) or when the user taps Reload.
const showUpdateToast = () =>
  toast("Kleis was updated", "success", {
    label: "Reload",
    run: () => location.reload(),
  });

function offerUpdate() {
  updateReady = true;
  if (document.visibilityState === "visible") showUpdateToast();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (controlled) offerUpdate();
    controlled = true;
  });
  navigator.serviceWorker
    .register("/admin/sw.js", { scope: "/admin/", updateViaCache: "none" })
    .then((result) => {
      registration = result;
      lastUpdateCheck = Date.now();
    })
    .catch(() => undefined);
}

/* Resume, connectivity and storage */

let hiddenAt = 0;

function watchLifecycle() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (updateReady) {
      if (isIdle()) {
        location.reload();
        return;
      }
      showUpdateToast();
    }
    checkForUpdate();
    if (away >= RESUME_REFRESH_MS && navigator.onLine && isIdle()) {
      refreshAll();
    }
  });

  const syncOnline = () => {
    $("#offline").hidden = navigator.onLine;
  };
  window.addEventListener("offline", syncOnline);
  window.addEventListener("online", () => {
    syncOnline();
    refreshAll();
  });
  syncOnline();

  // Home Screen apps keep their own storage; asking for persistence keeps
  // the saved admin token from being evicted under storage pressure.
  if (standalone) navigator.storage?.persist?.().catch(() => undefined);
}

/* Bottom sheets on phones */

// The menu and confirm sheets hide at once (the rest of the app relies on
// that), so a copy plays the slide-down instead.
function playSheetExit(sheet) {
  const ghost = sheet.cloneNode(true);
  ghost.removeAttribute("id");
  for (const node of ghost.querySelectorAll("[id]")) node.removeAttribute("id");
  ghost.hidden = false;
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.add("sheet-leaving");
  document.body.append(ghost);
  const remove = () => ghost.remove();
  ghost.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, 400);
}

function trackSheets() {
  const sheets = [$("#menu"), $("#confirm")];
  const scrim = $("#scrim");
  let leavingTimer = 0;
  const observer = new MutationObserver((records) => {
    for (const { target, oldValue } of records) {
      const wasOpen = oldValue === null;
      if (wasOpen && target.hidden && sheetLayout.matches) {
        playSheetExit(target);
      }
      target.style.transform = "";
      target.style.transition = "";
    }
    const open = sheets.some((sheet) => !sheet.hidden);
    // While it fades out the scrim still takes taps, so the tap that closed a
    // sheet does not also land on the row underneath.
    if (scrim.classList.contains("on") && !open) {
      scrim.classList.add("leaving");
      clearTimeout(leavingTimer);
      leavingTimer = setTimeout(() => scrim.classList.remove("leaving"), 300);
    }
    scrim.classList.toggle("on", open);
  });
  for (const sheet of sheets) {
    observer.observe(sheet, {
      attributes: true,
      attributeFilter: ["hidden"],
      attributeOldValue: true,
    });
  }
  scrim.addEventListener("touchmove", (event) => event.preventDefault(), {
    passive: false,
  });
}

function dragToDismiss(sheet, dismiss) {
  let drag = null;
  let suppressClickUntil = 0;

  sheet.addEventListener(
    "touchstart",
    (event) => {
      drag = null;
      if (!sheetLayout.matches || event.touches.length !== 1) return;
      if (sheet.scrollTop > 0) return;
      const { clientY } = event.touches[0];
      drag = { startY: clientY, lastY: clientY, lastTime: event.timeStamp };
      drag.velocity = 0;
      drag.active = false;
    },
    { passive: true }
  );

  sheet.addEventListener(
    "touchmove",
    (event) => {
      if (!drag) return;
      const { clientY } = event.touches[0];
      const offset = clientY - drag.startY;
      if (!drag.active) {
        if (offset < -4) {
          drag = null;
          return;
        }
        if (offset < 6) return;
        drag.active = true;
        sheet.style.transition = "none";
      }
      event.preventDefault();
      const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
      drag.velocity = (clientY - drag.lastY) / elapsed;
      drag.lastY = clientY;
      drag.lastTime = event.timeStamp;
      sheet.style.transform = `translateY(${Math.max(0, offset)}px)`;
    },
    { passive: false }
  );

  sheet.addEventListener("touchend", () => {
    if (!drag?.active) {
      drag = null;
      return;
    }
    const offset = Math.max(0, drag.lastY - drag.startY);
    const fling = drag.velocity > 0.5;
    drag = null;
    suppressClickUntil = Date.now() + 400;
    if (fling || offset > Math.min(120, sheet.offsetHeight * 0.35)) {
      dismiss();
      return;
    }
    sheet.style.transition = "transform 320ms var(--ease-pop)";
    sheet.style.transform = "";
  });

  sheet.addEventListener("touchcancel", () => {
    drag = null;
    sheet.style.transition = "";
    sheet.style.transform = "";
  });

  sheet.addEventListener(
    "click",
    (event) => {
      if (Date.now() < suppressClickUntil) {
        event.stopPropagation();
        event.preventDefault();
      }
    },
    true
  );
}

/* Pull to refresh (standalone apps have no browser one) */

function pullToRefresh(refresh) {
  const indicator = $("#ptr");
  let pull = null;
  let busy = false;

  // iOS rubber-bands the page (scrollY goes negative), so the indicator
  // centres in the gap that opens above it; elsewhere it slides over the page.
  const show = (distance) => {
    const progress = Math.min(1, distance / PULL_THRESHOLD);
    const gap = Math.max(0, -window.scrollY);
    const offset = gap ? gap / 2 - 26 : Math.min(distance, 120) / 2 - 10;
    indicator.style.setProperty("--pull", String(progress));
    indicator.style.setProperty("--pull-y", `${offset}px`);
    indicator.classList.toggle("armed", progress >= 1);
  };

  const reset = () => {
    root.classList.remove("ptr-hold");
    indicator.classList.remove("pulling", "armed", "refreshing");
    indicator.style.removeProperty("--pull");
    indicator.style.removeProperty("--pull-y");
  };

  window.addEventListener(
    "touchstart",
    (event) => {
      pull = null;
      if (busy || event.touches.length !== 1 || window.scrollY > 0) return;
      if (
        !(state.sessionActive && $("#menu").hidden && $("#confirm").hidden) ||
        $(".tab.active")?.dataset.tab === "oauth"
      ) {
        return;
      }
      if (event.target.closest("input, textarea, select, .tabs, .plot")) return;
      const { clientX, clientY } = event.touches[0];
      pull = { x: clientX, y: clientY, distance: 0, armed: false };
    },
    { passive: true }
  );

  window.addEventListener(
    "touchmove",
    (event) => {
      if (!pull) return;
      const { clientX, clientY } = event.touches[0];
      const dy = clientY - pull.y;
      if (!pull.distance && Math.abs(clientX - pull.x) > Math.abs(dy)) {
        pull = null;
        return;
      }
      if (dy <= 0 || window.scrollY > 0) {
        pull.distance = 0;
        reset();
        return;
      }
      pull.distance = dy;
      indicator.classList.add("pulling");
      show(dy);
      if (dy >= PULL_THRESHOLD && !pull.armed) {
        pull.armed = true;
        navigator.vibrate?.(8);
      } else if (dy < PULL_THRESHOLD) {
        pull.armed = false;
      }
    },
    { passive: true }
  );

  const finish = async () => {
    if (!pull) return;
    const { armed } = pull;
    pull = null;
    if (!armed) {
      reset();
      return;
    }
    busy = true;
    indicator.classList.remove("pulling", "armed");
    indicator.classList.add("refreshing");
    root.classList.add("ptr-hold");
    try {
      await Promise.all([refresh(), sleep(500)]);
    } finally {
      busy = false;
      reset();
    }
  };
  window.addEventListener("touchend", finish);
  window.addEventListener("touchcancel", () => {
    pull = null;
    reset();
  });
}

/* Tab bar */

// Like a native tab bar: each tab keeps its scroll position, and tapping the
// current tab again scrolls it back to the top.
function rememberTabScroll() {
  const tabs = $(".tabs");
  const positions = new Map();
  let target = null;
  tabs.addEventListener(
    "click",
    (event) => {
      const tab = event.target.closest(".tab");
      const current = $(".tab.active")?.dataset.tab;
      target = null;
      if (!tab) return;
      if (tab.dataset.tab === current) {
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduced ? "instant" : "smooth" });
        return;
      }
      positions.set(current, window.scrollY);
      target = tab.dataset.tab;
    },
    true
  );
  tabs.addEventListener("click", () => {
    if (target) window.scrollTo(0, positions.get(target) ?? 0);
    target = null;
  });
}

/* Keyboard */

// The bottom tab bar would ride up on top of the on-screen keyboard.
function trackKeyboard() {
  document.addEventListener("focusin", (event) => {
    root.classList.toggle("typing", isTyping(event.target));
  });
  document.addEventListener("focusout", () => {
    root.classList.remove("typing");
  });
}

export function initPwa({ closeMenu, refresh }) {
  // iOS only shows :active states on pages that listen for touches.
  document.addEventListener("touchstart", () => undefined, { passive: true });
  registerServiceWorker();
  watchLifecycle();
  trackSheets();
  dragToDismiss($("#menu"), closeMenu);
  dragToDismiss($("#confirm"), () => resolveConfirm(false));
  if (standalone) {
    pullToRefresh(async () => {
      if (!navigator.onLine) return;
      await refresh();
    });
    trackKeyboard();
    rememberTabScroll();
  }
}
