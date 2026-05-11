CREATE TABLE "agent_connector_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"enabled_operations" text[],
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_connector_unique" UNIQUE("agent_id","connector_id")
);
--> statement-breakpoint
ALTER TABLE "agent_connector_assignments" ADD CONSTRAINT "agent_connector_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connector_assignments" ADD CONSTRAINT "agent_connector_assignments_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connector_assignments" ADD CONSTRAINT "agent_connector_assignments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_connector_assignments_agent_id" ON "agent_connector_assignments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_connector_assignments_connector_id" ON "agent_connector_assignments" USING btree ("connector_id");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "enabled_builtin_tools";