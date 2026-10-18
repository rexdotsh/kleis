CREATE TABLE `claude_reset_claims` (
	`request_id` text PRIMARY KEY NOT NULL,
	`provider_account_id` text NOT NULL,
	`grant_id` text,
	`status` text NOT NULL,
	`result_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_reset_claims_pending_unique` ON `claude_reset_claims` (`provider_account_id`) WHERE "claude_reset_claims"."status" = 'pending';