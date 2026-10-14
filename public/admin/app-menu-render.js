import { accountMenuItems } from "./app-accounts-render.js";
import { accountById, escapeHtml, keyById } from "./app-format.js";
import { keyMenuItems } from "./app-keys-render.js";
import { actionMutationAttributes } from "./app-render-shared.js";

function menuHtml(kind, id) {
  const subject = kind === "account" ? accountById(id) : keyById(id);
  if (!subject) return "";
  const items = (
    kind === "account" ? accountMenuItems(subject) : keyMenuItems(subject)
  ).filter(Boolean);
  return items
    .map((item) => {
      if (item === "separator") return "<hr>";
      const shortcut = item.shortcut === "Del" ? "Backspace" : item.shortcut;
      return `<button class="menu-item${item.danger ? " danger" : ""}" type="button" role="menuitem" aria-label="${escapeHtml(item.label)}" data-action="${item.action}" data-${kind}-id="${id}" ${actionMutationAttributes(item.action, id)} data-shortcut="${shortcut}"><span>${item.label}</span><span class="kbd">${item.shortcut}</span></button>`;
    })
    .join("");
}

export { menuHtml };
