-- 0080 — 'mcp' devient un canal de job légitime (PR C, étape C1).
--
-- Nodal s'expose désormais comme serveur MCP : un client externe (le terminal
-- du propriétaire, un agent en runtime CLI) peut lui confier du travail via
-- `run_task`. Ce chemin crée un job ordinaire, exécuté par la boucle normale —
-- mais sa PROVENANCE n'est ni un canal de messagerie, ni un cron, ni le
-- dashboard. La dire « api » aurait été un mensonge de provenance, précisément
-- ce que l'audit sert à éviter : quand on lit les Runs, « d'où vient ce job »
-- doit avoir une réponse vraie.
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_channel_check;--> statement-breakpoint
ALTER TABLE agent_jobs
  ADD CONSTRAINT agent_jobs_channel_check
  CHECK (channel IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord','dashboard','webhook','mcp'));
