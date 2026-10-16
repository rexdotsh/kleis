import {
  $,
  api,
  mutation,
  mutationAttributes,
  state,
  syncMutationControls,
  toast,
} from "./app-core.js";

let enabled = false;
let sequence = 0;

function renderFailover() {
  const container = $("#failover-settings");
  if (!container) return;
  container.hidden = false;
  container.innerHTML = `<div><span>Rate-limit failover</span><p class="muted small">Try another account when subscription limits reject a request. Pinned keys stay within their pins for that provider.</p></div><button class="switch" type="button" role="switch" aria-label="Rate-limit failover" aria-checked="${enabled}" data-action="toggle-failover" ${mutationAttributes("toggle-failover", null)}></button>`;
  syncMutationControls();
}

export async function loadFailover() {
  const current = ++sequence;
  const session = state.sessionRequestSeq;
  try {
    const result = await api("/admin/accounts/failover");
    if (current !== sequence || session !== state.sessionRequestSeq) return;
    enabled = result.enabled;
    renderFailover();
  } catch (error) {
    if (current !== sequence || session !== state.sessionRequestSeq) return;
    toast(`Failed to load failover settings: ${error.message}`, "error");
  }
}

export const toggleFailover = mutation(
  "toggle-failover",
  async (request) => {
    ++sequence;
    const result = await request("/admin/accounts/failover", {
      method: "PATCH",
      body: JSON.stringify({ enabled: !enabled }),
    });
    ++sequence;
    enabled = result.enabled;
    renderFailover();
    toast(`Rate-limit failover ${enabled ? "enabled" : "disabled"}`);
  },
  () => null
);
