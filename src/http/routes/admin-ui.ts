import { Hono } from "hono";

import type { AppEnv } from "../app-env";

const pageHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Kleis Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7f9;
        --panel: #ffffff;
        --text: #1a2330;
        --muted: #5a6778;
        --line: #d4dde6;
        --accent: #0e7490;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: radial-gradient(circle at top right, #dff2f6 0, var(--bg) 46%);
        color: var(--text);
      }
      main {
        max-width: 920px;
        margin: 24px auto;
        padding: 16px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 1.7rem;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 14px;
      }
      label {
        font-size: 0.9rem;
        color: var(--muted);
        display: block;
        margin-bottom: 6px;
      }
      input,
      button,
      select {
        font: inherit;
      }
      input,
      select {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 10px;
      }
      button {
        border: 0;
        border-radius: 8px;
        padding: 10px 12px;
        color: white;
        background: linear-gradient(120deg, #0e7490, #2563eb);
        cursor: pointer;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #0f172a;
        color: #dbeafe;
        border-radius: 8px;
        padding: 10px;
        min-height: 120px;
        font-size: 0.82rem;
      }
      .grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .help {
        margin-top: 0;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Kleis Admin</h1>
      <p class="help">Set your admin token once, then manage accounts and API keys.</p>
      <section class="panel">
        <label for="token">Admin token</label>
        <input id="token" type="password" autocomplete="off" />
      </section>
      <section class="grid">
        <div class="panel">
          <h2>Accounts</h2>
          <button id="load-accounts" type="button">Load accounts</button>
          <pre id="accounts-output"></pre>
        </div>
        <div class="panel">
          <h2>API keys</h2>
          <button id="load-keys" type="button">Load keys</button>
          <pre id="keys-output"></pre>
        </div>
      </section>
      <section class="panel">
        <h2>Create API key</h2>
        <label for="key-label">Label</label>
        <input id="key-label" type="text" maxlength="120" placeholder="team-laptop" />
        <button id="create-key" type="button">Create key</button>
        <pre id="create-key-output"></pre>
      </section>
    </main>
    <script>
      const tokenInput = document.getElementById("token");

      const authedFetch = async (url, init = {}) => {
        const token = tokenInput.value.trim();
        const headers = new Headers(init.headers || {});
        headers.set("content-type", "application/json");
        if (token) {
          headers.set("authorization", "Bearer " + token);
        }

        const response = await fetch(url, { ...init, headers });
        const text = await response.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }

        return {
          ok: response.ok,
          status: response.status,
          body: parsed,
        };
      };

      const write = (id, value) => {
        const element = document.getElementById(id);
        element.textContent = JSON.stringify(value, null, 2);
      };

      document.getElementById("load-accounts").addEventListener("click", async () => {
        write("accounts-output", await authedFetch("/admin/accounts"));
      });

      document.getElementById("load-keys").addEventListener("click", async () => {
        write("keys-output", await authedFetch("/admin/keys"));
      });

      document.getElementById("create-key").addEventListener("click", async () => {
        const label = document.getElementById("key-label").value.trim();
        write(
          "create-key-output",
          await authedFetch("/admin/keys", {
            method: "POST",
            body: JSON.stringify({ label: label || undefined }),
          }),
        );
      });
    </script>
  </body>
</html>`;

export const adminUiRoutes = new Hono<AppEnv>().get("/", (context) =>
  context.html(pageHtml)
);
