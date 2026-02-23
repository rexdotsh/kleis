DROP INDEX `provider_accounts_provider_account_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_accounts_primary_unique` ON `provider_accounts` (`provider`) WHERE "provider_accounts"."is_primary" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_accounts_provider_account_unique` ON `provider_accounts` (`provider`,`account_id`) WHERE "provider_accounts"."account_id" is not null;