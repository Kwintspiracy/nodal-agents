// team-block.test.ts — buildTeamBlock DB tests
// Verifies data-driven team block: content reflects DB state, not hardcoded slugs.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { agents, agentAssignments, agentSkillAssignments, agentSkills } from '@nodal-agents/db';
import { buildTeamBlock } from '../team-block';
import type { AgentId } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodal-agents/db')).users)
    .values({ email: `test-tb-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodal-agents/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-tb-${Date.now()}` })
    .returning();
  return { userId: user!.id, entityId: entity!.id };
}

async function seedAgent(
  db: TestDb,
  entityId: string,
  slug: string,
  role: 'agent' | 'orchestrator' = 'orchestrator',
  orchestratorMode?: 'router' | 'planner',
) {
  const [a] = await db
    .insert(agents)
    .values({
      entityId,
      name: `Agent ${slug}`,
      slug,
      personality: 'p',
      role,
      orchestratorMode: orchestratorMode ?? null,
      active: true,
    })
    .returning();
  return a!;
}

async function assignChild(
  db: TestDb,
  orchestratorId: string,
  subAgentId: string,
  entityId: string,
  instructions?: string,
) {
  await db.insert(agentAssignments).values({
    orchestratorId,
    subAgentId,
    entityId,
    instructions: instructions ?? null,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('buildTeamBlock', () => {
  it('returns empty string for agent with no children (worker)', async () => {
    const { entityId } = await seedContext(db);
    const worker = await seedAgent(db, entityId, `test-worker-tb-${Date.now()}`, 'agent');
    const block = await buildTeamBlock(worker.id as AgentId, db);
    expect(block).toBe('');
  });

  it('returns empty string when orchestrator has no assigned children', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(db, entityId, `test-orch-tb-no-children-${Date.now()}`);
    const block = await buildTeamBlock(orch.id as AgentId, db);
    expect(block).toBe('');
  });

  it('contains agent names from DB (not hardcoded)', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-tb-names-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w1 = await seedAgent(db, entityId, `test-widget-bot-${Date.now()}`, 'agent');
    const w2 = await seedAgent(db, entityId, `test-data-fetcher-${Date.now()}`, 'agent');

    await assignChild(db, orch.id, w1.id, entityId);
    await assignChild(db, orch.id, w2.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);

    // Names come from DB — reflect the actual names we seeded
    expect(block).toContain(`Agent test-widget-bot`);
    expect(block).toContain(`Agent test-data-fetcher`);
  });

  it('reflects DB state change (description update)', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-tb-update-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const worker = await seedAgent(db, entityId, `test-updateable-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, worker.id, entityId, 'Original instruction');

    const block1 = await buildTeamBlock(orch.id as AgentId, db);
    expect(block1).toContain('Original instruction');

    // Update instructions in DB
    await db
      .update(agentAssignments)
      .set({ instructions: 'Updated instruction — changed in DB' })
      .where(eq(agentAssignments.subAgentId, worker.id));

    // Re-call — must reflect the new DB state (data-driven, never cached)
    const block2 = await buildTeamBlock(orch.id as AgentId, db);
    expect(block2).toContain('Updated instruction — changed in DB');
    expect(block2).not.toContain('Original instruction');
  });

  it('exposes BOTH delegation styles for a team with sub-orchestrators, leaning router', async () => {
    // Unified orchestrator (Phase 3): a team WITH sub-orchestrators auto-detects
    // `router`, but the block must still offer create_task fan-out — the model
    // picks per request. Only the soft "default lean" reflects the detected mode.
    const { entityId } = await seedContext(db);
    const subOrch = await seedAgent(db, entityId, `test-sub-orch-${Date.now()}`, 'orchestrator');
    const orch = await seedAgent(db, entityId, `test-orch-router-${Date.now()}`, 'orchestrator');
    await assignChild(db, orch.id, subOrch.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);
    const toolSlug = subOrch.slug.replace(/-/g, '_');
    // Both styles offered regardless of detected mode.
    expect(block).toContain(`assign_${toolSlug}`); // in-line delegation tool for the child
    expect(block).toContain('create_task'); // parallel fan-out also offered
    // Soft lean reflects the auto-detected router default (has sub-orchestrators).
    expect(block).toContain('includes sub-orchestrators');
  });

  it('exposes BOTH delegation styles for a workers-only team, leaning planner', async () => {
    // Unified orchestrator (Phase 3): a workers-only team auto-detects `planner`,
    // but the in-line assign_* tool must ALSO be present for single/sequential work.
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-planner-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w = await seedAgent(db, entityId, `test-worker-planner-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);
    const toolSlug = w.slug.replace(/-/g, '_');
    // Both styles offered regardless of detected mode.
    expect(block).toContain('create_task'); // parallel fan-out
    expect(block).toContain('assigned_to'); // task handle reference for the board
    expect(block).toContain(`assign_${toolSlug}`); // in-line tool ALSO available
    // Soft lean reflects the auto-detected planner default (workers only).
    expect(block).toContain('independent workers');
    // Channel-return invariant: the orchestrator must NOT delegate the final
    // summary — the root sends it back automatically. Guard the guidance text.
    expect(block).toContain('NEVER MAKE IT A TASK');
    expect(block.toLowerCase()).toContain('automatic');
  });

  it('includes skill names AND descriptions so the orchestrator routes by capability', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-skills-tb-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w = await seedAgent(db, entityId, `test-skill-worker-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: 'Special Analytics Tool',
        slug: `analytics-tb-${Date.now()}`,
        content: 'Analytics skill content',
        description: 'Generate marketing analytics dashboards from raw data',
      })
      .returning();
    await db.insert(agentSkillAssignments).values({
      entityId,
      agentId: w.id,
      skillId: skill!.id,
    });

    const block = await buildTeamBlock(orch.id as AgentId, db);
    expect(block).toContain('Special Analytics Tool');
    // THE FIX: the orchestrator must see WHAT the skill does (description), not
    // just its opaque name — otherwise it confabulates a fake capable agent
    // instead of delegating to the teammate who actually has the skill.
    expect(block).toContain('Generate marketing analytics dashboards from raw data');
    // Anti-confabulation guard is present.
    expect(block).toContain('GROUND-TRUTH');
    expect(block).toContain('NEVER invent a teammate');
  });

  it('includes sub-agent connector tools so the orchestrator can route Airtable/Notion/etc requests', async () => {
    // Regression for Brique 34bis follow-up: pre-fix, Conciergus (orchestrator)
    // answered "I don't have Airtable access" directly when asked to list bases
    // instead of delegating to Summarizus who had Airtable assigned. The team
    // block must now expose each child's connector tool inventory so the
    // orchestrator can route correctly.
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-conn-tools-${Date.now()}`,
      'orchestrator',
      'router',
    );
    const w = await seedAgent(db, entityId, `test-conn-worker-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    // Seed a connector + credential + assignment for the worker (notion-oauth
    // is in ADAPTER_REGISTRY so the team block should surface its tools).
    const { connectors, credentials, agentConnectorAssignments } = await import('@nodal-agents/db');
    const [cred] = await db
      .insert(credentials)
      .values({
        ownerUserId: (await import('@nodal-agents/db')).users
          ? // re-fetch user id via the seedContext output not available here — query via entityId
            (
              await db
                .select({ id: (await import('@nodal-agents/db')).entities.userId })
                .from((await import('@nodal-agents/db')).entities)
                .where(eq((await import('@nodal-agents/db')).entities.id, entityId))
            )[0]!.id
          : '00000000-0000-0000-0000-000000000000',
        name: 'Test Notion Cred',
        type: 'notion-oauth',
        payload: 'enc:v1:fake',
      })
      .returning();
    const [conn] = await db
      .insert(connectors)
      .values({
        entityId,
        slug: 'notion-oauth',
        name: 'Notion (OAuth)',
        authType: 'oauth2',
        active: true,
        credentialId: cred!.id,
      })
      .returning();
    await db.insert(agentConnectorAssignments).values({
      agentId: w.id,
      connectorId: conn!.id,
      entityId,
      enabledOperations: null, // all enabled
    });

    const block = await buildTeamBlock(orch.id as AgentId, db);
    // Block must surface the connector slug so the orchestrator's LLM knows the
    // worker can do this work (the connector NAME conveys the capability).
    expect(block).toContain('Connectors:');
    expect(block).toContain('notion-oauth');
  });

  it('includes sub-agent MCP server tools so the orchestrator can route Stripe/Cogni/etc requests', async () => {
    // Regression for the Stripe/Conciergus pattern (2026-05-26): Conciergus
    // refused 6× to delegate "tu peux te connecter à Stripe ?" to Summarisus
    // because Stripe was attached as an MCP server (not as a connector) and
    // therefore invisible in the ## Your team block. The team block must
    // surface each child's MCP inventory so the orchestrator can route.
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-mcp-tools-${Date.now()}`,
      'orchestrator',
      'router',
    );
    const w = await seedAgent(db, entityId, `test-mcp-worker-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    // Seed an MCP server with two available tools, then assign it to the worker.
    const { mcpServers, agentMcpServers } = await import('@nodal-agents/db');
    const [server] = await db
      .insert(mcpServers)
      .values({
        entityId,
        name: 'Stripe Test',
        slug: 'stripe',
        transport: 'http',
        url: 'https://mcp.stripe.com',
        // 'header' rather than 'bearer' so this test stays compatible with
        // older test-DB snapshots whose check constraint predates migration
        // 0018. Auth scheme is irrelevant to what we assert here.
        authScheme: 'header',
        authParamName: 'x-api-key',
        availableTools: [
          { name: 'list_customers', description: 'List recent customers' },
          { name: 'retrieve_balance', description: 'Read account balance' },
        ],
        active: true,
      })
      .returning();
    await db.insert(agentMcpServers).values({
      entityId,
      agentId: w.id,
      mcpServerId: server!.id,
      enabledTools: null, // all enabled
    });

    const block = await buildTeamBlock(orch.id as AgentId, db);
    // Block must surface the MCP server slug so the orchestrator knows the
    // worker has this capability (the connector/MCP NAME, not every operation).
    expect(block).toContain('Connectors:');
    expect(block).toContain('stripe');
  });

  it('does not contain hardcoded agent slugs (invariant 1 spot-check)', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-inv1-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w = await seedAgent(db, entityId, `test-worker-inv1-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);

    // The block content should come from DB — synthetic slugs, not legacy hardcoded names
    const FORBIDDEN = ['ender', 'pavel', 'boris', 'jennie', 'stanley', 'sherlock'];
    for (const slug of FORBIDDEN) {
      expect(block.toLowerCase()).not.toContain(slug);
    }
  });
});

// ─── Où va le livrable : jamais la décision de l'orchestrateur ───────────────
//
// Constaté sur le run 92e38e22 (26/08). Alfred n'a AUCUN dossier attaché : pour
// lui le workspace partagé est son espace de travail, et son prompt le lui dit
// — correctement. Il a donc écrit « sauvegarde dans le shared workspace » dans
// sa délégation. Lead-Dev et Dev C, eux, ONT `Documents/Dev` attaché et
// lisaient dans leur propre prompt que leur livrable va là. Ils ont suivi la
// consigne reçue, et l'app est repartie dans le partagé.
//
// Un orchestrateur décide d'un emplacement avec SES dossiers en tête, pour un
// agent qui n'a pas les mêmes. L'information est chez l'exécutant.

describe('buildTeamBlock — emplacement du livrable', () => {
  it('interdit à l’orchestrateur de dicter un chemin, sauf demande de l’utilisateur', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(db, entityId, `test-orch-path-${Date.now()}`, 'orchestrator');
    const w = await seedAgent(db, entityId, `test-worker-path-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);

    expect(block, 'rien n’interdit de mettre un chemin dans une délégation').toMatch(
      /Describe the deliverable, not its location/i,
    );
    expect(block, 'la décision n’est pas explicitement rendue à l’agent qui écrit').toMatch(
      /decided by the agent that writes it/i,
    );
    // L'exception voulue par Quentin : si l'utilisateur a nommé l'endroit,
    // c'est SON instruction, elle passe telle quelle.
    expect(block, 'l’exception « l’utilisateur l’a demandé » a disparu').toMatch(
      /THE ONE EXCEPTION/,
    );
  });

  it('ne dit rien de tel quand l’agent ne PEUT pas déléguer', async () => {
    // Sur la surface cli-runtime il n'y a aucun outil de délégation : une
    // consigne sur « ce que tu mets dans une tâche déléguée » n'aurait pas
    // d'objet, et le fichier tout entier est déjà bâti sur cette distinction.
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(db, entityId, `test-orch-cli-${Date.now()}`, 'orchestrator');
    const w = await seedAgent(db, entityId, `test-worker-cli-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db, { delegation: false });
    expect(block).not.toMatch(/Describe the deliverable, not its location/i);
  });
});
