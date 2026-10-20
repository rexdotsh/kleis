import { z } from "zod";

// Owner IDs are opaque to Kleis. They exclude "@" and "/" so a model name can
// carry one as a suffix.
export const ownerIdSchema = z.string().regex(/^[\w.:-]{1,128}$/u);

export const ownerLabelSchema = z.string().trim().min(1).max(120);

export const oauthOwnerSchema = z.strictObject({
  id: ownerIdSchema,
  label: ownerLabelSchema.nullable(),
});
