import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { adminUiRoutes } from "../../src/http/routes/admin-ui";

const get = (path: string, headers: HeadersInit = {}) =>
  adminUiRoutes.request(`http://localhost${path}`, { headers });

const sha256 = (body: ArrayBuffer) =>
  new Bun.CryptoHasher("sha256").update(body).digest("hex");

const readShell = async () => {
  const response = await get("/admin/sw.js");
  const source = await response.text();
  const prefix = /^self\.KLEIS_SHELL = (.+);\n/.exec(source);
  if (!prefix?.[1]) {
    throw new Error("service worker is missing its shell manifest");
  }
  const shell = JSON.parse(prefix[1]) as {
    version: string;
    files: Record<string, string>;
  };
  return { response, source, shell };
};

describe("admin PWA", () => {
  test("serves a manifest that installs the admin as a standalone app", async () => {
    const response = await get("/admin/manifest.webmanifest");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/manifest+json"
    );

    const manifest = (await response.json()) as {
      id: string;
      start_url: string;
      scope: string;
      display: string;
      icons: { src: string; sizes: string; purpose: string }[];
    };
    expect(manifest.id).toBe("/admin/");
    expect(manifest.start_url).toBe("/admin/");
    expect(manifest.scope).toBe("/admin/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.map((icon) => icon.purpose).sort()).toEqual([
      "any",
      "any",
      "maskable",
      "maskable",
    ]);

    for (const icon of manifest.icons) {
      const image = await get(icon.src);
      expect(image.status).toBe(200);
      expect(image.headers.get("Content-Type")).toBe("image/png");
    }
  });

  test("serves every icon and launch image the page links to", async () => {
    const html = await (await get("/admin/")).text();
    expect(html).toMatch(
      /<link\s+rel="manifest"\s+href="\.\/manifest\.webmanifest"\s*\/?>/
    );
    expect(html).toContain("viewport-fit=cover");

    const links = [...html.matchAll(/href="\.\/(icons\/[^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(links).toContain("icons/apple-touch-icon.png");
    expect(links.filter((link) => link?.includes("launch-")).length).toBe(12);

    for (const link of links) {
      const response = await get(`/admin/${link}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    }
  });

  test("the service worker revalidates and pins the shell's exact files", async () => {
    const { response, source, shell } = await readShell();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/javascript");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(source).toContain('addEventListener("fetch"');

    expect(Object.keys(shell.files)).toContain("./");
    for (const [path, hash] of Object.entries(shell.files)) {
      const asset = await get(
        new URL(path, "http://localhost/admin/").pathname
      );
      expect(asset.status).toBe(200);
      expect(sha256(await asset.arrayBuffer())).toBe(hash);
    }

    const revalidated = await get("/admin/sw.js", {
      "If-None-Match": response.headers.get("ETag") ?? "",
    });
    expect(revalidated.status).toBe(304);
  });

  test("the shell holds only static files, never admin API routes", async () => {
    const { shell } = await readShell();
    for (const path of Object.keys(shell.files)) {
      expect(path).toMatch(
        /^\.\/($|[\w-]+\.(js|css|webmanifest)$|fonts\/|icons\/)/
      );
    }
  });

  test("serves and pins every admin JavaScript module for offline imports", async () => {
    const { shell } = await readShell();
    const modules = readdirSync("public/admin").filter(
      (file) => file.endsWith(".js") && file !== "sw.js"
    );
    for (const file of modules) {
      expect(Object.keys(shell.files)).toContain(`./${file}`);
      const response = await get(`/admin/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/javascript");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      const body = await response.arrayBuffer();
      expect(sha256(body)).toBe(shell.files[`./${file}`]);
      const source = new TextDecoder().decode(body);
      for (const match of source.matchAll(/from "(\.\/[^"\n]+\.js)"/g)) {
        expect(Object.keys(shell.files)).toContain(match[1]);
      }
    }
  });
});
