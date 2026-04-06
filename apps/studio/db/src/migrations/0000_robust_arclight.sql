CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"password" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"joined_at" timestamp DEFAULT now(),
	CONSTRAINT "company_members_company_id_user_id_unique" UNIQUE("company_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_system" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(255) NOT NULL,
	"description" text,
	"plugin_id" varchar(255),
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"memory_config" jsonb DEFAULT 'null'::jsonb,
	"browser_enabled" boolean DEFAULT false NOT NULL,
	"browser_config" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "projects_company_id_slug_unique" UNIQUE("company_id","slug")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"base_prompt" text NOT NULL,
	"allowed_modes" text[] DEFAULT '{"chat","task"}' NOT NULL,
	"compaction_threshold" integer DEFAULT 80 NOT NULL,
	"memory_config" jsonb DEFAULT 'null'::jsonb,
	"persona_seed" jsonb DEFAULT 'null'::jsonb,
	"persona_seeded_at" timestamp,
	"persona_prompt" text,
	"heartbeat_enabled" boolean DEFAULT true NOT NULL,
	"heartbeat_cron" varchar(100) DEFAULT '0 */30 * * *',
	"heartbeat_prompt" text,
	"heartbeat_last_run_at" timestamp,
	"heartbeat_next_run_at" timestamp,
	"task_allowed_agents" text[] DEFAULT null,
	"file_delivery" varchar(20) DEFAULT 'base64' NOT NULL,
	"attachment_scope" varchar(20) DEFAULT 'per_user' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "agents_project_id_slug_unique" UNIQUE("project_id","slug")
);
--> statement-breakpoint
CREATE TABLE "agent_policies" (
	"agent_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"priority" integer DEFAULT 0,
	CONSTRAINT "agent_policies_agent_id_policy_id_pk" PRIMARY KEY("agent_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE "agent_user_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"allowed_permissions" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "agent_user_policies_agent_id_user_id_unique" UNIQUE("agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_template" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"resource_type" varchar(100) NOT NULL,
	"resource_id" varchar(255) NOT NULL,
	"subject_type" varchar(100) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"effect" varchar(20) NOT NULL,
	"priority" integer DEFAULT 0,
	"conditions" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid,
	"mode" varchar(20) DEFAULT 'chat' NOT NULL,
	"title" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"goal" text,
	"type" varchar(20) DEFAULT 'chat' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"caller_id" uuid,
	"parent_conversation_id" uuid,
	"run_status" varchar(20) DEFAULT 'idle' NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(20) NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"model_id" varchar(255),
	"metadata_override" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "agent_credentials_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"group_id" varchar(100) NOT NULL,
	"adapter_id" varchar(100) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"scope_id" uuid NOT NULL,
	"fields_encrypted" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "plugin_kv" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" varchar(255) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "plugin_kv_unique" UNIQUE("project_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"version" varchar(50) NOT NULL,
	"author" varchar(255),
	"icon" varchar(255),
	"category" varchar(100),
	"project_scope" boolean DEFAULT false,
	"config_schema" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "project_plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"plugin_id" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT false,
	"config" jsonb DEFAULT '{}'::jsonb,
	"activated_at" timestamp,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "project_plugins_project_id_plugin_id_unique" UNIQUE("project_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"caller_id" text,
	"scope" varchar(50) NOT NULL,
	"tier" varchar(20) DEFAULT 'extended' NOT NULL,
	"section" varchar(100),
	"content" text NOT NULL,
	"importance" varchar(20) DEFAULT 'medium' NOT NULL,
	"visibility" varchar(50) DEFAULT 'private' NOT NULL,
	"source" varchar(20) DEFAULT 'agent' NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"display_name" text,
	"source_type" text DEFAULT 'any' NOT NULL,
	"source_ref_keys" jsonb,
	"trigger_source" text DEFAULT 'message' NOT NULL,
	"trigger_mode" text DEFAULT 'always' NOT NULL,
	"trigger_keywords" text[],
	"trigger_event_type" text,
	"trigger_event_filter" jsonb,
	"output_adapter" text DEFAULT 'conversation' NOT NULL,
	"output_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_limit_rpm" integer,
	"include_sender_info" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"binding_id" uuid,
	"identity_id" uuid,
	"event_type" text NOT NULL,
	"ref_keys" jsonb NOT NULL,
	"target_ref_keys" jsonb,
	"payload" jsonb NOT NULL,
	"metadata" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"drop_reason" text,
	"processing_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"binding_id" uuid,
	"external_ref_keys" jsonb NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp,
	"mapped_user_id" uuid,
	"conversation_id" uuid,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "connector_invite_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "connector_message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_message_id" uuid NOT NULL,
	"connector_event_id" uuid,
	"event_type" text NOT NULL,
	"actor_ref_keys" jsonb,
	"actor_display_name" text,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"conversation_id" uuid,
	"direction" text NOT NULL,
	"ref_keys" jsonb NOT NULL,
	"content_snapshot" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"display_name" text NOT NULL,
	"credential_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"source" text DEFAULT 'user' NOT NULL,
	"visibility" text DEFAULT 'project' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"project_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid,
	"is_superadmin" boolean DEFAULT false NOT NULL,
	"agent_restrictions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_restrictions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"joined_at" timestamp DEFAULT now(),
	CONSTRAINT "project_memberships_project_id_user_id_unique" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "project_roles_project_id_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "superadmin_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"transferred_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid,
	"mode" varchar(20) DEFAULT 'chat' NOT NULL,
	"provider_id" varchar(100) DEFAULT null,
	"model_id" varchar(100) DEFAULT null,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"raw_system_prompt" varchar DEFAULT null,
	"raw_messages" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"folder_path" text NOT NULL,
	"extension" varchar(50) NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"mime_type" varchar(100) DEFAULT 'text/plain' NOT NULL,
	"content_cache" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_filesystem_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"adapter_id" varchar(50) DEFAULT 's3' NOT NULL,
	"credential_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"total_size_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_filesystem_config_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "project_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid,
	"conversation_id" uuid,
	"user_id" uuid,
	"storage_key" text NOT NULL,
	"filename" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"scope" varchar(20) DEFAULT 'per_user' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_user_policies" ADD CONSTRAINT "agent_user_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_user_policies" ADD CONSTRAINT "agent_user_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_kv" ADD CONSTRAINT "plugin_kv_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plugins" ADD CONSTRAINT "project_plugins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plugins" ADD CONSTRAINT "project_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_bindings" ADD CONSTRAINT "connector_bindings_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_binding_id_connector_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."connector_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_identity_id_connector_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."connector_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_identities" ADD CONSTRAINT "connector_identities_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_identities" ADD CONSTRAINT "connector_identities_binding_id_connector_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."connector_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_identities" ADD CONSTRAINT "connector_identities_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_identities" ADD CONSTRAINT "connector_identities_mapped_user_id_users_id_fk" FOREIGN KEY ("mapped_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_identities" ADD CONSTRAINT "connector_identities_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_invite_codes" ADD CONSTRAINT "connector_invite_codes_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_invite_codes" ADD CONSTRAINT "connector_invite_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_message_events" ADD CONSTRAINT "fk_cme_message" FOREIGN KEY ("connector_message_id") REFERENCES "public"."connector_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_message_events" ADD CONSTRAINT "fk_cme_event" FOREIGN KEY ("connector_event_id") REFERENCES "public"."connector_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_messages" ADD CONSTRAINT "connector_messages_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_messages" ADD CONSTRAINT "connector_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_role_id_project_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."project_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "superadmin_transfers" ADD CONSTRAINT "superadmin_transfers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "superadmin_transfers" ADD CONSTRAINT "superadmin_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "superadmin_transfers" ADD CONSTRAINT "superadmin_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_filesystem_config" ADD CONSTRAINT "project_filesystem_config_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conv_agent_type" ON "conversations" USING btree ("agent_id","type","created_at");--> statement-breakpoint
CREATE INDEX "idx_conv_parent" ON "conversations" USING btree ("parent_conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conv_run_status" ON "conversations" USING btree ("run_status","created_at");--> statement-breakpoint
CREATE INDEX "plugin_kv_project_scope_idx" ON "plugin_kv" USING btree ("project_id","scope");--> statement-breakpoint
CREATE INDEX "idx_bindings_connector" ON "connector_bindings" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_events_connector" ON "connector_events" USING btree ("connector_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_identity_connector" ON "connector_identities" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_identity_binding" ON "connector_identities" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "idx_identity_conversation" ON "connector_identities" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_invite_connector" ON "connector_invite_codes" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_msg_events_message" ON "connector_message_events" USING btree ("connector_message_id");--> statement-breakpoint
CREATE INDEX "idx_conn_messages_conversation" ON "connector_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conn_messages_connector" ON "connector_messages" USING btree ("connector_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_connectors_project" ON "connectors" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_identities_key" ON "user_identities" USING btree ("user_id","project_id","key");--> statement-breakpoint
CREATE INDEX "idx_user_identities_project" ON "user_identities" USING btree ("project_id","key","value");--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "user_identities" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_invitations_company" ON "invitations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_invitations_email" ON "invitations" USING btree ("email","status");--> statement-breakpoint
CREATE INDEX "idx_project_memberships_project" ON "project_memberships" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_memberships_user" ON "project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_project_roles_project" ON "project_roles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_usage_agent" ON "usage_logs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_conv" ON "usage_logs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_usage_user" ON "usage_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_files_project" ON "project_files" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_files_folder" ON "project_files" USING btree ("project_id","folder_path");--> statement-breakpoint
CREATE INDEX "idx_files_extension" ON "project_files" USING btree ("project_id","extension");--> statement-breakpoint
CREATE INDEX "idx_files_updated" ON "project_files" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_files_project_path" ON "project_files" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "idx_attachments_project" ON "project_attachments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_attachments_conversation" ON "project_attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_attachments_user" ON "project_attachments" USING btree ("project_id","user_id");