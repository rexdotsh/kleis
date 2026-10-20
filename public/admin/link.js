const $ = (selector) => document.querySelector(selector);
const token = location.pathname.split("/").pop();
const SIGN_IN = {
  claude: ["Sign in to Claude", "the code it shows"],
  codex: [
    "Sign in to ChatGPT",
    "the address of the page it ends on (it won't load)",
  ],
};
let flow = null;

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Something went wrong");
  return data;
}

function run(button, action) {
  $("#link-error").textContent = "";
  button.disabled = true;
  action()
    .finally(() => {
      button.disabled = false;
    })
    .catch((error) => {
      $("#link-error").textContent = error.message;
    });
}

$("#link-continue").addEventListener("click", (event) => {
  run(event.currentTarget, async () => {
    flow = await post(`/link/${encodeURIComponent(token)}/start`);
    const [signIn, paste] = SIGN_IN[flow.provider];
    const link = $("#link-sign-in");
    link.href = flow.authorizationUrl;
    link.textContent = signIn;
    $("#link-paste").textContent = paste;
    $("#link-consent").hidden = true;
    $("#link-form").hidden = false;
    $("#link-code").focus();
  });
});

$("#link-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    await post("/link/complete", {
      provider: flow.provider,
      state: flow.state,
      code: $("#link-code").value.trim(),
    });
    $("#link-form").hidden = true;
    $("#link-done").hidden = false;
  });
});
