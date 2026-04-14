-- Group/channel bindings can now control whether new members (identities) in
-- the scope are auto-approved or require admin approval before the agent
-- responds to them. Default `require_approval` is safer — prevents unknown
-- users in a group from silently triggering the agent on their first message.
--
-- Values: 'require_approval' | 'allow_all'
-- For DM bindings (source_type='private') this column is ignored — a DM
-- binding is already scoped to a single user via source_ref_keys.user_id.

ALTER TABLE "connector_bindings"
  ADD COLUMN IF NOT EXISTS "member_mode" text NOT NULL DEFAULT 'require_approval';
