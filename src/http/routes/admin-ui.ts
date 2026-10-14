import { type Context, Hono } from "hono";
import { readdirSync } from "node:fs";

const ADMIN_ROOT = "./public/admin";
const REVALIDATE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";
const JAVASCRIPT = "text/javascript; charset=utf-8";

type Asset = {
  body: ArrayBuffer;
  etag: string;
  sha256: string;
  lastModified: number;
};

// Files are hashed once and re-read only when their modification time changes,
// so browsers revalidate with a cheap 304 instead of downloading them again.
const assets = new Map<string, Asset>();

const sha256 = (data: ArrayBuffer | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

const readAsset = async (relativePath: string): Promise<Asset> => {
  const file = Bun.file(`${ADMIN_ROOT}/${relativePath}`);
  const lastModified = file.lastModified;
  const cached = assets.get(relativePath);
  if (cached && cached.lastModified === lastModified) {
    return cached;
  }
  const body = await file.arrayBuffer();
  const asset = {
    body,
    etag: `"${Bun.hash(body).toString(36)}"`,
    sha256: sha256(body),
    lastModified,
  };
  assets.set(relativePath, asset);
  return asset;
};

const matchesEtag = (header: string | undefined, etag: string): boolean =>
  header?.split(",").some((value) => value.trim() === etag) ?? false;

const respond = (
  context: Context,
  body: ArrayBuffer | string,
  etag: string,
  contentType: string,
  cacheControl: string,
  extraHeaders: Record<string, string> = {}
): Response => {
  const headers = {
    "Cache-Control": cacheControl,
    ETag: etag,
    ...extraHeaders,
  };
  if (matchesEtag(context.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    headers: { "Content-Type": contentType, ...headers },
  });
};

const serveAsset =
  (
    relativePath: string,
    contentType: string,
    cacheControl: string,
    extraHeaders: Record<string, string> = {}
  ) =>
  async (context: Context): Promise<Response> => {
    const asset = await readAsset(relativePath);
    return respond(
      context,
      asset.body,
      asset.etag,
      contentType,
      cacheControl,
      extraHeaders
    );
  };

const JAVASCRIPT_FILES = [
  "app-account-status.js",
  "app-accounts.js",
  "app-accounts-render.js",
  "app-charts.js",
  "app-core.js",
  "app-format.js",
  "app-key-access.js",
  "app-keys.js",
  "app-keys-render.js",
  "app-lists.js",
  "app-menu.js",
  "app-menu-render.js",
  "app-motion.js",
  "app-oauth.js",
  "app-pwa.js",
  "app-render-shared.js",
  "app-session.js",
  "app-shortcuts.js",
  "app-state.js",
  "app-usage.js",
  "app-usage-render.js",
  "app.js",
];

// The app shell the service worker keeps for instant and offline launches.
// Only these static files are cached; admin API responses never are.
const SHELL_FILES = [
  "index.html",
  ...JAVASCRIPT_FILES,
  "styles.css",
  "manifest.webmanifest",
  "fonts/geist-latin.v1.woff2",
  "fonts/geist-mono-latin.v1.woff2",
  "icons/favicon.svg",
  "icons/favicon-32.png",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
];

// The worker is prefixed with the shell's content hashes, so any change to a
// shell file changes the worker and installs a new version. The worker checks
// each download against its hash, so a deploy that lands mid-install (old and
// new servers both answering) cannot leave it with a mixed set of files.
const serveServiceWorker = async (context: Context): Promise<Response> => {
  const files: Record<string, string> = {};
  for (const file of SHELL_FILES) {
    const url = file === "index.html" ? "./" : `./${file}`;
    files[url] = (await readAsset(file)).sha256;
  }
  const worker = await readAsset("sw.js");
  const version = sha256(JSON.stringify(files) + worker.sha256).slice(0, 16);
  const shell = JSON.stringify({ version, files });
  const body = `self.KLEIS_SHELL = ${shell};\n${new TextDecoder().decode(worker.body)}`;
  return respond(context, body, `"${version}"`, JAVASCRIPT, REVALIDATE);
};

const serveAdminIndex = serveAsset(
  "index.html",
  "text/html; charset=utf-8",
  REVALIDATE,
  {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  }
);

export const adminUiRoutes = new Hono()
  .get("/admin", serveAdminIndex)
  .get("/admin/", serveAdminIndex)
  .get("/admin/index.html", serveAdminIndex)
  .get("/admin/sw.js", serveServiceWorker);

for (const fileName of JAVASCRIPT_FILES) {
  adminUiRoutes.get(
    `/admin/${fileName}`,
    serveAsset(fileName, JAVASCRIPT, REVALIDATE)
  );
}

adminUiRoutes.get(
  "/admin/styles.css",
  serveAsset("styles.css", "text/css; charset=utf-8", REVALIDATE)
);

adminUiRoutes.get(
  "/admin/manifest.webmanifest",
  serveAsset("manifest.webmanifest", "application/manifest+json", REVALIDATE)
);

for (const fileName of ["geist-latin.v1.woff2", "geist-mono-latin.v1.woff2"]) {
  adminUiRoutes.get(
    `/admin/fonts/${fileName}`,
    serveAsset(`fonts/${fileName}`, "font/woff2", IMMUTABLE)
  );
}

const ICON_TYPES: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
};

for (const fileName of readdirSync(`${ADMIN_ROOT}/icons`)) {
  const contentType = ICON_TYPES[fileName.split(".").pop() ?? ""];
  if (contentType) {
    adminUiRoutes.get(
      `/admin/icons/${fileName}`,
      serveAsset(`icons/${fileName}`, contentType, REVALIDATE)
    );
  }
}
