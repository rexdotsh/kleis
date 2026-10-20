CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`purpose` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `grants_key_owner_idx` ON `grants` (`api_key_id`,`owner_id`);