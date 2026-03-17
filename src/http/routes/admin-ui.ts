import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Hono } from "hono";

const ADMIN_PUBLIC_ROOT = join(process.cwd(), "public/admin");
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

const adminFiles = {
  "app-data.js": "text/javascript; charset=utf-8",
  "app-render.js": "text/javascript; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "index.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
} as const;

const respondWithStaticFile = async (
  fileName: keyof typeof adminFiles
): Promise<Response> => {
  try {
    const file = await readFile(join(ADMIN_PUBLIC_ROOT, fileName));
    return new Response(file, {
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": adminFiles[fileName],
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Response("Not found", {
        status: 404,
        headers: NO_STORE_HEADERS,
      });
    }

    throw error;
  }
};

const serveAdminIndex = async (): Promise<Response> =>
  respondWithStaticFile("index.html");

export const adminUiRoutes = new Hono()
  .get("/admin", async () => serveAdminIndex())
  .get("/admin/", async () => serveAdminIndex())
  .get("/admin/index.html", async () => serveAdminIndex());

for (const fileName of Object.keys(adminFiles)) {
  if (fileName === "index.html") {
    continue;
  }

  adminUiRoutes.get(`/admin/${fileName}`, async () =>
    respondWithStaticFile(fileName as keyof typeof adminFiles)
  );
}
