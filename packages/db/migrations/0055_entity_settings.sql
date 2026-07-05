CREATE TABLE "entity_settings" (
	"entity_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_settings_entity_id_key_pk" PRIMARY KEY("entity_id","key")
);
--> statement-breakpoint
ALTER TABLE "entity_settings" ADD CONSTRAINT "entity_settings_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- M-2 (audit #2): install_notes used to be one machine-global row injected
-- into EVERY entity's agents — the opposite of isolation. Backfill preserves
-- current behaviour for existing installs (the note was already visible
-- everywhere) by copying it to every existing entity as its own row; going
-- forward each entity's notes are independent and owner-gated per entity
-- (see setInstallNotesAction in apps/web).
INSERT INTO "entity_settings" ("entity_id", "key", "value")
SELECT "entities"."id", 'install_notes', "app_settings"."value"
FROM "entities", "app_settings"
WHERE "app_settings"."key" = 'install_notes' AND "app_settings"."value" <> '';
--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'install_notes';
