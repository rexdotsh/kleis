CREATE TABLE `request_usage_buckets_new` (
	`bucket_start` integer NOT NULL,
	`api_key_id` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`provider` text NOT NULL,
	`endpoint` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`client_error_count` integer DEFAULT 0 NOT NULL,
	`server_error_count` integer DEFAULT 0 NOT NULL,
	`auth_error_count` integer DEFAULT 0 NOT NULL,
	`rate_limit_count` integer DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`max_latency_ms` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`last_request_at` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `api_key_id`, `provider_account_id`, `provider`, `endpoint`, `model`)
);
--> statement-breakpoint
INSERT INTO `request_usage_buckets_new` (
	`bucket_start`,
	`api_key_id`,
	`provider_account_id`,
	`provider`,
	`endpoint`,
	`model`,
	`request_count`,
	`success_count`,
	`client_error_count`,
	`server_error_count`,
	`auth_error_count`,
	`rate_limit_count`,
	`total_latency_ms`,
	`max_latency_ms`,
	`input_tokens`,
	`output_tokens`,
	`cache_read_tokens`,
	`cache_write_tokens`,
	`last_request_at`
)
SELECT
	`bucket_start`,
	`api_key_id`,
	`provider_account_id`,
	`provider`,
	`endpoint`,
	'' AS `model`,
	`request_count`,
	`success_count`,
	`client_error_count`,
	`server_error_count`,
	`auth_error_count`,
	`rate_limit_count`,
	`total_latency_ms`,
	`max_latency_ms`,
	0 AS `input_tokens`,
	0 AS `output_tokens`,
	0 AS `cache_read_tokens`,
	0 AS `cache_write_tokens`,
	`last_request_at`
FROM `request_usage_buckets`;
--> statement-breakpoint
DROP TABLE `request_usage_buckets`;
--> statement-breakpoint
ALTER TABLE `request_usage_buckets_new` RENAME TO `request_usage_buckets`;
--> statement-breakpoint
CREATE INDEX `request_usage_buckets_key_bucket_idx` ON `request_usage_buckets` (`api_key_id`,`bucket_start`);
--> statement-breakpoint
CREATE INDEX `request_usage_buckets_account_bucket_idx` ON `request_usage_buckets` (`provider_account_id`,`bucket_start`);
--> statement-breakpoint
CREATE INDEX `request_usage_buckets_bucket_idx` ON `request_usage_buckets` (`bucket_start`);
