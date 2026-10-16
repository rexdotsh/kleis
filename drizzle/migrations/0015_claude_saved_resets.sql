CREATE TABLE `claude_reset_claim_fences` (
	`account_identity` text NOT NULL,
	`organization_uuid` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_identity`, `organization_uuid`)
);
--> statement-breakpoint
CREATE TABLE `claude_reset_claims` (
	`request_id` text PRIMARY KEY NOT NULL,
	`provider_account_id` text,
	`account_identity` text NOT NULL,
	`organization_uuid` text NOT NULL,
	`program` text NOT NULL,
	`grant_id` text NOT NULL,
	`offer_key` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`reason` text,
	`resets_left` integer,
	`cleared_json` text,
	`weekly_resets_at` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `claude_reset_claims_account_idx` ON `claude_reset_claims` (`account_identity`,`organization_uuid`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `claude_reset_claims_active_unique` ON `claude_reset_claims` (`account_identity`,`organization_uuid`) WHERE "claude_reset_claims"."status" in ('pending', 'ambiguous');