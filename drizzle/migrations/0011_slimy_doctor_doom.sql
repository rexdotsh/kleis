CREATE TABLE `claude_api_rate_limit_snapshots` (
	`provider_account_id` text PRIMARY KEY NOT NULL,
	`fetched_at` integer NOT NULL,
	`source_endpoint` text NOT NULL,
	`workspace_id` text,
	`data_json` text NOT NULL,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `codex_reset_credit_redemptions` (
	`redeem_request_id` text PRIMARY KEY NOT NULL,
	`provider_account_id` text NOT NULL,
	`credit_id` text,
	`status` text NOT NULL,
	`result_code` text,
	`windows_reset` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `codex_reset_redemptions_account_idx` ON `codex_reset_credit_redemptions` (`provider_account_id`);--> statement-breakpoint
CREATE TABLE `codex_thread_usage` (
	`provider_account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`estimated_usage_credits_micros` integer,
	`estimated_usage_usd_micros` integer,
	`groups_json` text NOT NULL,
	PRIMARY KEY(`provider_account_id`, `thread_id`),
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_account_tracking` (
	`provider_account_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`fetched_at` integer,
	`attempted_at` integer NOT NULL,
	`next_fetch_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_http_status` integer,
	`last_error` text,
	`data_json` text,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_account_tracking_provider_idx` ON `provider_account_tracking` (`provider`);