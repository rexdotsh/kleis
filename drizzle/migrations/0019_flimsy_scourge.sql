DROP INDEX "api_keys_key_unique";--> statement-breakpoint
DROP INDEX "api_keys_models_discovery_token_unique";--> statement-breakpoint
DROP INDEX "provider_accounts_provider_idx";--> statement-breakpoint
DROP INDEX "provider_accounts_enabled_idx";--> statement-breakpoint
DROP INDEX "provider_accounts_primary_idx";--> statement-breakpoint
DROP INDEX "provider_accounts_primary_unique";--> statement-breakpoint
DROP INDEX "provider_accounts_provider_account_unique";--> statement-breakpoint
DROP INDEX "request_usage_buckets_key_bucket_idx";--> statement-breakpoint
DROP INDEX "request_usage_buckets_account_bucket_idx";--> statement-breakpoint
DROP INDEX "request_usage_buckets_bucket_idx";--> statement-breakpoint
DROP INDEX "reset_spends_pending_unique";--> statement-breakpoint
ALTER TABLE `provider_accounts` ALTER COLUMN "refresh_token" TO "refresh_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_unique` ON `api_keys` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_models_discovery_token_unique` ON `api_keys` (`models_discovery_token`);--> statement-breakpoint
CREATE INDEX `provider_accounts_provider_idx` ON `provider_accounts` (`provider`);--> statement-breakpoint
CREATE INDEX `provider_accounts_enabled_idx` ON `provider_accounts` (`provider`,`enabled`);--> statement-breakpoint
CREATE INDEX `provider_accounts_primary_idx` ON `provider_accounts` (`provider`,`is_primary`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_accounts_primary_unique` ON `provider_accounts` (`provider`) WHERE "provider_accounts"."is_primary" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_accounts_provider_account_unique` ON `provider_accounts` (`provider`,`account_id`) WHERE "provider_accounts"."account_id" is not null;--> statement-breakpoint
CREATE INDEX `request_usage_buckets_key_bucket_idx` ON `request_usage_buckets` (`api_key_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `request_usage_buckets_account_bucket_idx` ON `request_usage_buckets` (`provider_account_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `request_usage_buckets_bucket_idx` ON `request_usage_buckets` (`bucket_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `reset_spends_pending_unique` ON `reset_spends` (`provider_account_id`) WHERE "reset_spends"."status" = 'pending';