// space.test.ts — l'espace du banc, joué sur un vrai schéma (PGlite).
//
// Ce que ces cas prouvent, sur les LIGNES écrites et lues, jamais sur des
// appels : la copie reproduit l'équipe (prompts, skills et donc listes
// d'outils, délégation, racine, règles) ; elle ne reproduit AUCUN canal,
// connecteur, serveur MCP, dossier du propriétaire ni souvenir ; le secret
// d'une clé voyage chiffré et ne s'imprime pas ; les lignes du propriétaire
// ne bougent pas d'un octet ; deux synchronisations n'en font qu'une ; la
// mémoire de l'espace se vide sans toucher à celle du propriétaire ; et le
// réglage du modèle d'une série ne vise que les copies, puis se défait.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import type { ToolContext } from '@nodal-agents/tools';
import { assertSpaceCannotSend, checkScope, checkSpaceCannotSend, renderCheck } from '../guard';
import { applySpaceModel } from '../model';
import { resetSpaceMemory } from '../reset';
import {
  BENCH_SPACE_SLUG,
  copyIdFor,
  jobOffTarget,
  readJobPlacement,
  resolveBenchTarget,
  spaceIdFor,
} from '../space';
import {
  AGENT_POLICY,
  APPROVAL_RULE_POLICY,
  DELEGATION_POLICY,
  ENTITY_POLICY,
  ENTITY_SETTING_POLICY,
  LLM_KEY_POLICY,
  SKILL_ASSIGNMENT_POLICY,
  SKILL_POLICY,
  applySync,
  planSync,
  renderPlan,
} from '../sync';

const CIPHERTEXT = 'enc:v1:FAKE-CIPHERTEXT-NEVER-PRINTED';
const LAST4 = 'Zq9x';

type Pg = Awaited<ReturnType<typeof spinUpTestDb>>['pg'];
let pg: Pg;
let db: AnyDrizzleDb;
let root: string;
let team: Awaited<ReturnType<typeof seedTeam>>;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** L'équipe d'un propriétaire, avec tout ce qui ne doit PAS passer dans la copie. */
async function seedTeam(t: AnyDrizzleDb, p: Pg, wsRoot: string) {
  const [user] = await t.insert(d.users).values({ email: 'owner@example.com' }).returning();
  const [ent] = await t
    .insert(d.entities)
    .values({
      userId: user!.id,
      name: 'Owner HQ',
      slug: 'owner-hq',
      goal: 'ship things',
      reflectionEnabled: true,
      maxRunCostUsd: 0,
      rootGrants: DEFAULT_ROOT_GRANTS,
    })
    .returning();
  const entityId = ent!.id;
  await t.insert(d.entityMembers).values({ entityId, userId: user!.id, role: 'owner' });

  const [keyMain, keyFallback, keyUnused] = await t
    .insert(d.entityLlmKeys)
    .values([
      {
        entityId,
        provider: 'openrouter',
        apiKey: CIPHERTEXT,
        apiKeyLast4: LAST4,
        nickname: 'Main',
      },
      {
        entityId,
        provider: 'anthropic',
        apiKey: 'enc:v1:OTHER',
        apiKeyLast4: 'abcd',
        nickname: 'Backup',
      },
      {
        entityId,
        provider: 'openai',
        apiKey: 'enc:v1:UNUSED',
        apiKeyLast4: 'efgh',
        nickname: 'Unused',
      },
    ])
    .returning();

  const [rootAgent, worker, coder] = await t
    .insert(d.agents)
    .values([
      {
        entityId,
        name: 'Alfred',
        slug: 'alfred',
        personality: 'You orchestrate the team.',
        model: 'z-ai/glm-5.3',
        llmKeyId: keyMain!.id,
        role: 'orchestrator',
        orchestratorMode: 'router',
        telegramBotToken: 'enc:v1:TELEGRAM-TOKEN',
        telegramBotUsername: 'alfred_bot',
        telegramOffset: 42,
        lastSeenChatIdTelegram: '12345',
        mayChangeTeam: true,
      },
      {
        entityId,
        name: 'Writer',
        slug: 'writer',
        personality: 'You write.',
        model: 'z-ai/glm-5.3',
        llmKeyId: keyMain!.id,
        fallbackChain: [{ keyId: keyFallback!.id, model: 'claude-sonnet-5-5' }],
        commandAllowlist: ['node'],
      },
      {
        entityId,
        name: 'Coder',
        slug: 'coder',
        personality: 'You code.',
        runtime: 'claude-code',
        llmKeyId: keyMain!.id,
      },
    ])
    .returning();
  await t
    .update(d.entities)
    .set({ rootAgentId: rootAgent!.id })
    .where(d.eq(d.entities.id, entityId));

  // Une skill système vit dans l'espace le plus ancien (seed-default-skills).
  const [systemSkill, houseStyle] = await t
    .insert(d.agentSkills)
    .values([
      {
        entityId,
        name: 'Dev',
        slug: 'dev',
        content: 'system dev skill',
        createdBy: 'system',
        requiredBuiltins: ['run_command'],
      },
      {
        entityId,
        name: 'House style',
        slug: 'house-style',
        content: 'Write like us.',
        requiredBuiltins: ['file_write'],
        createdByAgentId: worker!.id,
      },
    ])
    .returning();
  await t.insert(d.agentSkillAssignments).values([
    { entityId, agentId: worker!.id, skillId: houseStyle!.id, filesWritable: true },
    { entityId, agentId: worker!.id, skillId: systemSkill!.id, scriptsAuthorized: true },
  ]);
  await t.insert(d.agentAssignments).values([
    { entityId, orchestratorId: rootAgent!.id, subAgentId: worker!.id, instructions: 'drafts' },
    { entityId, orchestratorId: rootAgent!.id, subAgentId: coder!.id },
  ]);
  await t.insert(d.approvalRules).values([
    { entityId, agentId: worker!.id, toolName: 'run_command', action: 'auto_approve' },
    { entityId, agentId: null, toolName: 'send_email', action: 'block' },
  ]);
  await t.insert(d.entitySettings).values([
    { entityId, key: d.INSTALL_NOTES_KEY, value: 'Projects live in D:/work.' },
    { entityId, key: 'some_other_setting', value: 'private' },
  ]);
  await t.insert(d.agentMemory).values({ entityId, agentId: worker!.id, fact: 'owner likes tea' });

  // Ce qui parle au monde, ou vit dans les dossiers du propriétaire.
  await p.query(
    `insert into channel_bindings (entity_id, agent_id, channel, credentials) values ($1, $2, 'discord', 'enc:v1:DISCORD')`,
    [entityId, rootAgent!.id],
  );
  const [conn] = await t
    .insert(d.connectors)
    .values({ entityId, name: 'Gmail', slug: 'gmail', apiKey: 'enc:v1:GMAIL' })
    .returning();
  await t
    .insert(d.agentConnectorAssignments)
    .values({ agentId: worker!.id, connectorId: conn!.id, entityId });
  const mcp = await p.query<{ id: string }>(
    `insert into mcp_servers (entity_id, name, slug, transport, url) values ($1, 'Printer', 'printer', 'http', 'http://x') returning id::text`,
    [entityId],
  );
  await t
    .insert(d.agentMcpServers)
    .values({ agentId: worker!.id, mcpServerId: mcp.rows[0]!.id, entityId });
  await t
    .insert(d.agentWorkspaces)
    .values({ agentId: coder!.id, entityId, label: 'repo', path: 'D:/work/repo' });
  await p.query(
    `insert into agent_schedules (entity_id, agent_id, name, cron_expr) values ($1, $2, 'nightly', '0 3 * * *')`,
    [entityId, rootAgent!.id],
  );

  // Les fichiers de la skill copiée.
  const skillDir = join(wsRoot, entityId, 'skills', 'house-style');
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# House style\n');
  writeFileSync(join(skillDir, 'scripts', 'check.js'), 'console.log(1)\n');
  const devDir = join(wsRoot, entityId, 'skills', 'dev');
  mkdirSync(devDir, { recursive: true });
  writeFileSync(join(devDir, 'notes.md'), 'dev notes of the team\n');

  return {
    userId: user!.id,
    entityId,
    rootAgent: rootAgent!,
    worker: worker!,
    coder: coder!,
    keyMain: keyMain!,
    keyFallback: keyFallback!,
    keyUnused: keyUnused!,
    systemSkill: systemSkill!,
    houseStyle: houseStyle!,
  };
}

/** Toutes les lignes du propriétaire, pour prouver qu'elles ne bougent pas. */
async function ownerSnapshot(t: AnyDrizzleDb, entityId: string): Promise<string> {
  const rows = await Promise.all([
    t.select().from(d.entities).where(d.eq(d.entities.id, entityId)),
    t.select().from(d.agents).where(d.eq(d.agents.entityId, entityId)),
    t.select().from(d.agentSkills).where(d.eq(d.agentSkills.entityId, entityId)),
    t
      .select()
      .from(d.agentSkillAssignments)
      .where(d.eq(d.agentSkillAssignments.entityId, entityId)),
    t.select().from(d.agentAssignments).where(d.eq(d.agentAssignments.entityId, entityId)),
    t.select().from(d.approvalRules).where(d.eq(d.approvalRules.entityId, entityId)),
    t.select().from(d.entityLlmKeys).where(d.eq(d.entityLlmKeys.entityId, entityId)),
    t.select().from(d.entitySettings).where(d.eq(d.entitySettings.entityId, entityId)),
    t.select().from(d.agentMemory).where(d.eq(d.agentMemory.entityId, entityId)),
    t.select().from(d.entityMembers),
  ]);
  return JSON.stringify(rows);
}

async function sync(opts: { maxRunCostUsd?: number } = {}) {
  const r = await planSync(db, { workspacesRoot: root, ...opts });
  await applySync(db, r.plan, r.desired);
  return r.plan;
}

beforeEach(async () => {
  const t = await spinUpTestDb();
  pg = t.pg;
  db = t.db as unknown as AnyDrizzleDb;
  root = mkdtempSync(join(tmpdir(), 'bench-space-'));
  roots.push(root);
  team = await seedTeam(db, pg, root);
});

describe('chaque colonne des tables copiées est classée', () => {
  it.each([
    ['entities', d.entities, ENTITY_POLICY],
    ['agents', d.agents, AGENT_POLICY],
    ['agent_skills', d.agentSkills, SKILL_POLICY],
    ['agent_skill_assignments', d.agentSkillAssignments, SKILL_ASSIGNMENT_POLICY],
    ['agent_assignments', d.agentAssignments, DELEGATION_POLICY],
    ['approval_rules', d.approvalRules, APPROVAL_RULE_POLICY],
    ['entity_llm_keys', d.entityLlmKeys, LLM_KEY_POLICY],
    ['entity_settings', d.entitySettings, ENTITY_SETTING_POLICY],
  ] as const)('%s', (_name, table, policy) => {
    // Une colonne ajoutée au schéma sans politique (un nouveau jeton…) fait
    // rougir ce cas au lieu d'être copiée en silence.
    expect(Object.keys(policy).sort()).toEqual(Object.keys(d.getTableColumns(table)).sort());
  });
});

describe('sync — le plan, sans rien écrire', () => {
  it('ne crée rien, ne touche à rien, et nomme tout ce qui ne passe pas', async () => {
    const before = await ownerSnapshot(db, team.entityId);
    const { plan } = await planSync(db, { workspacesRoot: root });

    expect(await ownerSnapshot(db, team.entityId)).toBe(before);
    const [space] = await db
      .select()
      .from(d.entities)
      .where(d.eq(d.entities.slug, BENCH_SPACE_SLUG));
    expect(space).toBeUndefined();
    expect(existsSync(join(root, spaceIdFor(team.entityId)))).toBe(false);

    expect(plan.space).toEqual({ id: spaceIdFor(team.entityId), exists: false });
    const created = plan.changes
      .filter((c) => c.kind === 'create')
      .map((c) => `${c.table}: ${c.label}`);
    expect(created.sort()).toEqual(
      [
        'entities: Bench space',
        'agents: alfred',
        'agents: writer',
        'agents: coder',
        'agent_skills: house-style',
        'agent_skill_assignments: writer → house-style',
        'agent_skill_assignments: writer → dev',
        'agent_assignments: alfred → writer',
        'agent_assignments: alfred → coder',
        'approval_rules: writer: run_command auto_approve',
        'approval_rules: workspace: send_email block',
        'entity_llm_keys: openrouter key "Main"',
        'entity_llm_keys: anthropic key "Backup"',
        `entity_settings: ${d.INSTALL_NOTES_KEY}`,
      ].sort(),
    );
    expect(plan.changes.every((c) => c.kind === 'create')).toBe(true);
    expect(plan.files).toEqual([
      { skillSlug: 'dev', kind: 'create', files: 1 },
      { skillSlug: 'house-style', kind: 'create', files: 2 },
    ]);
    expect(plan.referencedSystemSkills).toEqual(['dev']);
    expect(plan.notCopied.sort()).toEqual(
      [
        'Telegram bot token of agent alfred',
        'discord channel binding',
        'connector gmail of agent writer',
        'MCP server printer of agent writer',
        `working folder "repo" of agent coder (the owner's own directory)`,
        '1 schedule(s)',
        'workspace setting some_other_setting',
        'memory (the space has its own, emptied by `pnpm bench:space reset`)',
      ].sort(),
    );
  });

  it("n'imprime aucun secret : ni le chiffré d'une clé, ni ses derniers caractères, ni un jeton", async () => {
    const { plan } = await planSync(db, { workspacesRoot: root });
    const text = renderPlan(plan);
    for (const secret of [
      CIPHERTEXT,
      LAST4,
      'enc:v1:OTHER',
      'TELEGRAM-TOKEN',
      'DISCORD',
      'GMAIL',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('LLM keys are copied as ciphertext, never decrypted and never printed.');
  });

  it('refuse un plafond de coût nul : un espace sans plafond est ce que le réglage empêche', async () => {
    await expect(planSync(db, { workspacesRoot: root, maxRunCostUsd: 0 })).rejects.toThrow(
      /bench_space_cost_cap/,
    );
  });
});

describe("sync --apply — l'espace", () => {
  it("copie l'équipe, coupe la réflexion, plafonne le coût, et n'a aucun membre", async () => {
    const before = await ownerSnapshot(db, team.entityId);
    await sync({ maxRunCostUsd: 1.5 });
    expect(await ownerSnapshot(db, team.entityId), 'owner rows changed').toBe(before);

    const spaceId = spaceIdFor(team.entityId);
    const cp = (table: string, id: string) => copyIdFor(spaceId, table, id);
    const [space] = await db.select().from(d.entities).where(d.eq(d.entities.id, spaceId));
    expect(space).toMatchObject({
      slug: BENCH_SPACE_SLUG,
      userId: team.userId,
      goal: 'ship things',
      rootAgentId: cp('agents', team.rootAgent.id),
      rootGrants: {
        ...DEFAULT_ROOT_GRANTS,
        createConnector: false,
        attachConnector: false,
        createMcp: false,
        attachMcp: false,
      },
      reflectionEnabled: false,
      maxRunCostUsd: 1.5,
      mcpServerEnabled: true,
    });
    const members = await db
      .select()
      .from(d.entityMembers)
      .where(d.eq(d.entityMembers.entityId, spaceId));
    expect(members).toEqual([]);

    // Le serveur MCP, la clé semée depuis l'environnement et le tableau de
    // bord voient toujours l'espace du propriétaire, et lui seul.
    const ws = await d.listMemberWorkspaces(db, { withRootAgent: true });
    expect(ws.map((w) => w.id)).toEqual([team.entityId]);

    const copies = await db.select().from(d.agents).where(d.eq(d.agents.entityId, spaceId));
    const bySlug = new Map(copies.map((a) => [a.slug, a]));
    const alfred = bySlug.get('alfred')!;
    expect(alfred).toMatchObject({
      id: cp('agents', team.rootAgent.id),
      personality: 'You orchestrate the team.',
      model: 'z-ai/glm-5.3',
      role: 'orchestrator',
      orchestratorMode: 'router',
      mayChangeTeam: true,
      llmKeyId: cp('entity_llm_keys', team.keyMain.id),
      telegramBotToken: null,
      telegramBotUsername: null,
      telegramOffset: null,
      lastSeenChatIdTelegram: null,
    });
    expect(bySlug.get('writer')).toMatchObject({
      fallbackChain: [
        { keyId: cp('entity_llm_keys', team.keyFallback.id), model: 'claude-sonnet-5-5' },
      ],
      commandAllowlist: ['node'],
    });
    expect(bySlug.get('coder')!.runtime).toBe('claude-code');

    // Le chiffré voyage tel quel ; la clé inutilisée ne voyage pas.
    const keys = await db
      .select()
      .from(d.entityLlmKeys)
      .where(d.eq(d.entityLlmKeys.entityId, spaceId));
    expect(keys.map((k) => [k.provider, k.apiKey, k.apiKeyLast4]).sort()).toEqual(
      [
        ['anthropic', 'enc:v1:OTHER', 'abcd'],
        ['openrouter', CIPHERTEXT, LAST4],
      ].sort(),
    );

    // La liste d'outils se calcule depuis les attributions de skills : les
    // mêmes builtins, les mêmes drapeaux, pour l'original et sa copie.
    const toolInputs = async (agentId: string) =>
      (
        await db
          .select({
            slug: d.agentSkills.slug,
            requiredBuiltins: d.agentSkills.requiredBuiltins,
            scripts: d.agentSkillAssignments.scriptsAuthorized,
            files: d.agentSkillAssignments.filesWritable,
          })
          .from(d.agentSkillAssignments)
          .innerJoin(d.agentSkills, d.eq(d.agentSkills.id, d.agentSkillAssignments.skillId))
          .where(d.eq(d.agentSkillAssignments.agentId, agentId))
      ).sort((a, b) => a.slug.localeCompare(b.slug));
    expect(await toolInputs(cp('agents', team.worker.id))).toEqual(
      await toolInputs(team.worker.id),
    );
    expect(await toolInputs(team.worker.id)).toHaveLength(2);

    // La skill système est référencée (une par installation), la skill du
    // propriétaire est copiée avec son auteur réécrit.
    const assigned = await db
      .select({ skillId: d.agentSkillAssignments.skillId })
      .from(d.agentSkillAssignments)
      .where(d.eq(d.agentSkillAssignments.agentId, cp('agents', team.worker.id)));
    expect(assigned.map((a) => a.skillId).sort()).toEqual(
      [team.systemSkill.id, cp('agent_skills', team.houseStyle.id)].sort(),
    );
    const [skillCopy] = await db
      .select()
      .from(d.agentSkills)
      .where(d.eq(d.agentSkills.id, cp('agent_skills', team.houseStyle.id)));
    expect(skillCopy).toMatchObject({
      entityId: spaceId,
      content: 'Write like us.',
      createdByAgentId: cp('agents', team.worker.id),
    });
    expect(
      readFileSync(join(root, spaceId, 'skills', 'house-style', 'scripts', 'check.js'), 'utf8'),
    ).toBe('console.log(1)\n');

    const links = await db
      .select({
        o: d.agentAssignments.orchestratorId,
        s: d.agentAssignments.subAgentId,
        i: d.agentAssignments.instructions,
      })
      .from(d.agentAssignments)
      .where(d.eq(d.agentAssignments.entityId, spaceId));
    expect(links).toContainEqual({ o: alfred.id, s: cp('agents', team.worker.id), i: 'drafts' });
    expect(links).toHaveLength(2);

    const rules = await db
      .select()
      .from(d.approvalRules)
      .where(d.eq(d.approvalRules.entityId, spaceId));
    expect(rules.map((r) => [r.agentId, r.toolName, r.action]).sort()).toEqual(
      [
        [cp('agents', team.worker.id), 'run_command', 'auto_approve'],
        [null, 'send_email', 'block'],
      ].sort(),
    );

    const settings = await db
      .select()
      .from(d.entitySettings)
      .where(d.eq(d.entitySettings.entityId, spaceId));
    expect(settings.map((s) => [s.key, s.value])).toEqual([
      [d.INSTALL_NOTES_KEY, 'Projects live in D:/work.'],
    ]);

    // Rien de ce qui parle au monde, rien des dossiers ni de la mémoire du propriétaire.
    for (const [table, n] of [
      ['channel_bindings', 0],
      ['connectors', 0],
      ['agent_connector_assignments', 0],
      ['mcp_servers', 0],
      ['agent_mcp_servers', 0],
      ['agent_workspaces', 0],
      ['agent_schedules', 0],
      ['agent_memory', 0],
    ] as const) {
      const r = await pg.query<{ n: number }>(
        `select count(*)::int as n from ${table} where entity_id = $1`,
        [spaceId],
      );
      expect(r.rows[0]!.n, table).toBe(n);
    }
  });

  it("deux synchronisations n'en font qu'une : le second plan est vide et rien ne change", async () => {
    await sync();
    const spaceId = spaceIdFor(team.entityId);
    const snap = () =>
      Promise.all([
        db.select().from(d.agents).where(d.eq(d.agents.entityId, spaceId)),
        db.select().from(d.agentSkills).where(d.eq(d.agentSkills.entityId, spaceId)),
        db
          .select()
          .from(d.agentSkillAssignments)
          .where(d.eq(d.agentSkillAssignments.entityId, spaceId)),
        db.select().from(d.entityLlmKeys).where(d.eq(d.entityLlmKeys.entityId, spaceId)),
      ]).then((rows) => JSON.stringify(rows.map((t) => t.map((r) => ({ ...r, updatedAt: null })))));
    const first = await snap();

    const { plan, desired } = await planSync(db, { workspacesRoot: root });
    expect(plan.space.exists).toBe(true);
    expect(plan.changes).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(renderPlan(plan)).toContain('Nothing to change');
    await applySync(db, plan, desired);
    expect(await snap()).toBe(first);
  });

  it('reporte les changements du propriétaire : modifié, retiré, ajouté', async () => {
    await sync();
    await db
      .update(d.agents)
      .set({ personality: 'You write, briefly.' })
      .where(d.eq(d.agents.id, team.worker.id));
    await db.delete(d.agents).where(d.eq(d.agents.id, team.coder.id));
    await db.insert(d.agents).values({
      entityId: team.entityId,
      name: 'Critic',
      slug: 'critic',
      personality: 'You judge.',
    });
    writeFileSync(
      join(root, team.entityId, 'skills', 'house-style', 'SKILL.md'),
      '# House style v2\n',
    );

    const { plan, desired } = await planSync(db, { workspacesRoot: root });
    const summary = plan.changes.map(
      (c) => `${c.kind} ${c.table}: ${c.label}${c.columns ? ` [${c.columns.join(',')}]` : ''}`,
    );
    expect(summary).toContain('update agents: writer [personality]');
    expect(summary).toContain('delete agents: coder');
    expect(summary).toContain('create agents: critic');
    expect(summary).toContain('delete agent_assignments: alfred → coder');
    expect(plan.files).toEqual([{ skillSlug: 'house-style', kind: 'update', files: 2 }]);

    await applySync(db, plan, desired);
    const spaceId = spaceIdFor(team.entityId);
    const slugs = (
      await db
        .select({ slug: d.agents.slug })
        .from(d.agents)
        .where(d.eq(d.agents.entityId, spaceId))
    )
      .map((a) => a.slug)
      .sort();
    expect(slugs).toEqual(['alfred', 'critic', 'writer']);
    expect(readFileSync(join(root, spaceId, 'skills', 'house-style', 'SKILL.md'), 'utf8')).toBe(
      '# House style v2\n',
    );
  });

  it("refuse d'écrire dans un espace qui porte le nom du banc sans venir de cette équipe", async () => {
    await db
      .insert(d.entities)
      .values({ userId: team.userId, name: 'Impostor', slug: BENCH_SPACE_SLUG });
    await expect(planSync(db, { workspacesRoot: root })).rejects.toThrow(/bench_space_foreign/);
  });

  it("refuse de synchroniser pendant qu'un job de l'espace tourne", async () => {
    await sync();
    const spaceId = spaceIdFor(team.entityId);
    await db.insert(d.agentJobs).values({
      entityId: spaceId,
      agentId: copyIdFor(spaceId, 'agents', team.rootAgent.id),
      channel: 'mcp',
      task: 'trial',
    });
    await expect(planSync(db, { workspacesRoot: root })).rejects.toThrow(/bench_space_busy/);
    await expect(resetSpaceMemory(db, { apply: true })).rejects.toThrow(/bench_space_busy/);
  });
});

describe("reset — la mémoire de l'espace, et elle seule", () => {
  it("compte sans effacer, puis efface l'espace sans toucher au propriétaire", async () => {
    await sync();
    const spaceId = spaceIdFor(team.entityId);
    const writer = copyIdFor(spaceId, 'agents', team.worker.id);
    await db.insert(d.agentMemory).values([
      { entityId: spaceId, agentId: writer, fact: 'trial 1 learned x' },
      { entityId: null, agentId: writer, fact: 'trial 1 learned y' },
    ]);

    expect(await resetSpaceMemory(db, { apply: false })).toEqual({
      spaceId,
      memories: 2,
      deleted: false,
    });
    expect(await resetSpaceMemory(db, { apply: true })).toEqual({
      spaceId,
      memories: 2,
      deleted: true,
    });
    expect(await resetSpaceMemory(db, { apply: false })).toEqual({
      spaceId,
      memories: 0,
      deleted: false,
    });

    const owner = await db.select({ fact: d.agentMemory.fact }).from(d.agentMemory);
    expect(owner).toEqual([{ fact: 'owner likes tea' }]);
  });

  it('refuse sans espace du banc, en disant comment le créer', async () => {
    await expect(resetSpaceMemory(db, { apply: true })).rejects.toThrow(
      /bench_space_missing: .*bench:space sync --apply/,
    );
  });
});

describe('applySpaceModel — le modèle des copies pour une série, puis restauré', () => {
  it('règle les copies nodal, nomme les autres, ne touche pas au propriétaire, et se défait', async () => {
    await sync();
    const spaceId = spaceIdFor(team.entityId);
    const before = await ownerSnapshot(db, team.entityId);
    const snapCopies = () =>
      db
        .select({
          slug: d.agents.slug,
          model: d.agents.model,
          llmKeyId: d.agents.llmKeyId,
          fallbackChain: d.agents.fallbackChain,
        })
        .from(d.agents)
        .where(d.eq(d.agents.entityId, spaceId))
        .orderBy(d.agents.slug);
    const original = await snapCopies();

    const applied = await applySpaceModel(db, { provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(applied.changed.sort()).toEqual(['alfred', 'writer']);
    expect(applied.untouched).toEqual([
      { slug: 'coder', reason: "runtime claude-code does not use the agent's model" },
    ]);
    const during = await snapCopies();
    const backupKey = copyIdFor(spaceId, 'entity_llm_keys', team.keyFallback.id);
    expect(during.filter((a) => a.slug !== 'coder')).toEqual([
      { slug: 'alfred', model: 'claude-opus-5-5', llmKeyId: backupKey, fallbackChain: [] },
      { slug: 'writer', model: 'claude-opus-5-5', llmKeyId: backupKey, fallbackChain: [] },
    ]);
    expect(during.find((a) => a.slug === 'coder')).toEqual(
      original.find((a) => a.slug === 'coder'),
    );
    expect(await ownerSnapshot(db, team.entityId)).toBe(before);

    await applied.restore();
    expect(await snapCopies()).toEqual(original);
  });

  it("refuse un fournisseur sans clé dans l'espace, et un fournisseur à deux clés", async () => {
    await sync();
    await expect(applySpaceModel(db, { provider: 'openai', model: 'gpt-x' })).rejects.toThrow(
      /bench_space_model_key: the bench space has 0 active openai key/,
    );
    const spaceId = spaceIdFor(team.entityId);
    await db
      .insert(d.entityLlmKeys)
      .values({ entityId: spaceId, provider: 'anthropic', nickname: 'Second' });
    await expect(
      applySpaceModel(db, { provider: 'anthropic', model: 'claude-opus-5-5' }),
    ).rejects.toThrow(/has 2 active anthropic key\(s\) \(Backup, Second\)/);
  });

  it('refuse sans espace du banc : jamais les agents du propriétaire', async () => {
    await expect(applySpaceModel(db, { provider: 'openrouter', model: 'x' })).rejects.toThrow(
      /bench_space_missing/,
    );
    const owner = await db
      .select({ model: d.agents.model })
      .from(d.agents)
      .where(d.eq(d.agents.id, team.worker.id));
    expect(owner).toEqual([{ model: 'z-ai/glm-5.3' }]);
  });
});

describe("avant chaque essai : l'équipe du banc ne peut rien envoyer hors de Nodal", () => {
  const space = () => spaceIdFor(team.entityId);
  const copy = (id: string) => copyIdFor(space(), 'agents', id);

  it("une équipe copiée telle que la synchronisation l'écrit passe", async () => {
    await sync();
    expect(await checkSpaceCannotSend(db)).toEqual({
      ok: true,
      findings: [],
      notCovered: [
        "agent coder (claude-code): runs outside Nodal's tool list",
        'declare_verification (process): held by alfred, coder, writer',
        'run_command (process): held by writer',
        'run_skill_script (process): held by writer',
        'save_memory (model-provider): held by alfred, coder, writer',
        'web_search (internet): held by alfred, coder, writer',
      ],
      scope: await checkScope(),
    });
    await expect(assertSpaceCannotSend(db)).resolves.toBeUndefined();
    // Le propriétaire, lui, a de quoi envoyer : la règle n'est pas aveugle.
    const owner = await checkSpaceCannotSend(db, team.entityId);
    expect(owner.ok).toBe(false);
  });

  it("une liaison de canal sur une copie refuse l'essai, et la nomme", async () => {
    await sync();
    await pg.query(
      `insert into channel_bindings (entity_id, agent_id, channel, credentials) values ($1, $2, 'discord', 'enc:v1:X')`,
      [space(), copy(team.rootAgent.id)],
    );
    const r = await checkSpaceCannotSend(db);
    expect(r.ok).toBe(false);
    expect(r.findings).toContain('discord channel bound to agent alfred');
    expect(
      r.findings.some((f) =>
        f.startsWith('agent alfred reaches outside Nodal through discord binding (channel): '),
      ),
    ).toBe(true);
    await expect(assertSpaceCannotSend(db)).rejects.toThrow(
      /bench_space_can_send: the trial does not start/,
    );
  });

  it('même désactivée, une liaison refuse : un geste suffit à la rouvrir', async () => {
    await sync();
    await pg.query(
      `insert into channel_bindings (entity_id, agent_id, channel, credentials, enabled) values ($1, $2, 'whatsapp', 'enc:v1:X', false)`,
      [space(), copy(team.worker.id)],
    );
    expect((await checkSpaceCannotSend(db)).findings).toEqual([
      'whatsapp channel bound to agent writer',
    ]);
  });

  it('un connecteur ou un serveur MCP prêté à une copie refuse, en le nommant', async () => {
    await sync();
    const [conn] = await db
      .insert(d.connectors)
      .values({ entityId: space(), name: 'Mail', slug: 'gmail' })
      .returning();
    await db
      .insert(d.agentConnectorAssignments)
      .values({ entityId: space(), agentId: copy(team.worker.id), connectorId: conn!.id });
    const mcp = await pg.query<{ id: string }>(
      `insert into mcp_servers (entity_id, name, slug, transport, url, available_tools) values ($1, 'Printer', 'printer', 'http', 'http://x', '[{"name":"print"}]') returning id::text`,
      [space()],
    );
    await db
      .insert(d.agentMcpServers)
      .values({ entityId: space(), agentId: copy(team.coder.id), mcpServerId: mcp.rows[0]!.id });

    const r = await checkSpaceCannotSend(db);
    expect(r.ok).toBe(false);
    expect(
      r.findings.some((f) =>
        f.startsWith('agent writer reaches outside Nodal through gmail (connector): '),
      ),
    ).toBe(true);
    expect(r.findings).toContain(
      'agent coder reaches outside Nodal through printer (mcp): printer__print',
    );
  });

  it("une synchronisation qui laisserait l'espace parler au monde n'écrit rien", async () => {
    // Quelqu'un a lié un canal à une copie entre deux synchronisations : la
    // suivante refuse, et sa transaction est annulée (le changement du
    // propriétaire n'est PAS reporté).
    await sync();
    await pg.query(
      `insert into channel_bindings (entity_id, agent_id, channel, credentials) values ($1, $2, 'slack', 'enc:v1:X')`,
      [space(), copy(team.rootAgent.id)],
    );
    await db
      .update(d.agents)
      .set({ personality: 'changed by the owner' })
      .where(d.eq(d.agents.id, team.worker.id));
    await expect(sync()).rejects.toThrow(/bench_space_can_send/);
    const [w] = await db
      .select({ personality: d.agents.personality })
      .from(d.agents)
      .where(d.eq(d.agents.id, copy(team.worker.id)));
    expect(w!.personality).toBe('You write.');
  });

  it("le racine copié n'a aucun droit qui fasse entrer un connecteur ou un serveur MCP", async () => {
    await sync();
    const toolsOfRoot = await (
      await import('@nodal-agents/orchestration')
    ).computeAgentToolNames(copy(team.rootAgent.id) as never, space() as never, db, {
      hasDeliveryRecipient: true,
    });
    for (const t of ['create_connector', 'attach_connector', 'create_mcp', 'attach_mcp']) {
      expect(toolsOfRoot.has(t), t).toBe(false);
    }
    // Les autres droits du propriétaire passent : l'équipe reste la sienne.
    expect(toolsOfRoot.has('create_skill')).toBe(true);
    expect(toolsOfRoot.has('create_agent')).toBe(true);

    // Qu'on en rallume un dans l'espace, et l'essai ne démarre plus.
    await db
      .update(d.entities)
      .set({
        rootGrants: {
          ...DEFAULT_ROOT_GRANTS,
          createMcp: false,
          attachMcp: false,
          createConnector: false,
        },
      })
      .where(d.eq(d.entities.id, space()));
    const r = await checkSpaceCannotSend(db);
    expect(r.findings).toEqual([
      'agent alfred reaches outside Nodal through attachConnector (grant): attach_connector, detach_connector',
    ]);
  });

  it("dit ce qu'il ne couvre pas : la portée, et chaque agent en runtime CLI", async () => {
    await sync();
    const r = await checkSpaceCannotSend(db);
    expect(r.ok).toBe(true);
    // Ce que l'équipe tient vraiment, lu des déclarations `egress` du produit.
    expect(r.notCovered).toEqual([
      "agent coder (claude-code): runs outside Nodal's tool list",
      'declare_verification (process): held by alfred, coder, writer',
      'run_command (process): held by writer',
      'run_skill_script (process): held by writer',
      'save_memory (model-provider): held by alfred, coder, writer',
      'web_search (internet): held by alfred, coder, writer',
    ]);
    const text = renderCheck(r);
    expect(text).toContain(
      'no channel, connector or MCP server is within reach, and none can be added',
    );
    const scope = await checkScope();
    expect(text).toContain(scope);
    // La portée vient des déclarations : un outil intégré qui atteint le réseau
    // (generate_speech, que la première version oubliait) y est, sans liste ici.
    expect(scope).toContain('generate_speech, save_memory (a model provider)');
    expect(scope).toContain(
      'code_task, declare_verification, run_command, run_skill_script (a process they start)',
    );
    expect(scope).toContain('web_search (the internet)');
    expect(scope).toContain('nor CLI runtimes (Claude Code, Codex)');
    expect(scope).toContain('Webhook triggers are not copied, and not covered.');
    expect(text).not.toMatch(/no tool can send/i);
  });
});

describe("les fichiers d'une skill système suivent l'équipe", () => {
  it("une copie lit, depuis le magasin de l'espace, le fichier qu'un agent du propriétaire y avait", async () => {
    await sync();
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const read = registry.get('skill_file_read')!;
    const spaceId = spaceIdFor(team.entityId);
    const ctx: ToolContext = {
      jobId: '00000000-0000-0000-0000-000000000000',
      agentId: copyIdFor(spaceId, 'agents', team.worker.id),
      entityId: spaceId,
      jobChatId: null,
      db,
      // Ce que le runner pose : le magasin de l'ESPACE du job.
      skillStoreDir: join(root, spaceId, 'skills'),
      assignedSkillSlugs: ['dev', 'house-style'],
    };
    const out = (await read.execute({ skill: 'dev', path: 'notes.md' }, ctx)) as {
      ok: boolean;
      content?: string;
    };
    expect(out.ok).toBe(true);
    expect(out.content).toContain('dev notes of the team');
  });
});

describe('resolveBenchTarget — the one place trials go, never the owner', () => {
  it('after a sync: the bench space and its root copy, never the owner workspace', async () => {
    await sync();
    const spaceId = spaceIdFor(team.entityId);
    const target = await resolveBenchTarget(db);
    expect(target).toEqual({
      entityId: spaceId,
      rootAgentId: copyIdFor(spaceId, 'agents', team.rootAgent.id),
      rootAgentSlug: 'alfred',
    });
    expect(target.entityId).not.toBe(team.entityId);
  });

  it('no bench space: refuses with the sync hint, and never falls back to the owner', async () => {
    await expect(resolveBenchTarget(db)).rejects.toThrow(
      /bench_space_missing: .*pnpm bench:space sync --apply/,
    );
  });

  it('a bench space without a usable root refuses, saying which', async () => {
    await sync();
    const spaceId = spaceIdFor(team.entityId);
    const rootCopy = copyIdFor(spaceId, 'agents', team.rootAgent.id);
    await db.update(d.agents).set({ active: false }).where(d.eq(d.agents.id, rootCopy));
    await expect(resolveBenchTarget(db)).rejects.toThrow(
      /bench_space_root_invalid: .* is inactive\. Re-run `pnpm bench:space sync --apply`/,
    );
    await db.update(d.entities).set({ rootAgentId: null }).where(d.eq(d.entities.id, spaceId));
    await expect(resolveBenchTarget(db)).rejects.toThrow(/bench_space_no_root: /);
    // Une racine qui pointerait hors de l'espace (l'agent du propriétaire) est refusée aussi.
    await db
      .update(d.entities)
      .set({ rootAgentId: team.rootAgent.id })
      .where(d.eq(d.entities.id, spaceId));
    await expect(resolveBenchTarget(db)).rejects.toThrow(/is outside the bench space/);
  });
});

describe('jobOffTarget — where run_task really put the job', () => {
  it('a job of the bench root passes; one in the owner space, of another agent, or missing, does not', async () => {
    await sync();
    const target = await resolveBenchTarget(db);
    const [onTarget, inOwner, otherAgent] = await db
      .insert(d.agentJobs)
      .values([
        { entityId: target.entityId, agentId: target.rootAgentId, channel: 'mcp', task: 't' },
        { entityId: team.entityId, agentId: team.rootAgent.id, channel: 'mcp', task: 't' },
        {
          entityId: target.entityId,
          agentId: copyIdFor(target.entityId, 'agents', team.worker.id),
          channel: 'mcp',
          task: 't',
        },
      ])
      .returning({ id: d.agentJobs.id });
    const off = async (id: string) => jobOffTarget(id, await readJobPlacement(db, id), target);
    expect(await off(onTarget!.id)).toBeNull();
    expect(await off(inOwner!.id)).toMatch(
      new RegExp(
        `workflow_wrong_target: job ${inOwner!.id} was created in workspace ${team.entityId}`,
      ),
    );
    expect(await off(otherAgent!.id)).toMatch(/workflow_wrong_target: .* for agent /);
    // L'agent de la cible, mais une ligne posée dans un autre espace : refusée aussi.
    const [crossed] = await db
      .insert(d.agentJobs)
      .values({ entityId: team.entityId, agentId: target.rootAgentId, channel: 'mcp', task: 't' })
      .returning({ id: d.agentJobs.id });
    expect(await off(crossed!.id)).toMatch(
      new RegExp(
        `workflow_wrong_target: job ${crossed!.id} was created in workspace ${team.entityId}`,
      ),
    );
    const missing = '00000000-0000-4000-8000-000000000099';
    expect(await off(missing)).toBe(
      `workflow_wrong_target: job ${missing} was not found after run_task`,
    );
  });
});
