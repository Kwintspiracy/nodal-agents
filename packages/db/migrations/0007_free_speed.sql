-- Step A: drop orphan rows (entity_id NULL is meaningless under the new constraint)
DELETE FROM connectors WHERE entity_id IS NULL;--> statement-breakpoint

-- Step B: deduplicate by (entity_id, slug) — keep the most recently updated row
DELETE FROM connectors c1
USING connectors c2
WHERE c1.entity_id = c2.entity_id
  AND c1.slug = c2.slug
  AND c1.id <> c2.id
  AND c1.updated_at < c2.updated_at;--> statement-breakpoint

-- Step C: drop old global UNIQUE constraint
ALTER TABLE "connectors" DROP CONSTRAINT IF EXISTS "connectors_slug_unique";--> statement-breakpoint

-- Step D: add composite UNIQUE constraint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_entity_slug_unique" UNIQUE("entity_id","slug");
