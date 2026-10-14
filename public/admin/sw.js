// The server prefixes this file with the app shell's content hashes (see
// src/http/routes/admin-ui.ts). Only those static files are cached; every other
// request, including all admin API calls, goes straight to the network.
const SHELL = self.KLEIS_SHELL ?? { version: "dev", files: {} };
const CACHE_PREFIX = "kleis-admin-";
const CACHE = `${CACHE_PREFIX}${SHELL.version}`;
const SCOPE = new URL(self.registration.scope);
const INDEX = new URL("./", SCOPE).href;
const SHELL_URLS = new Set(
  Object.keys(SHELL.files).map((path) => new URL(path, SCOPE).href)
);
const INDEX_PATHS = new Set([SCOPE.pathname, `${SCOPE.pathname}index.html`]);

const hex = (buffer) =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

async function download(path, expectedHash) {
  const url = new URL(path, SCOPE).href;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body = await response.clone().arrayBuffer();
  const actualHash = hex(await crypto.subtle.digest("SHA-256", body));
  if (actualHash !== expectedHash) {
    throw new Error(`${url} does not match this version`);
  }
  return [url, response];
}

// Downloads the whole shell before writing any of it, so a failed or mixed
// download leaves the previous version in charge and the browser retries later.
async function precache() {
  const downloads = await Promise.all(
    Object.entries(SHELL.files).map(([path, hash]) => download(path, hash))
  );
  const cache = await caches.open(CACHE);
  await Promise.all(
    downloads.map(([url, response]) => cache.put(url, response))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })()
  );
});

async function fromCache(url, request) {
  const cached = await caches.match(url, { cacheName: CACHE });
  return cached ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("Authorization")) return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return;
  if (request.mode === "navigate") {
    if (INDEX_PATHS.has(url.pathname) && SHELL_URLS.has(INDEX)) {
      event.respondWith(fromCache(INDEX, request));
    }
    return;
  }
  const href = `${url.origin}${url.pathname}`;
  if (SHELL_URLS.has(href)) event.respondWith(fromCache(href, request));
});
