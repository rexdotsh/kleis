ALTER TABLE `api_keys` ADD `models_discovery_token` text;--> statement-breakpoint
UPDATE `api_keys`
SET `models_discovery_token` = 'kmd_' || replace(`id`, '-', '')
WHERE `models_discovery_token` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_models_discovery_token_unique` ON `api_keys` (`models_discovery_token`);
