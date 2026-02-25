CREATE TABLE `request_usage_buckets` (
	`bucket_start` integer NOT NULL,
	`api_key_id` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`provider` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`client_error_count` integer DEFAULT 0 NOT NULL,
	`server_error_count` integer DEFAULT 0 NOT NULL,
	`auth_error_count` integer DEFAULT 0 NOT NULL,
	`rate_limit_count` integer DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`max_latency_ms` integer DEFAULT 0 NOT NULL,
	`last_request_at` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `api_key_id`, `provider_account_id`, `provider`, `endpoint`)
);
--> statement-breakpoint
CREATE INDEX `request_usage_buckets_key_bucket_idx` ON `request_usage_buckets` (`api_key_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `request_usage_buckets_account_bucket_idx` ON `request_usage_buckets` (`provider_account_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `request_usage_buckets_bucket_idx` ON `request_usage_buckets` (`bucket_start`);--> statement-breakpoint
DROP TABLE `api_key_usage_buckets`;