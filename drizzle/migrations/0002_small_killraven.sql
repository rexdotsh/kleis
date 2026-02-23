ALTER TABLE `provider_accounts` ADD `refresh_lock_token` text;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `refresh_lock_expires_at` integer;