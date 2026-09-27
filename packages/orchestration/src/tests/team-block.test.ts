// team-block.test.ts — buildTeamBlock DB tests
// Verifies data-driven team block: content reflects DB state, not hardcoded slugs.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentAssignments,
  agentSkillAssignments,
  agentSkills,
  agentWorkspaces,
} from '@nodal-agents/db';
import { buildTeamBlock } from '../team-block';
import { holdersOfPath } from '../path-holders';
import { resolveRunWorkspaces } from '@nodal-agents/tools';
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

describe('buildTeamBlock @cap:organiser-equipe/moteur', () => {
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

// ─── Le harnais ne dicte pas de COMPORTEMENT ─────────────────────────────────
//
// Une règle « ne dicte pas de chemin en déléguant » a vécu ici quelques heures
// le 26/08, pour corriger un run où l'orchestrateur imposait le workspace
// partagé à des exécutants qui avaient leur propre dossier.
//
// Retirée : c'est une INSTRUCTION D'AGENT, pas une loi du harnais — invariant
// #3, « fix at agent layer, never patch the runtime ». Elle s'imposait à tous
// les orchestrateurs de toutes les installs pour un besoin qui appartient à un
// espace de travail précis, et la personnalité d'un agent se corrige en une
// minute sans revue de code.
//
// Ce test existe pour que la rustine ne revienne pas par habitude.

describe('buildTeamBlock — ce qui n’a rien à y faire', () => {
  it('ne dicte AUCUN comportement de rangement de fichier', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(db, entityId, `test-orch-path-${Date.now()}`, 'orchestrator');
    const w = await seedAgent(db, entityId, `test-worker-path-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);

    // Le bloc décrit l'ÉQUIPE et les OUTILS de délégation — des faits. Où
    // ranger un livrable est un comportement : il appartient à la personnalité.
    expect(
      block,
      'une consigne de rangement est revenue dans le harnais — elle va dans la personnalité',
    ).not.toMatch(/deliverable, not its location|where a file is saved|folder, a path/i);

    // Ce que le bloc doit toujours faire, lui, reste là.
    expect(block).toContain('create_task');
    expect(block).toContain('Your agents:');
  });
});

// #506 — l'orchestrateur ne savait ni OÙ ses agents travaillent ni s'ils
// peuvent lancer une commande. Run 0b505b0d : il a inventé `shared/Nodal-Video`
// pour un dossier qui était dans celui de Montage. Run 8dfe4684 : il a confié
// un rendu shell à un agent au runtime Claude Code, qui refuse toute commande.
// Le roster dit donc, pour CHAQUE agent et depuis la base : ses dossiers, son
// runtime, et s'il peut lancer des commandes.
describe('buildTeamBlock — ce que chaque agent peut réellement faire (#506) @cap:organiser-equipe/moteur', () => {
  async function seedCommandSkill(): Promise<string> {
    const [skill] = await db
      .insert(agentSkills)
      .values({
        slug: `command-execution-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: `Command execution ${Math.random().toString(36).slice(2, 9)}`,
        description: 'runs shell commands',
        content: 'Command execution skill content',
        requiredBuiltins: ['run_command'],
      })
      .returning();
    return skill!.id;
  }

  function entryOf(block: string, name: string): string {
    const start = block.indexOf(`**${name}**`);
    expect(start, `${name} absent du roster`).toBeGreaterThan(-1);
    const next = block.indexOf('\n- **', start + 1);
    const end = next === -1 ? block.indexOf('\n\n', start) : next;
    return block.slice(start, end === -1 ? undefined : end);
  }

  it('liste les dossiers de chaque agent (label et chemin) depuis agent_workspaces', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(db, entityId, `test-orch-ws-${Date.now()}`, 'orchestrator');
    const w = await seedAgent(db, entityId, `test-montage-${Date.now()}`, 'agent');
    const bare = await seedAgent(db, entityId, `test-bare-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);
    await assignChild(db, orch.id, bare.id, entityId);
    await db.insert(agentWorkspaces).values([
      {
        agentId: w.id,
        entityId,
        label: 'Montage',
        path: 'C:\\Users\\u\\Nodal\\Montage',
        position: 0,
      },
      { agentId: w.id, entityId, label: 'rushes', path: '/data/rushes', position: 1 },
    ]);

    const block = await buildTeamBlock(orch.id as AgentId, db);

    // EXACTEMENT la liste que le run de chaque agent reçoit — la même fonction
    // la construit — partagé de l'espace compris (revue Codex de #506, P1).
    const shared = (await resolveRunWorkspaces(db, bare.id, entityId)).sharedPath;
    expect(shared).toContain(entityId);
    const montage = entryOf(block, w.name);
    expect(montage).toContain(
      `Folders: Montage = C:\\Users\\u\\Nodal\\Montage; rushes = /data/rushes; shared = ${shared}`,
    );
    // Un agent sans dossier attaché lit et écrit quand même le partagé.
    expect(entryOf(block, bare.name)).toContain(`Folders: shared = ${shared}`);
    // La règle de vérité couvre aussi les dossiers : un dossier absent du
    // roster n'est à personne, l'orchestrateur le dit au lieu d'inventer.
    expect(block).toMatch(/folder/i);
    // Revue Codex de #506, passe 3 : la liste ne donne que des RACINES. La
    // phrase de vérité doit dire qu'un agent a aussi tout ce qu'elles
    // contiennent, qu'un dossier nommé se cherche SOUS une racine listée, et
    // qu'il n'est à personne seulement s'il n'est sous aucune.
    expect(block).toContain('and everything inside them');
    expect(block).toContain('look for it UNDER the listed folders');
    expect(block).toContain('belongs to nobody only when its path is under none of them');
    expect(block).not.toContain('if no agent has it, say so');
    // Et « Nodal-Video » sous la racine de Montage se rattache par ce que le
    // bloc donne : le chemin de la racine, lu par la même règle que le bloc dit.
    expect(montage).toContain('Montage = C:\\Users\\u\\Nodal\\Montage');
    expect(
      holdersOfPath('C:\\Users\\u\\Nodal\\Montage\\Nodal-Video', [
        { agent: w.name, folders: [{ label: 'Montage', path: 'C:\\Users\\u\\Nodal\\Montage' }] },
      ]),
    ).toEqual({ kind: 'held', agents: [w.name] });
  });

  // Revue Codex de #506, passe 2 (P1) : une borne avec « +N more » faisait
  // mentir la liste que la phrase de vérité dit COMPLÈTE — un agent à sept
  // dossiers était dit incapable pour le septième, et avec six dossiers
  // attachés son partagé disparaissait. Tout est montré.
  it('montre TOUS les dossiers et TOUS les programmes, partagé compris', async () => {
    const { entityId } = await seedContext(db);
    const t = Date.now();
    const orch = await seedAgent(db, entityId, `test-orch-all-${t}`, 'orchestrator');
    const w = await seedAgent(db, entityId, `test-many-${t}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);
    const folderCount = 7;
    await db.insert(agentWorkspaces).values(
      Array.from({ length: folderCount }, (_, i) => ({
        agentId: w.id,
        entityId,
        label: `f${String(i).padStart(2, '0')}`,
        path: `/data/f${i}`,
        position: i,
      })),
    );
    const programs = Array.from({ length: 13 }, (_, i) => `prog${i}`);
    await db.update(agents).set({ commandAllowlist: programs }).where(eq(agents.id, w.id));
    await db
      .insert(agentSkillAssignments)
      .values({ agentId: w.id, skillId: await seedCommandSkill(), entityId });

    const entry = entryOf(await buildTeamBlock(orch.id as AgentId, db), w.name);
    const shared = (await resolveRunWorkspaces(db, w.id, entityId)).sharedPath;

    expect(entry).toContain('f06 = /data/f6');
    expect(entry).toContain(`shared = ${shared}`);
    expect(entry).toContain(`only these programs: ${programs.join(', ')}`);
    expect(entry).not.toMatch(/\+\d+ more/);
  });

  it('dit si chaque agent peut lancer des commandes, selon son runtime et ses outils', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(db, entityId, `test-orch-sh-${Date.now()}`, 'orchestrator');
    const shellSkill = await seedCommandSkill();

    const nodalShell = await seedAgent(db, entityId, `test-nodal-shell-${Date.now()}`, 'agent');
    const nodalLimited = await seedAgent(db, entityId, `test-nodal-lim-${Date.now()}`, 'agent');
    const nodalNone = await seedAgent(db, entityId, `test-nodal-none-${Date.now()}`, 'agent');
    const nodalEmptyList = await seedAgent(db, entityId, `test-nodal-empty-${Date.now()}`, 'agent');
    const claudeCode = await seedAgent(db, entityId, `test-cc-${Date.now()}`, 'agent');
    const codex = await seedAgent(db, entityId, `test-codex-${Date.now()}`, 'agent');
    // Un sous-orchestrateur qui porte la skill : la branche orchestrateur de la
    // whitelist n'ajoute jamais les builtins requis par les skills, il n'a donc
    // PAS `run_command` (revue Codex de #506, P1).
    const subOrch = await seedAgent(db, entityId, `test-suborch-${Date.now()}`, 'orchestrator');

    for (const a of [
      nodalShell,
      nodalLimited,
      nodalNone,
      nodalEmptyList,
      claudeCode,
      codex,
      subOrch,
    ]) {
      await assignChild(db, orch.id, a.id, entityId);
    }
    // Le shell Nodal vient de la skill qui porte `run_command` ; un agent
    // au runtime Claude Code la porte AUSSI ici, et ça ne lui donne rien.
    for (const a of [nodalShell, nodalLimited, nodalEmptyList, claudeCode, subOrch]) {
      await db
        .insert(agentSkillAssignments)
        .values({ agentId: a.id, skillId: shellSkill, entityId });
    }
    await db
      .update(agents)
      .set({ commandAllowlist: ['node', 'npx vitest'] })
      .where(eq(agents.id, nodalLimited.id));
    await db.update(agents).set({ commandAllowlist: [] }).where(eq(agents.id, nodalEmptyList.id));
    await db
      .update(agents)
      .set({ runtime: 'claude-code', cliPermissions: { mode: 'write' } })
      .where(eq(agents.id, claudeCode.id));
    await db
      .update(agents)
      .set({ runtime: 'codex', cliPermissions: { mode: 'write' } })
      .where(eq(agents.id, codex.id));

    const block = await buildTeamBlock(orch.id as AgentId, db);

    expect(entryOf(block, nodalShell.name)).toContain('Runtime: nodal');
    expect(entryOf(block, nodalShell.name)).toContain('Shell commands: yes');
    expect(entryOf(block, nodalLimited.name)).toContain(
      'Shell commands: yes, only these programs: node, npx vitest',
    );
    expect(entryOf(block, nodalNone.name)).toContain('Shell commands: no');
    expect(entryOf(block, nodalEmptyList.name)).toContain('Shell commands: no');
    expect(entryOf(block, claudeCode.name)).toContain('Runtime: claude-code');
    expect(entryOf(block, claudeCode.name)).toContain('Shell commands: no');
    expect(entryOf(block, codex.name)).toContain('Runtime: codex');
    expect(entryOf(block, codex.name)).toContain('Shell commands: yes');
    expect(entryOf(block, subOrch.name)).toContain('Shell commands: no');
  });

  // #494 : un agent en runtime CLI a le shell que SON réglage lui donne, et le
  // frein d'urgence le lui retire. Le bloc le dit comme le runner le fera : le
  // routeur ne doit ni envoyer une commande à qui la refusera, ni écarter un
  // agent que son propriétaire a autorisé.
  it('CLI runtime: the shell announced is the one the agent row and the brake give its turn @cap:executer-une-commande/moteur', async () => {
    const { entityId } = await seedContext(db);
    const { entities } = await import('@nodal-agents/db');
    const orch = await seedAgent(db, entityId, `test-orch-cli-${Date.now()}`, 'orchestrator');
    const rows: [string, 'claude-code' | 'codex', Record<string, unknown> | null, string][] = [
      ['cc-default', 'claude-code', null, 'no'],
      ['cc-read-auto', 'claude-code', { mode: 'read', shell: 'auto' }, 'no'],
      ['cc-write', 'claude-code', { mode: 'write' }, 'no'],
      ['cc-write-auto', 'claude-code', { mode: 'write', shell: 'auto' }, 'yes'],
      [
        'cc-auto-banned',
        'claude-code',
        { mode: 'write', shell: 'auto', extraDisallowed: ['Bash', 'PowerShell'] },
        'no',
      ],
      ['codex-read', 'codex', { mode: 'read' }, 'yes'],
    ];
    const byLabel = new Map<string, { name: string; expected: string }>();
    for (const [label, runtime, cliPermissions, expected] of rows) {
      const a = await seedAgent(db, entityId, `test-${label}-${Date.now()}`, 'agent');
      await assignChild(db, orch.id, a.id, entityId);
      await db
        .update(agents)
        .set({ runtime, cliPermissions: cliPermissions as never })
        .where(eq(agents.id, a.id));
      byLabel.set(label, { name: a.name, expected });
    }

    const block = await buildTeamBlock(orch.id as AgentId, db);
    for (const [label, { name, expected }] of byLabel) {
      expect(entryOf(block, name), label).toContain(`Shell commands: ${expected}`);
    }

    // Frein serré : aucun tour CLI n'a de shell (Claude le perd, Codex ne part pas).
    await db.update(entities).set({ autoRunPaused: true }).where(eq(entities.id, entityId));
    try {
      const braked = await buildTeamBlock(orch.id as AgentId, db);
      for (const [label, { name }] of byLabel) {
        expect(entryOf(braked, name), `${label} under the brake`).toContain('Shell commands: no');
      }
    } finally {
      await db.update(entities).set({ autoRunPaused: false }).where(eq(entities.id, entityId));
    }
  });
});

// #473 — « Reviewer A n'existe pas dans ce workspace » : faux, il était dans
// l'équipe de Lead. Le bloc nomme donc les agents de l'espace HORS de
// l'équipe, qui les tient, et par qui on les atteint.
describe('buildTeamBlock — les agents de l’espace hors de l’équipe (#473) @cap:organiser-equipe/moteur', () => {
  it('nomme chaque agent hors équipe, son orchestrateur, et le chemin qui l’atteint', async () => {
    const { entityId } = await seedContext(db);
    const t = Date.now();
    const root = await seedAgent(db, entityId, `test-root-473-${t}`, 'orchestrator');
    const lead = await seedAgent(db, entityId, `test-lead-473-${t}`, 'orchestrator');
    const revA = await seedAgent(db, entityId, `test-rev-a-473-${t}`, 'agent');
    const revC = await seedAgent(db, entityId, `test-rev-c-473-${t}`, 'agent');
    const loner = await seedAgent(db, entityId, `test-loner-473-${t}`, 'agent');
    await assignChild(db, root.id, lead.id, entityId);
    await assignChild(db, root.id, revC.id, entityId);
    await assignChild(db, lead.id, revA.id, entityId);
    await assignChild(db, lead.id, revC.id, entityId);

    const block = await buildTeamBlock(root.id as AgentId, db);

    expect(block).toContain('outside your team');
    const outside = block.slice(block.indexOf('outside your team'));
    const lineOf = (name: string): string =>
      outside.split('\n').find((l) => l.includes(`**${name}**`)) ?? '';
    // Reviewer A existe, chez Lead, et Lead est dans l'équipe : on passe par lui.
    expect(lineOf(revA.name)).toContain(`on the team of ${lead.name}`);
    expect(lineOf(revA.name)).toContain(`through **${lead.name}**`);
    // Un agent d'aucune équipe existe aussi, et personne ne peut lui confier de travail.
    expect(lineOf(loner.name)).toContain('on no team');
    // Les membres de l'équipe et l'agent lui-même n'y sont pas.
    expect(outside).not.toContain(`**${revC.name}**`);
    expect(outside).not.toContain(`**${root.name}**`);
  });
});

// Revue Codex de #473, P1-a : le bloc sortait à vide pour un agent sans
// enfant, AVANT de nommer le reste de l'espace. Un root ou un agent isolé
// pouvait donc encore dire « Reviewer A n'existe pas ». P1-b : la clause
// « passe par Lead » était servie aussi aux surfaces sans outil de délégation.
describe('buildTeamBlock — le reste de l’espace, dit à tout agent selon ses moyens (#473, revue Codex)', () => {
  async function seedOrg() {
    const { entityId } = await seedContext(db);
    const t = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const alone = await seedAgent(db, entityId, `test-alone-${t}`, 'orchestrator');
    const root = await seedAgent(db, entityId, `test-root-${t}`, 'orchestrator');
    const lead = await seedAgent(db, entityId, `test-lead-${t}`, 'orchestrator');
    const revA = await seedAgent(db, entityId, `test-reva-${t}`, 'agent');
    await assignChild(db, root.id, lead.id, entityId);
    await assignChild(db, lead.id, revA.id, entityId);
    return { alone, root, lead, revA };
  }
  const lineOf = (block: string, name: string): string =>
    block.split('\n').find((l) => l.includes(`**${name}**`)) ?? '';

  it('names the workspace to an agent with NO team, and never says it can delegate', async () => {
    const { alone, lead, revA } = await seedOrg();
    const block = await buildTeamBlock(alone.id as AgentId, db);
    expect(lineOf(block, revA.name)).toContain(`on the team of ${lead.name}`);
    expect(block).not.toContain('reach it through');
    expect(block).not.toContain('## Your team');
  });

  it('offers the route through a teammate only where the agent has a way to use it', async () => {
    const { root, lead, revA } = await seedOrg();
    // Job surface: assign_* exists, so the route is an instruction.
    const job = await buildTeamBlock(root.id as AgentId, db);
    expect(lineOf(job, revA.name)).toContain(`reach it through **${lead.name}**`);
    // CLI session: no delegation tool at all — the fact, never the route.
    const cli = await buildTeamBlock(root.id as AgentId, db, { delegation: false });
    expect(lineOf(cli, revA.name)).toContain(`on the team of ${lead.name}`);
    expect(lineOf(cli, revA.name)).not.toContain('reach it through');
    // Nor the footer: a CLI session is never told to delegate (#473, pass 4).
    expect(cli).not.toContain('delegate to it');
    expect(cli).toContain('names the agent');
    // Chat: the job started with run_task delegates, so the route is the job's.
    const chat = await buildTeamBlock(root.id as AgentId, db, {
      delegation: false,
      escalation: true,
    });
    expect(lineOf(chat, revA.name)).toContain(
      `the job you start with \`run_task\` can reach it through **${lead.name}**`,
    );
  });
});

// Revue Codex de #473, passe 2 (P1) : la portée annoncée ignorait la
// profondeur de délégation (invariant #8). Root → Lead → Manager → Reviewer →
// Worker : le prompt disait d'atteindre Worker par Lead, et le 4e assign_*
// était refusé. La portée tient compte de la profondeur RESTANTE du job.
describe('buildTeamBlock — la portée annoncée tient dans la profondeur restante (#473, revue Codex passe 2)', () => {
  async function seedChain() {
    const { entityId } = await seedContext(db);
    const t = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const root = await seedAgent(db, entityId, `test-root-d-${t}`, 'orchestrator');
    const lead = await seedAgent(db, entityId, `test-lead-d-${t}`, 'orchestrator');
    const manager = await seedAgent(db, entityId, `test-mgr-d-${t}`, 'orchestrator');
    const reviewer = await seedAgent(db, entityId, `test-rev-d-${t}`, 'orchestrator');
    const worker = await seedAgent(db, entityId, `test-wkr-d-${t}`, 'agent');
    await assignChild(db, root.id, lead.id, entityId);
    await assignChild(db, lead.id, manager.id, entityId);
    await assignChild(db, manager.id, reviewer.id, entityId);
    await assignChild(db, reviewer.id, worker.id, entityId);
    return { root, lead, manager, reviewer, worker };
  }
  const lineOf = (block: string, name: string): string =>
    block.split('\n').find((l) => l.includes(`**${name}**`)) ?? '';

  it('at depth 0, reaches up to the depth limit and says the rest is beyond it', async () => {
    const { root, lead, manager, reviewer, worker } = await seedChain();
    const block = await buildTeamBlock(root.id as AgentId, db, { delegationDepth: 0 });
    expect(lineOf(block, manager.name)).toContain(`reach it through **${lead.name}**`);
    expect(lineOf(block, reviewer.name)).toContain(`reach it through **${lead.name}**`);
    // 4 hops: beyond maxDelegationDepth (3).
    expect(lineOf(block, worker.name)).not.toContain('reach it through');
    expect(lineOf(block, worker.name)).toContain('beyond the delegation depth this job has left');
  });

  it('a job at depth 2 does not announce an agent two hops away', async () => {
    const { root, manager } = await seedChain();
    const block = await buildTeamBlock(root.id as AgentId, db, { delegationDepth: 2 });
    expect(lineOf(block, manager.name)).not.toContain('reach it through');
    expect(lineOf(block, manager.name)).toContain('beyond the delegation depth this job has left');
  });
});

// Revue Codex de #473, passe 3 : à la profondeur maximale, le bloc annonçait
// encore « TWO ways to delegate » et un outil assign_* par enfant.
describe('buildTeamBlock — à la profondeur maximale, aucune délégation annoncée (#473)', () => {
  it('liste l’équipe comme des faits, sans outil ni mode d’emploi, et dit pourquoi', async () => {
    const { entityId } = await seedContext(db);
    const t = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reviewer = await seedAgent(db, entityId, `test-rev-max-${t}`, 'orchestrator');
    const worker = await seedAgent(db, entityId, `test-wkr-max-${t}`, 'agent');
    await assignChild(db, reviewer.id, worker.id, entityId);

    const block = await buildTeamBlock(reviewer.id as AgentId, db, { delegationDepth: 3 });

    expect(block).toContain(`**${worker.name}**`);
    expect(block).toContain('maximum delegation depth');
    expect(block).not.toContain('ways to delegate');
    expect(block).not.toMatch(/assign_[a-z0-9_]+/);
    expect(block).not.toContain('`create_task`');
  });
});
