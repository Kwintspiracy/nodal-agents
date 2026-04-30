CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"icon" text DEFAULT '🏢',
	"industry" text,
	"goal" text,
	"mcp_token" uuid DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "entities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "entity_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'owner',
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "entity_members_role_check" CHECK ("entity_members"."role" IN ('owner', 'admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "agent_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orchestrator_id" uuid NOT NULL,
	"sub_agent_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"entity_id" uuid,
	"daily_token_limit" bigint DEFAULT 0,
	"monthly_token_limit" bigint DEFAULT 0,
	"alert_threshold_pct" integer DEFAULT 80,
	"auto_pause" boolean DEFAULT false,
	"max_job_tokens" integer DEFAULT 150000,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_budgets_agent_id_unique" UNIQUE("agent_id"),
	CONSTRAINT "agent_budgets_alert_threshold_pct_check" CHECK ("agent_budgets"."alert_threshold_pct" >= 0 AND "agent_budgets"."alert_threshold_pct" <= 100)
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"personality" text NOT NULL,
	"model" text DEFAULT 'claude-sonnet-4-6-20260217',
	"active" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"role" text DEFAULT 'agent',
	"orchestrator_mode" text,
	"telegram_bot_token" text,
	"telegram_bot_username" text,
	"telegram_offset" bigint,
	"requires_approval" text[] DEFAULT '{}'::text[],
	"capabilities" text[] DEFAULT '{}'::text[],
	"task_context_template" text,
	"avatar_url" text,
	"system_agent" boolean DEFAULT false,
	"max_tokens_per_job" integer DEFAULT 0 NOT NULL,
	"enabled_builtin_tools" text[],
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agents_slug_unique" UNIQUE("slug"),
	CONSTRAINT "agents_role_check" CHECK ("agents"."role" IN ('agent', 'orchestrator', 'system')),
	CONSTRAINT "agents_orchestrator_mode_check" CHECK ("agents"."orchestrator_mode" IN ('router', 'planner') OR "agents"."orchestrator_mode" IS NULL),
	CONSTRAINT "agents_max_tokens_per_job_check" CHECK ("agents"."max_tokens_per_job" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid,
	"status" text DEFAULT 'pending',
	"channel" text NOT NULL,
	"task" text NOT NULL,
	"original_task" text,
	"chat_id" text,
	"system_prompt" text,
	"messages" jsonb DEFAULT '[]'::jsonb,
	"tools_used" text[] DEFAULT '{}'::text[],
	"turn" integer DEFAULT 0,
	"result" text,
	"error" text,
	"chain_count" integer DEFAULT 0,
	"request_id" text,
	"parent_job_id" uuid,
	"parent_request_id" text,
	"total_duration_ms" integer DEFAULT 0,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"delegation_depth" integer DEFAULT 0,
	"pending_delegation" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_jobs_status_check" CHECK ("agent_jobs"."status" IN ('pending','processing','completed','failed','awaiting_approval','awaiting_delegation','cancelled')),
	CONSTRAINT "agent_jobs_channel_check" CHECK ("agent_jobs"."channel" IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord'))
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"orchestrator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"job_id" uuid,
	"result" text,
	"created_by_agent_id" uuid,
	"assigned_agent_id" uuid,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"cost_usd" numeric(10, 6) DEFAULT '0',
	"depends_on" uuid[] DEFAULT '{}'::uuid[],
	"context" jsonb DEFAULT '{}'::jsonb,
	"root_job_id" uuid,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tasks_status_check" CHECK ("agent_tasks"."status" IN ('todo','in_progress','done','cancelled','blocked')),
	CONSTRAINT "agent_tasks_priority_check" CHECK ("agent_tasks"."priority" IN ('low','medium','high')),
	CONSTRAINT "agent_tasks_title_check" CHECK (char_length("agent_tasks"."title") <= 200),
	CONSTRAINT "agent_tasks_description_check" CHECK ("agent_tasks"."description" IS NULL OR char_length("agent_tasks"."description") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"active" boolean DEFAULT true,
	"auth_type" text DEFAULT 'api_key' NOT NULL,
	"oauth_client_id" text,
	"oauth_client_secret" text,
	"oauth_refresh_token" text,
	"oauth_access_token" text,
	"oauth_token_expires_at" timestamp with time zone,
	"oauth_token_url" text,
	"oauth_scopes" text,
	"oauth_account_name" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "connectors_slug_unique" UNIQUE("slug"),
	CONSTRAINT "connectors_auth_type_check" CHECK ("connectors"."auth_type" IN ('api_key','oauth2','bearer','basic','none'))
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"job_id" uuid,
	"tool_name" text NOT NULL,
	"tool_input" jsonb,
	"tool_output" text,
	"duration_ms" integer,
	"turn" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"job_id" uuid NOT NULL,
	"agent_id" uuid,
	"tool_name" text NOT NULL,
	"tool_input" jsonb NOT NULL,
	"status" text DEFAULT 'pending',
	"requested_at" timestamp with time zone DEFAULT now(),
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"expires_at" timestamp with time zone DEFAULT now() + interval '1 hour',
	"notes" text,
	CONSTRAINT "approval_requests_status_check" CHECK ("approval_requests"."status" IN ('pending','approved','rejected','expired'))
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid,
	"tool_name" text NOT NULL,
	"action" text NOT NULL,
	"condition_json" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "approval_rules_action_check" CHECK ("approval_rules"."action" IN ('auto_approve','require_approval','block'))
);
--> statement-breakpoint
CREATE TABLE "agent_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid,
	"fact" text NOT NULL,
	"category" text DEFAULT 'context',
	"importance" integer DEFAULT 3,
	"source" text DEFAULT 'agent',
	"skill_tags" text[] DEFAULT '{}'::text[],
	"memory_layer" text,
	"embedding" vector(1536),
	"valid_from" timestamp with time zone DEFAULT now(),
	"valid_to" timestamp with time zone,
	"fact_hash" text,
	"archived" boolean DEFAULT false,
	"last_accessed_at" timestamp with time zone DEFAULT now(),
	"access_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_memory_category_check" CHECK ("agent_memory"."category" IN ('preference','context','outcome','learned_rule')),
	CONSTRAINT "agent_memory_importance_check" CHECK ("agent_memory"."importance" >= 1 AND "agent_memory"."importance" <= 5),
	CONSTRAINT "agent_memory_source_check" CHECK ("agent_memory"."source" IN ('agent','reflection','manual'))
);
--> statement-breakpoint
CREATE TABLE "webhook_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"task_template" text NOT NULL,
	"active" boolean DEFAULT true,
	"secret" text,
	"last_triggered_at" timestamp with time zone,
	"trigger_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "webhook_triggers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agent_skill_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"approval_overrides" jsonb DEFAULT '{}'::jsonb,
	"use_custom_instructions" boolean DEFAULT false NOT NULL,
	"enabled_operations" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"content" text NOT NULL,
	"active" boolean DEFAULT true,
	"description" text,
	"default_content" text,
	"content_overridden" boolean DEFAULT false,
	"required_config" jsonb DEFAULT '[]'::jsonb,
	"operations" jsonb DEFAULT '[]'::jsonb,
	"required_builtins" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_skills_name_unique" UNIQUE("name"),
	CONSTRAINT "agent_skills_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "skill_connectors" (
	"skill_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"entity_id" uuid
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"skill_id" uuid,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid NOT NULL,
	"type" text DEFAULT 'cron' NOT NULL,
	"name" text NOT NULL,
	"cron_expr" text NOT NULL,
	"task" text,
	"objectives" text,
	"active" boolean DEFAULT true,
	"last_run" timestamp with time zone,
	"next_run" timestamp with time zone,
	"last_status" text,
	"chat_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_schedules_type_check" CHECK ("agent_schedules"."type" IN ('cron','heartbeat')),
	CONSTRAINT "agent_schedules_last_status_check" CHECK ("agent_schedules"."last_status" IN ('success','failed','no_action') OR "agent_schedules"."last_status" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "entity_llm_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"api_key" text DEFAULT '' NOT NULL,
	"base_url" text,
	"nickname" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid,
	"task" text NOT NULL,
	"result" text,
	"success" boolean DEFAULT true,
	"tools_used" text[] DEFAULT '{}'::text[],
	"tokens_used" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"key_source" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_runs_key_source_check" CHECK ("agent_runs"."key_source" IN ('entity','operator') OR "agent_runs"."key_source" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "agent_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"enabled_tools" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"tool_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" text[] DEFAULT '{}'::text[],
	"env_vars" jsonb DEFAULT '{}'::jsonb,
	"active" boolean DEFAULT true,
	"available_tools" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" IN ('http','stdio'))
);
--> statement-breakpoint
CREATE TABLE "agent_plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"plugin_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"active" boolean DEFAULT true,
	"hook" text NOT NULL,
	"webhook_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_plugins_plugin_type_check" CHECK ("agent_plugins"."plugin_type" IN ('webhook','transform','schedule')),
	CONSTRAINT "agent_plugins_hook_check" CHECK ("agent_plugins"."hook" IN ('pre_task','post_task','pre_tool','post_tool','on_memory_save'))
);
--> statement-breakpoint
CREATE TABLE "configurator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"agent_id" uuid,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1,
	"window_start" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_members" ADD CONSTRAINT "entity_members_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_members" ADD CONSTRAINT "entity_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_assignments" ADD CONSTRAINT "agent_assignments_orchestrator_id_agents_id_fk" FOREIGN KEY ("orchestrator_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_assignments" ADD CONSTRAINT "agent_assignments_sub_agent_id_agents_id_fk" FOREIGN KEY ("sub_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_assignments" ADD CONSTRAINT "agent_assignments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_orchestrator_id_agents_id_fk" FOREIGN KEY ("orchestrator_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_connectors" ADD CONSTRAINT "skill_connectors_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_connectors" ADD CONSTRAINT "skill_connectors_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_connectors" ADD CONSTRAINT "skill_connectors_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_llm_keys" ADD CONSTRAINT "entity_llm_keys_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_sessions" ADD CONSTRAINT "configurator_sessions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_sessions" ADD CONSTRAINT "configurator_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_mcp_token_idx" ON "entities" USING btree ("mcp_token");--> statement-breakpoint
CREATE INDEX "idx_entities_user_id" ON "entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_entity_members_entity_id" ON "entity_members" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_entity_members_user_id" ON "entity_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_entity_members_user" ON "entity_members" USING btree ("user_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_budgets_entity_id" ON "agent_budgets" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agents_entity_id" ON "agents" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_entity_id" ON "agent_jobs" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_entity_created" ON "agent_jobs" USING btree ("entity_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_entity_status_created" ON "agent_jobs" USING btree ("entity_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_parent_job_id" ON "agent_jobs" USING btree ("parent_job_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_parent" ON "agent_jobs" USING btree ("parent_job_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_status" ON "agent_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_entity" ON "agent_tasks" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_entity_status_created" ON "agent_tasks" USING btree ("entity_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_orchestrator_status" ON "agent_tasks" USING btree ("orchestrator_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_status" ON "agent_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_assigned" ON "agent_tasks" USING btree ("assigned_agent_id");--> statement-breakpoint
CREATE INDEX "idx_connectors_entity_id" ON "connectors" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_tool_calls_entity_id" ON "tool_calls" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_tool_calls_job" ON "tool_calls" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_tool_calls_job_created" ON "tool_calls" USING btree ("job_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_tool_calls_recent" ON "tool_calls" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_approval_requests_entity_id" ON "approval_requests" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_approval_status" ON "approval_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_agent_id" ON "approval_requests" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_job_id" ON "approval_requests" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_approval_rules_entity_id" ON "approval_rules" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_memory_entity_id" ON "agent_memory" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_memory_entity_active" ON "agent_memory" USING btree ("entity_id","archived","valid_to");--> statement-breakpoint
CREATE INDEX "idx_agent_memory_archived" ON "agent_memory" USING btree ("archived");--> statement-breakpoint
CREATE INDEX "idx_agent_memory_last_accessed" ON "agent_memory" USING btree ("last_accessed_at");--> statement-breakpoint
CREATE INDEX "idx_agent_memory_layer" ON "agent_memory" USING btree ("memory_layer");--> statement-breakpoint
CREATE INDEX "idx_agent_memory_fact_hash" ON "agent_memory" USING btree ("fact_hash");--> statement-breakpoint
CREATE INDEX "idx_memory_category" ON "agent_memory" USING btree ("category","importance" DESC);--> statement-breakpoint
CREATE INDEX "idx_webhook_triggers_entity_id" ON "webhook_triggers" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_entity_id" ON "agent_skills" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_skills_active" ON "agent_skills" USING btree ("active","slug");--> statement-breakpoint
CREATE INDEX "idx_skill_connectors_entity_id" ON "skill_connectors" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_skill_connectors_skill_id" ON "skill_connectors" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "idx_skill_versions_entity_id" ON "skill_versions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_skill_versions_skill_id" ON "skill_versions" USING btree ("skill_id","version" DESC);--> statement-breakpoint
CREATE INDEX "idx_agent_schedules_entity_id" ON "agent_schedules" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_active" ON "agent_schedules" USING btree ("active","next_run");--> statement-breakpoint
CREATE INDEX "idx_entity_llm_keys_entity_id" ON "entity_llm_keys" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_entity_id" ON "agent_runs" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_agent_created" ON "agent_runs" USING btree ("agent_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_runs_agent" ON "agent_runs" USING btree ("agent_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_runs_recent" ON "agent_runs" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_agent_mcp_servers_agent" ON "agent_mcp_servers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_mcp_servers_entity" ON "agent_mcp_servers" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_connections_entity" ON "mcp_connections" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_configurator_sessions_entity" ON "configurator_sessions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_configurator_sessions_agent" ON "configurator_sessions" USING btree ("agent_id");