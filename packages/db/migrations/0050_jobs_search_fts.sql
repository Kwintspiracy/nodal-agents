ALTER TABLE "agent_jobs" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("search_text", ''))) STORED;--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_search_tsv" ON "agent_jobs" USING gin ("search_tsv");--> statement-breakpoint
UPDATE "agent_jobs" SET "search_text" = trim(coalesce("task", '') || ' ' || coalesce("result", '')) WHERE "search_text" IS NULL AND (coalesce("task", '') <> '' OR coalesce("result", '') <> '');
