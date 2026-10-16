CREATE TABLE `codex_reset_credit_fences` (
	`account_identity` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `rotated_to_id` text;--> statement-breakpoint
ALTER TABLE `codex_reset_credit_redemptions` ADD `account_identity` text;--> statement-breakpoint
ALTER TABLE `codex_reset_credit_redemptions` ADD `execution_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `codex_reset_redemptions_open_identity_unique` ON `codex_reset_credit_redemptions` (`account_identity`) WHERE "codex_reset_credit_redemptions"."account_identity" is not null and "codex_reset_credit_redemptions"."status" in ('pending', 'ambiguous', 'retryable');