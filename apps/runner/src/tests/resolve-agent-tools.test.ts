// resolve-agent-tools.test.ts — unit tests for resolveAgentToolNames (H1b).
// Uses a real pglite in-memory DB (@nodal-agents/db/test-utils) — asserts on
// the real Set<string> returned, never on call counts. No MCP connection is
// ever made (verified implicitly: the seeded MCP server's `command` would
// throw if actually spawned).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agents,
  entities,
  agentSkills,
  agentSkillAssignments,
  mcpServers,
  agentMcpServers,
} from '@nodal-agents/db';
import { resolveAgentToolNames } from '../job/resolve-agent-tools.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

describe('resolveAgentToolNames — plain worker agent', () => {
  it('returns the always-on set and nothing MCP/meta-tool related', async () => {
    const names = await resolveAgentToolNames(db, seed.agentId);
    expect(names.has('save_memory')).toBe(true);
    expect(names.has('query_memory')).toBe(true);
    expect(names.has('return_result')).toBe(true);
    // Not a root agent, no grants → no meta-tools.
    expect(names.has('create_connector')).toBe(false);
    expect(names.has('create_schedule')).toBe(false);
    // No cogni MCP assigned — must NOT have the tool from the root incident.
    expect(names.has('cogni_cortex__get_state')).toBe(false);
  });

  it('throws for an unknown agent id (fail loud)', async () => {
    await expect(resolveAgentToolNames(db, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('resolveAgentToolNames — root agent with grants', () => {
  it('has the meta-tools its grants enable', async () => {
    const [rootAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Root Agent',
        slug: `root-agent-${Date.now()}`,
        personality: 'You are the root.',
        llmKeyId: null,
        role: 'orchestrator',
      })
      .returning();
    if (!rootAgent) throw new Error('failed to seed root agent');

    await db
      .update(entities)
      .set({
        rootAgentId: rootAgent.id,
        rootGrants: { createConnector: true, manageSchedules: true },
      })
      .where(eq(entities.id, seed.entityId));

    const names = await resolveAgentToolNames(db, rootAgent.id);
    expect(names.has('create_connector')).toBe(true);
    expect(names.has('create_schedule')).toBe(true);
    // Orchestrator assembly: task-board + memory + return_result present.
    expect(names.has('create_task')).toBe(true);
    expect(names.has('list_tasks')).toBe(true);
    expect(names.has('return_result')).toBe(true);
    expect(names.has('save_memory')).toBe(true);
    // createMcp grant not set → defaults to false (opt-in, unlike the benign
    // roster grants) — its meta-tool must be absent.
    expect(names.has('create_mcp')).toBe(false);
  });
});

describe('resolveAgentToolNames — MCP server assignment', () => {
  it("includes the assigned server's tools (prefixed) and excludes an unassigned cogni tool", async () => {
    const [server] = await db
      .insert(mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'Fetch',
        slug: 'mcp-fetch',
        transport: 'stdio',
        command: '__never_spawned_in_test__',
        args: [],
        // v2 cache: every entry carries inputSchema — required for
        // isUsableMcpToolCache to treat this as usable without connecting.
        availableTools: [
          {
            name: 'fetch_markdown',
            description: 'Fetch a URL as markdown',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })
      .returning();
    if (!server) throw new Error('failed to seed mcp server');

    await db.insert(agentMcpServers).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      mcpServerId: server.id,
      enabledTools: null,
    });

    const names = await resolveAgentToolNames(db, seed.agentId);
    expect(names.has('mcp_fetch__fetch_markdown')).toBe(true);
    // The root incident's tool, from a DIFFERENT (never-assigned) MCP server,
    // must still be absent.
    expect(names.has('cogni_cortex__get_state')).toBe(false);
  });
});

describe('resolveAgentToolNames — script/file-write gated builtins', () => {
  it('adds run_skill_script only when a skill is scripts_authorized', async () => {
    const before = await resolveAgentToolNames(db, seed.agentId);
    // Server was already assigned above in the same DB — script gating is
    // independent, so this still reflects "no scripts_authorized skill yet"
    // for a fresh agent. Verify against a fresh worker instead to avoid
    // cross-test coupling.
    const [worker] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Worker Agent',
        slug: `worker-agent-${Date.now()}`,
        personality: 'You are a worker.',
        llmKeyId: null,
      })
      .returning();
    if (!worker) throw new Error('failed to seed worker agent');

    const namesNoSkill = await resolveAgentToolNames(db, worker.id);
    expect(namesNoSkill.has('run_skill_script')).toBe(false);
    expect(before.has('save_memory')).toBe(true); // sanity: `before` is usable

    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        name: 'Scripted Skill',
        slug: `scripted-skill-${Date.now()}`,
        content: 'Do the scripted thing.',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    await db.insert(agentSkillAssignments).values({
      entityId: seed.entityId,
      agentId: worker.id,
      skillId: skill.id,
      scriptsAuthorized: true,
    });

    const namesWithSkill = await resolveAgentToolNames(db, worker.id);
    expect(namesWithSkill.has('run_skill_script')).toBe(true);
  });
});
