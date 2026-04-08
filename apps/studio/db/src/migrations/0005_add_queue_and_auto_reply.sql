ALTER TABLE agents ADD COLUMN queue_mode varchar(20) NOT NULL DEFAULT 'off';
ALTER TABLE agents ADD COLUMN auto_replies jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN availability_schedule jsonb DEFAULT NULL;
