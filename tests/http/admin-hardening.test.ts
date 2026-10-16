import { expect, test } from "bun:test";
import { adminUiRoutes } from "../../src/http/routes/admin-ui";

test("admin page cannot be framed", async () => {
  const response = await adminUiRoutes.request("/admin");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "frame-ancestors 'none'"
  );
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
});
