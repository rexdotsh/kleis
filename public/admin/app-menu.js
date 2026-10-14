import { menuHtml } from "./app-menu-render.js";
import { $ } from "./app-state.js";

let menuAnchor = null;

function closeMenu({ restoreFocus = false } = {}) {
  const menu = $("#menu");
  if (menu.hidden) return;
  menu.hidden = true;
  if (menuAnchor) {
    menuAnchor.setAttribute("aria-expanded", "false");
    menuAnchor.closest(".row")?.classList.remove("sel");
    if (restoreFocus && menuAnchor.isConnected) menuAnchor.focus();
  }
  menuAnchor = null;
}

function openMenu(anchor) {
  if (menuAnchor === anchor) {
    closeMenu({ restoreFocus: true });
    return;
  }
  closeMenu();
  const kind = anchor.dataset.menu;
  const id =
    kind === "account" ? anchor.dataset.accountId : anchor.dataset.keyId;
  const menu = $("#menu");
  menu.innerHTML = menuHtml(kind, id);
  if (!menu.innerHTML) return;
  menu.dataset.kind = kind;
  menu.dataset.title =
    anchor.closest(".row")?.querySelector(".name")?.textContent.trim() ?? "";
  menu.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)
  );
  const below = rect.bottom + 4;
  const top =
    below + menu.offsetHeight > innerHeight - 8
      ? Math.max(8, rect.top - menu.offsetHeight - 4)
      : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  anchor.closest(".row")?.classList.add("sel");
  menu.querySelector(".menu-item:not(:disabled)")?.focus();
}

export { menuAnchor, closeMenu, openMenu };
