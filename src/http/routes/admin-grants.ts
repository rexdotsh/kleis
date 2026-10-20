import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import { listLiveGrants, revokeGrant } from "../../db/repositories/grants";

const grantParamsSchema = z.strictObject({ id: z.uuid() });

export const adminGrantsRoutes = new Hono()
  .get("/", async (context) =>
    context.json({ grants: await listLiveGrants(db, Date.now()) })
  )
  .delete("/:id", zValidator("param", grantParamsSchema), async (context) => {
    const revoked = await revokeGrant(
      db,
      context.req.valid("param").id,
      Date.now()
    );
    return revoked
      ? context.json({ revoked: true })
      : context.json({ error: "not_found", message: "Grant not found" }, 404);
  });
