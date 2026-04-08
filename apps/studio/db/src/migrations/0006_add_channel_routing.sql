-- connector_bindings: routing enhancements
ALTER TABLE connector_bindings ADD COLUMN priority integer NOT NULL DEFAULT 0;
ALTER TABLE connector_bindings ADD COLUMN trigger_regex text;
ALTER TABLE connector_bindings ADD COLUMN schedule_filter jsonb;

-- connectors: match mode + fallback
ALTER TABLE connectors ADD COLUMN match_mode text NOT NULL DEFAULT 'all';
ALTER TABLE connectors ADD COLUMN default_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
