ALTER TABLE `provider_accounts` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `provider_accounts_enabled_idx` ON `provider_accounts` (`provider`,`enabled`);