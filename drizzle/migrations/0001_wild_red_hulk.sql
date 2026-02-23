DROP INDEX `oauth_states_provider_idx`;--> statement-breakpoint
DROP INDEX `oauth_states_expires_at_idx`;--> statement-breakpoint
ALTER TABLE `oauth_states` DROP COLUMN `created_at`;--> statement-breakpoint
CREATE INDEX `provider_accounts_provider_account_idx` ON `provider_accounts` (`provider`,`account_id`);