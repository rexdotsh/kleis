CREATE TABLE `proxy_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`rate_limit_failover` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `exclude_from_failover` integer DEFAULT false NOT NULL;