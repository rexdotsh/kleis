import { z } from "zod";

// Owner IDs are opaque to Kleis. They exclude "@" and "/" so a model name can
// carry one as a suffix.
export const ownerIdSchema = z.string().regex(/^[\w.:-]{1,128}$/u);

const OWNER_SUFFIX = /^(.+)@([\w.:-]{1,128})$/u;

// "<model>@<owner>" asks for the owner's own account.
export const splitOwnerSuffix = (
  model: string
): { model: string; owner: string | null } => {
  const match = OWNER_SUFFIX.exec(model);
  return match?.[1] && match[2]
    ? { model: match[1], owner: match[2] }
    : { model, owner: null };
};

export const ownerLabelSchema = z.string().trim().min(1).max(120);

export const oauthOwnerSchema = z.strictObject({
  id: ownerIdSchema,
  label: ownerLabelSchema.nullable(),
});
