-- Migration 0016 — drop UNIQUE(entity_id, slug) on connectors.
--
-- Multi-instance brique: an entity should be able to hold N connectors of the
-- same slug (multiple Gmail accounts, multiple Notion workspaces…). The
-- constraint that enforced 1:1 (entity, slug) is removed. Agents reference
-- specific connector instances by id via agent_connector_assignments, so
-- multi-instance was already representable at the join layer — only this
-- top-level constraint blocked it.

ALTER TABLE "connectors" DROP CONSTRAINT IF EXISTS "connectors_entity_slug_unique";
