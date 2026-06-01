-- 0029_backfill_root_agent.sql
-- Brique F — "ROOT = origin orchestrator" (2026-06-01).
--
-- Designate a ROOT for any entity that has at least one orchestrator but no
-- root_agent_id yet: the earliest-created orchestrator wins. Additive only —
-- entities that already have a ROOT (and its configured grants) are left
-- untouched, so a manually-set ROOT and its powers are preserved.
--
-- Going forward, createAgentRepo auto-designates the first orchestrator of an
-- entity as ROOT and forces subsequent ones under it. Grants start all-off
-- (opt-in powers in Settings → ROOT agent); writing them explicitly matters
-- because a null root_grants parses to all-on (un-gated meta-tools).
--
-- Idempotent: the `root_agent_id IS NULL` guard makes re-runs a no-op.

UPDATE entities e
SET
  root_agent_id = sub.first_orch,
  root_grants = '{"createAgent":false,"createSkill":false,"updateSkill":false,"assignSkill":false,"createMcp":false,"autonomy":"propose_confirm"}'::jsonb,
  updated_at = now()
FROM (
  SELECT a.entity_id, a.id AS first_orch
  FROM agents a
  WHERE a.role = 'orchestrator'
    AND NOT EXISTS (
      SELECT 1 FROM agents a2
      WHERE a2.entity_id = a.entity_id
        AND a2.role = 'orchestrator'
        AND (a2.created_at < a.created_at OR (a2.created_at = a.created_at AND a2.id < a.id))
    )
) AS sub
WHERE e.id = sub.entity_id
  AND e.root_agent_id IS NULL;
