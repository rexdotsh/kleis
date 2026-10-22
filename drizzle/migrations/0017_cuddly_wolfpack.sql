ALTER TABLE `request_usage_buckets` ADD `cache_write_5m_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_usage_buckets` ADD `cache_write_1h_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_usage_buckets` ADD `cache_repaid_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_usage_buckets` ADD `cache_repaid_idle_tokens` integer DEFAULT 0 NOT NULL;