import { eq } from "drizzle-orm";

import type { Database } from "../index";
import { codexResetCreditRedemptions } from "../schema";

export const findCodexResetCreditRedemption = (
  database: Database,
  redeemRequestId: string
) =>
  database.query.codexResetCreditRedemptions.findFirst({
    where: eq(codexResetCreditRedemptions.redeemRequestId, redeemRequestId),
  });

export const saveCodexResetCreditRedemption = async (
  database: Database,
  input: typeof codexResetCreditRedemptions.$inferInsert
): Promise<void> => {
  await database
    .insert(codexResetCreditRedemptions)
    .values(input)
    .onConflictDoUpdate({
      target: codexResetCreditRedemptions.redeemRequestId,
      set: {
        status: input.status,
        resultCode: input.resultCode,
        windowsReset: input.windowsReset,
        lastError: input.lastError,
        updatedAt: input.updatedAt,
      },
    });
};
