ALTER TABLE "agent_memory" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("fact", ''))) STORED;--> statement-breakpoint
CREATE INDEX "idx_agent_memory_search_tsv" ON "agent_memory" USING gin ("search_tsv");
