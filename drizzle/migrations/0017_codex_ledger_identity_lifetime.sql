PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_codex_reset_credit_redemptions` (
	`redeem_request_id` text PRIMARY KEY NOT NULL,
	`provider_account_id` text NOT NULL,
	`credit_id` text,
	`account_identity` text,
	`execution_token` text,
	`status` text NOT NULL,
	`result_code` text,
	`windows_reset` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_codex_reset_credit_redemptions`("redeem_request_id", "provider_account_id", "credit_id", "account_identity", "execution_token", "status", "result_code", "windows_reset", "last_error", "created_at", "updated_at") SELECT "redeem_request_id", "provider_account_id", "credit_id", "account_identity", "execution_token", "status", "result_code", "windows_reset", "last_error", "created_at", "updated_at" FROM `codex_reset_credit_redemptions`;--> statement-breakpoint
DROP TABLE `codex_reset_credit_redemptions`;--> statement-breakpoint
ALTER TABLE `__new_codex_reset_credit_redemptions` RENAME TO `codex_reset_credit_redemptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `codex_reset_redemptions_account_idx` ON `codex_reset_credit_redemptions` (`provider_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `codex_reset_redemptions_open_identity_unique` ON `codex_reset_credit_redemptions` (`account_identity`) WHERE "codex_reset_credit_redemptions"."account_identity" is not null and "codex_reset_credit_redemptions"."status" in ('pending', 'ambiguous', 'retryable');