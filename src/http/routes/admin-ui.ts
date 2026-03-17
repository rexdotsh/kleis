import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const serveAdminIndex = serveStatic({
  path: "./public/admin/index.html",
  onFound: (_path, context) => {
    context.header("Cache-Control", "no-store");
  },
});

const serveAdminAsset = (fileName: string) =>
  serveStatic({
    path: `./public/admin/${fileName}`,
  });

export const adminUiRoutes = new Hono()
  .get("/admin", serveAdminIndex)
  .get("/admin/", serveAdminIndex)
  .get("/admin/index.html", serveAdminIndex);

for (const fileName of [
  "app-data.js",
  "app-render.js",
  "app.js",
  "styles.css",
]) {
  adminUiRoutes.get(`/admin/${fileName}`, serveAdminAsset(fileName));
}
