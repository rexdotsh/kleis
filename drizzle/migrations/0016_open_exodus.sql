CREATE TABLE `reset_spends` (
	`request_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reset_spends_pending_unique` ON `reset_spends` (`provider_account_id`) WHERE "reset_spends"."status" = 'pending';--> statement-breakpoint
DROP TABLE `claude_reset_claim_fences`;--> statement-breakpoint
DROP TABLE `claude_reset_claims`;--> statement-breakpoint
DROP TABLE `codex_reset_credit_redemptions`;