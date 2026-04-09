-- Add source tracking columns to project_attachments
-- Allows tracking origin: user_upload, browser, connector, plugin, context_write, system

ALTER TABLE project_attachments
ADD COLUMN source_type varchar(30) NOT NULL DEFAULT 'user_upload',
ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';

CREATE INDEX idx_attachments_source_type ON project_attachments(source_type);
