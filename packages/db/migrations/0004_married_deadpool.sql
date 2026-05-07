ALTER TABLE "agents" ADD COLUMN "llm_key_id" uuid;--> statement-breakpoint
ALTER TABLE "entity_llm_keys" ADD COLUMN "default_model" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_llm_key_id_entity_llm_keys_id_fk" FOREIGN KEY ("llm_key_id") REFERENCES "public"."entity_llm_keys"("id") ON DELETE set null ON UPDATE no action;