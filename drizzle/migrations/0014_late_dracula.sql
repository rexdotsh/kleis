CREATE TABLE `provider_account_snapshots` (
	`provider_account_id` text PRIMARY KEY NOT NULL,
	`account_identity` text DEFAULT '' NOT NULL,
	`profile_json` text,
	`profile_fetched_at` integer,
	`quota_json` text,
	`quota_fetched_at` integer,
	`last_error` text,
	`last_error_status` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
