import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

import { db } from "../../db";
import {
  completeReauthLink,
  describeReauthLink,
  ReauthLinkError,
  startReauthLink,
  type ReauthLinkTarget,
} from "../../domain/providers/reauth-links";

const MAX_CODE_LENGTH = 4096;

const STYLES = `
@font-face{font-family:"Geist";font-weight:400 600;font-display:optional;src:url("/admin/fonts/geist-latin.v1.woff2") format("woff2")}
@font-face{font-family:"Geist Mono";font-weight:400 500;font-display:optional;src:url("/admin/fonts/geist-mono-latin.v1.woff2") format("woff2")}
:root{color-scheme:dark;--page:#0a0a0b;--surface:#141416;--line:#222225;--line-strong:#2e2e32;--line-focus:#48484e;--text:#e6e4df;--muted:#86857f;--accent:#d4a24e;--accent-hover:#c39345;--ok:#7fb069;--err:#e5534b}
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font:13px/20px "Geist",ui-sans-serif,sans-serif;color:var(--text);background:var(--page);-webkit-font-smoothing:antialiased}
main{width:min(400px,100%)}
.logo{display:flex;gap:10px;align-items:center;font-size:16px;font-weight:500;letter-spacing:-0.01em}
.logo img{border-radius:22.5%;box-shadow:0 0 0 1px rgba(255,255,255,0.08)}
.sub{margin:2px 0 24px;color:var(--muted)}
.account{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;margin-bottom:20px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.account span:first-child{color:var(--muted)}
.account span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
p{margin-bottom:16px;color:var(--muted)}
p strong{color:var(--text);font-weight:500}
.step{margin-bottom:8px;color:var(--text)}
.msg{padding:10px 12px;margin-bottom:16px;border-radius:8px;border:1px solid var(--line)}
.msg.err{color:var(--err);border-color:rgba(229,83,75,0.35)}
.msg.ok{color:var(--ok);border-color:rgba(127,176,105,0.35)}
form{display:flex;gap:8px;margin-bottom:12px}
input{flex:1;min-width:0;height:32px;padding:0 10px;font:13px "Geist Mono",ui-monospace,monospace;color:inherit;background:transparent;border:1px solid var(--line-strong);border-radius:6px;outline:none}
input:focus{border-color:var(--line-focus)}
input::placeholder{color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;font:inherit;font-weight:500;line-height:1;white-space:nowrap;text-decoration:none;color:var(--page);background:var(--accent);border:1px solid var(--accent);border-radius:6px;cursor:pointer}
.btn:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.ghost{font-weight:400;color:var(--muted);background:transparent;border-color:transparent;padding:0}
.btn.ghost:hover{color:var(--text)}
.open{margin-bottom:20px}
`;

const styleHash = new Bun.CryptoHasher("sha256")
  .update(STYLES)
  .digest("base64");

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
} as const;

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" } as const;

const page = (
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  target?: ReauthLinkTarget
) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>Reauthorize account · Kleis</title>
      <link rel="icon" href="/admin/icons/favicon.svg" type="image/svg+xml" />
      ${raw(`<style>${STYLES}</style>`)}
    </head>
    <body>
      <main>
        <div class="logo">
          <img src="/admin/icons/favicon.svg" width="28" height="28" alt="" />
          kleis
        </div>
        <div class="sub">
          Reauthorize
          ${target ? `${PROVIDER_NAMES[target.provider]} account` : "account"}
        </div>
        ${
          target
            ? html`<div class="account">
              <span>${PROVIDER_NAMES[target.provider]}</span
              ><span>${target.label ?? "Account"}</span>
            </div>`
            : ""
        }
        ${body}
      </main>
    </body>
  </html>`;

const startForm = (token: string, label: string) =>
  html`<form method="post" action="/reauth/${token}/start">
    <button class="btn" type="submit">${label}</button>
  </form>`;

const startPage = (token: string, target: ReauthLinkTarget) =>
  page(
    html`<p>
        Sign this account in again so Kleis can keep using it. The sign-in
        lasts <strong>one year</strong>. Use the same Claude account and
        organization it uses now.
      </p>
      ${startForm(token, "Get sign-in link")}`,
    target
  );

const signInPage = (
  token: string,
  target: ReauthLinkTarget,
  authorizationUrl: string
) =>
  page(
    html`<p class="step">1. Sign in to Claude</p>
      <p>Use the same Claude account and organization as before.</p>
      <div class="open">
        <a
          class="btn"
          href="${authorizationUrl}"
          target="_blank"
          rel="noopener noreferrer"
          >Open Claude sign-in</a
        >
      </div>
      <p class="step">2. Paste the code Claude shows you</p>
      <form method="post" action="/reauth/${token}/complete">
        <input
          name="code"
          type="text"
          required
          maxlength="${MAX_CODE_LENGTH}"
          placeholder="Authorization code"
          aria-label="Authorization code"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button class="btn" type="submit">Finish</button>
      </form>
      <form method="post" action="/reauth/${token}/start">
        <button class="btn ghost" type="submit">Start over</button>
      </form>`,
    target
  );

const errorPage = (
  token: string,
  target: ReauthLinkTarget,
  error: ReauthLinkError
) =>
  page(
    html`<div class="msg err" role="alert">${error.message}</div>
      ${
        error.linkUsable
          ? html`<p>This link still works.</p>
            ${startForm(token, "Get a new sign-in link")}`
          : ""
      }`,
    target
  );

const successPage = (target: ReauthLinkTarget) =>
  page(
    html`<div class="msg ok" role="status">Done. The account is signed in again.</div>
      <p>It stays signed in for one year. You can close this page.</p>`,
    target
  );

const invalidPage = (message = "This reauthorize link is no longer valid.") =>
  page(
    html`<div class="msg err" role="alert">${message}</div>
      <p>Ask the Kleis admin for a new link.</p>`
  );

export const reauthRoutes = new Hono()
  .use("/reauth/*", async (context, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      context.res.headers.set(name, value);
    }
  })
  .get("/reauth/:token", async (context) => {
    const { token } = context.req.param();
    const target = await describeReauthLink(db, token, Date.now());
    return target
      ? context.html(startPage(token, target))
      : context.html(invalidPage(), 404);
  })
  .post("/reauth/:token/start", async (context) => {
    const { token } = context.req.param();
    try {
      const flow = await startReauthLink(db, token, Date.now());
      return await context.html(signInPage(token, flow, flow.authorizationUrl));
    } catch (error) {
      if (error instanceof ReauthLinkError) {
        return context.html(invalidPage(error.message), 404);
      }
      throw error;
    }
  })
  .post("/reauth/:token/complete", async (context) => {
    const { token } = context.req.param();
    const body = await context.req.parseBody();
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const target = await describeReauthLink(db, token, Date.now());
    if (!target) {
      return context.html(invalidPage(), 404);
    }
    if (!code || code.length > MAX_CODE_LENGTH) {
      return context.html(
        errorPage(
          token,
          target,
          new ReauthLinkError("Paste the code Claude showed you.", true)
        ),
        400
      );
    }
    try {
      return await context.html(
        successPage(await completeReauthLink(db, token, code, Date.now()))
      );
    } catch (error) {
      if (!(error instanceof ReauthLinkError)) {
        throw error;
      }
      return error.linkUsable
        ? context.html(errorPage(token, target, error), 400)
        : context.html(invalidPage(error.message), 410);
    }
  });
