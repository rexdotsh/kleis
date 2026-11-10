CREATE TABLE `reauth_links` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`oauth_state` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_account_id`) REFERENCES `provider_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reauth_links_token_hash_unique` ON `reauth_links` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `reauth_links_open_unique` ON `reauth_links` (`provider_account_id`) WHERE "reauth_links"."used_at" is null and "reauth_links"."revoked_at" is null;