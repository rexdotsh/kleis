DROP TABLE `claude_reset_claim_fences`;--> statement-breakpoint
DROP TABLE `claude_reset_claims`;--> statement-breakpoint
DROP INDEX `codex_reset_redemptions_account_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `codex_reset_credit_redemptions_pending_unique` ON `codex_reset_credit_redemptions` (`provider_account_id`) WHERE "codex_reset_credit_redemptions"."status" = 'pending';--> statement-breakpoint
ALTER TABLE `codex_reset_credit_redemptions` DROP COLUMN `windows_reset`;--> statement-breakpoint
ALTER TABLE `codex_reset_credit_redemptions` DROP COLUMN `last_error`;