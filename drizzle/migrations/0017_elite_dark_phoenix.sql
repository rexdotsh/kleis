ALTER TABLE `provider_accounts` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `owner_label` text;--> statement-breakpoint
CREATE INDEX `provider_accounts_owner_idx` ON `provider_accounts` (`owner_id`,`provider`);