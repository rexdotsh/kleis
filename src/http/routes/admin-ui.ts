import { type Context, Hono } from "hono";

const ADMIN_ROOT = "./public/admin";
const REVALIDATE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";

type Asset = { body: ArrayBuffer; etag: string; lastModified: number };

// Files are hashed once and re-read only when their modification time changes,
// so browsers revalidate with a cheap 304 instead of downloading them again.
const assets = new Map<string, Asset>();

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
    lastModified,
  };
  assets.set(relativePath, asset);
  return asset;
};

const matchesEtag = (header: string | undefined, etag: string): boolean =>
  header?.split(",").some((value) => value.trim() === etag) ?? false;

const serveAsset =
  (
    relativePath: string,
    contentType: string,
    cacheControl: string,
    extraHeaders: Record<string, string> = {}
  ) =>
  async (context: Context): Promise<Response> => {
    const asset = await readAsset(relativePath);
    const headers = {
      "Cache-Control": cacheControl,
      ETag: asset.etag,
      ...extraHeaders,
    };
    if (matchesEtag(context.req.header("if-none-match"), asset.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(asset.body, {
      headers: { "Content-Type": contentType, ...headers },
    });
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
  .get("/admin/index.html", serveAdminIndex);

for (const fileName of ["app-data.js", "app-render.js", "app.js"]) {
  adminUiRoutes.get(
    `/admin/${fileName}`,
    serveAsset(fileName, "text/javascript; charset=utf-8", REVALIDATE)
  );
}

adminUiRoutes.get(
  "/admin/styles.css",
  serveAsset("styles.css", "text/css; charset=utf-8", REVALIDATE)
);

for (const fileName of ["geist-latin.v1.woff2", "geist-mono-latin.v1.woff2"]) {
  adminUiRoutes.get(
    `/admin/fonts/${fileName}`,
    serveAsset(`fonts/${fileName}`, "font/woff2", IMMUTABLE)
  );
}
