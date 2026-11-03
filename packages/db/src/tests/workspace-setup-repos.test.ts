// workspace-setup-repos.test.ts — les fonctions de base sorties des actions du tableau de bord.
//
// Le tableau de bord ET l'applicateur du banc (packages/bench/src/campaign)
// écrivent par elles. Ces cas prouvent, sur les LIGNES écrites, ce que chacune
// garantit à TOUT appelant : la clé chiffrée, l'espace et son propriétaire, la
// consigne de délégation, la chaîne de repli nettoyée, la garde de dossier
// d'une règle d'accord, le préréglage lecture seule qui ne retire que ses
// propres lignes, le connecteur d'un autre espace refusé, le masquage hérité
// d'un dossier, la skill de l'espace qui l'emporte sur celle du système, le
// serveur MCP stdio et son environnement chiffré valeur par valeur, la règle
// d'un outil posée comme l'écran la pose.

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { _setMasterKeyForTests, decrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import * as schema from '../schema/index.ts';
import { createAgentRepo, setAgentModelRepo } from '../repos/agents.ts';
import { createWorkspaceRepo, setRunBudgetRepo } from '../repos/workspaces.ts';
import { createLlmKeyRepo } from '../repos/llm-keys.ts';
import {
  READONLY_PRESET_TOOLS,
  setApprovalRuleRepo,
  setReadOnlyPresetRepo,
  setRunCommandRuleRepo,
} from '../repos/approval-rules.ts';
import { createStdioMcpServerRepo, decryptMcpServerEnv } from '../repos/mcp-servers.ts';
import { createApiKeyConnectorRepo, setAgentConnectorAssignmentRepo } from '../repos/connectors.ts';
import { addAgentWorkspaceRepo } from '../repos/agent-workspaces.ts';
import { resolveSkillIdsBySlug } from '../repos/skills.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  // Clé maîtresse déterministe : jamais ~/.nodalai/secrets.key.
  _setMasterKeyForTests(Buffer.alloc(32, 9));
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
});

describe('createWorkspaceRepo and the workspace switches', () => {
  it('creates the workspace AND its owner membership; the run budget is written as given', async () => {
    const { id } = await createWorkspaceRepo(db, { userId: seed.userId, name: 'Banc', icon: '🧪' });
    const [ent] = await db.select().from(schema.entities).where(eq(schema.entities.id, id));
    expect(ent).toMatchObject({ name: 'Banc', icon: '🧪', userId: seed.userId });
    expect(ent!.slug).toMatch(/^banc-[0-9a-f]{6}$/);
    const members = await db
      .select()
      .from(schema.entityMembers)
      .where(eq(schema.entityMembers.entityId, id));
    expect(members.map((m) => [m.userId, m.role])).toEqual([[seed.userId, 'owner']]);
    await setRunBudgetRepo(db, id, { maxRunCostUsd: 0.75, maxRunHours: 0 });
    const [after] = await db.select().from(schema.entities).where(eq(schema.entities.id, id));
    expect([after!.maxRunCostUsd, after!.maxRunHours]).toEqual([0.75, 0]);
  });
});

describe('createLlmKeyRepo', () => {
  it('writes the key encrypted with its last four, and refuses a second key for the same provider', async () => {
    const { id } = await createWorkspaceRepo(db, { userId: seed.userId, name: 'Keys' });
    const r = await createLlmKeyRepo(db, id, {
      provider: 'openrouter',
      apiKey: 'sk-or-abcd1234',
      isActive: true,
    });
    expect('id' in r).toBe(true);
    const [row] = await db
      .select()
      .from(schema.entityLlmKeys)
      .where(eq(schema.entityLlmKeys.entityId, id));
    expect(row!.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(row!.apiKey)).toBe('sk-or-abcd1234');
    expect(row!.apiKeyLast4).toBe('1234');
    expect(
      await createLlmKeyRepo(db, id, { provider: 'openrouter', apiKey: 'other', isActive: true }),
    ).toEqual({ error: 'provider_exists' });
  });
});

describe('createAgentRepo writes the delegation text of each sub-agent @cap:organiser-equipe/moteur', () => {
  it('the orchestrator is created with its team AND the text shown for each teammate', async () => {
    const [worker] = await db
      .insert(schema.agents)
      .values({ entityId: seed.entityId, slug: 'researcher', name: 'Researcher', personality: 'x' })
      .returning();
    const created = await createAgentRepo(db, seed.entityId, {
      slug: 'boss',
      name: 'Boss',
      personality: 'x',
      model: 'm',
      llmKeyId: null,
      role: 'orchestrator',
      orchestratorMode: 'router',
      avatarUrl: null,
      subAgentIds: [worker!.id],
      subAgentInstructions: { [worker!.id]: 'Deep research, with sources' },
    });
    const bossId = 'id' in created ? created.id : '';
    const rows = await db
      .select({
        sub: schema.agentAssignments.subAgentId,
        text: schema.agentAssignments.instructions,
      })
      .from(schema.agentAssignments)
      .where(eq(schema.agentAssignments.orchestratorId, bossId));
    expect(rows).toEqual([{ sub: worker!.id, text: 'Deep research, with sources' }]);
  });

  it('refuses a text for an agent that is not one of the sub-agents, and writes nothing', async () => {
    await expect(
      createAgentRepo(db, seed.entityId, {
        slug: 'stray',
        name: 'Stray',
        personality: 'x',
        model: 'm',
        llmKeyId: null,
        role: 'agent',
        orchestratorMode: null,
        avatarUrl: null,
        subAgentIds: [],
        subAgentInstructions: { '00000000-0000-4000-8000-000000000000': 'nobody' },
      }),
    ).rejects.toThrow(/sub_agent_instructions_without_sub_agent: 00000000-/);
    const found = await db.select().from(schema.agents).where(eq(schema.agents.slug, 'stray'));
    expect(found).toEqual([]);
  });
});

describe('setAgentModelRepo @cap:choisir-modele/moteur', () => {
  it('sets model and key, and takes the new primary key out of the fallback chain', async () => {
    const other = await createLlmKeyRepo(db, seed.entityId, {
      provider: 'openrouter',
      apiKey: 'k',
      isActive: true,
    });
    const otherId = 'id' in other ? other.id : '';
    await db
      .update(schema.agents)
      .set({
        fallbackChain: [
          { keyId: otherId, model: 'fallback-model' },
          { keyId: seed.llmKeyId, model: 'b' },
        ],
      })
      .where(eq(schema.agents.id, seed.agentId));
    expect(
      await setAgentModelRepo(db, seed.entityId, {
        agentId: seed.agentId,
        model: 'anthropic/claude-haiku-5.5',
        reasoningEffort: null,
        llmKeyId: otherId,
      }),
    ).toEqual({ ok: true });
    const [a] = await db.select().from(schema.agents).where(eq(schema.agents.id, seed.agentId));
    expect([a!.model, a!.llmKeyId, a!.fallbackChain]).toEqual([
      'anthropic/claude-haiku-5.5',
      otherId,
      [{ keyId: seed.llmKeyId, model: 'b' }],
    ]);
  });

  it('refuses an agent of another workspace, and writes nothing to it', async () => {
    const { id } = await createWorkspaceRepo(db, { userId: seed.userId, name: 'Elsewhere' });
    expect(
      await setAgentModelRepo(db, id, { agentId: seed.agentId, model: 'x', reasoningEffort: null }),
    ).toEqual({ error: 'agent_not_found' });
    const [a] = await db.select().from(schema.agents).where(eq(schema.agents.id, seed.agentId));
    expect(a!.model).toBe('anthropic/claude-haiku-5.5');
  });
});

describe('the approval rules @cap:regler-autonomie/moteur', () => {
  it('run_command: its row is written and replaced, never removed; a folder row lives beside it (#917)', async () => {
    const where = and(
      eq(schema.approvalRules.agentId, seed.agentId),
      eq(schema.approvalRules.toolName, 'run_command'),
    );
    const held = async () =>
      (await db.select().from(schema.approvalRules).where(where))
        .map((r) => `${r.action}@${r.conditionFolder}`)
        .sort();
    expect(await setRunCommandRuleRepo(db, seed.entityId, seed.agentId, 'auto_approve')).toEqual({
      ok: true,
    });
    expect(await held()).toEqual(['auto_approve@']);

    await db.insert(schema.approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'run_command',
      action: 'block',
      conditionJson: { workspacePath: 'D:/work/project' },
    });
    // The tool row changes; the folder row is another row, untouched.
    expect(
      await setRunCommandRuleRepo(db, seed.entityId, seed.agentId, 'require_approval'),
    ).toEqual({ ok: true });
    expect(await held()).toEqual(['block@D:/work/project', 'require_approval@']);
    await db.delete(schema.approvalRules).where(where);
  });

  // setApprovalRuleRepo : le chemin de `setAgentApprovalRuleAction` (l'écran)
  // et de l'applicateur du banc (#794), sur n'importe quel outil.
  it('a tool row: replaced in place, never removed; a folder row is removed alone', async () => {
    const tool = 'bench_printer__request_print';
    const rows = () =>
      db
        .select({
          agentId: schema.approvalRules.agentId,
          action: schema.approvalRules.action,
          conditionJson: schema.approvalRules.conditionJson,
        })
        .from(schema.approvalRules)
        .where(
          and(
            eq(schema.approvalRules.entityId, seed.entityId),
            eq(schema.approvalRules.toolName, tool),
          ),
        );
    const rule = (over: Partial<Parameters<typeof setApprovalRuleRepo>[2]>) =>
      setApprovalRuleRepo(db, seed.entityId, {
        agentId: seed.agentId,
        toolName: tool,
        action: 'auto_approve',
        scope: 'agent',
        conditionJson: {},
        ...over,
      });
    expect(await rule({})).toEqual({ ok: true });
    expect(await rows()).toEqual([
      { agentId: seed.agentId, action: 'auto_approve', conditionJson: {} },
    ]);
    // Replaced in place: one row, never two.
    expect(await rule({ action: 'block' })).toEqual({ ok: true });
    expect(await rows()).toEqual([{ agentId: seed.agentId, action: 'block', conditionJson: {} }]);
    // A tool row is never removed: without it the gate refuses the tool.
    expect(await rule({ action: null })).toEqual({
      refused: `${tool} always has a setting for this agent: choose Autonomous, Ask first or Block.`,
    });
    expect(await rows()).toHaveLength(1);
    // A folder row: written beside the tool row, removed alone.
    expect(await rule({ conditionJson: { workspacePath: 'D:/w' } })).toEqual({ ok: true });
    expect(await rows()).toHaveLength(2);
    expect(await rule({ action: null, conditionJson: { workspacePath: 'D:/w' } })).toEqual({
      ok: true,
    });
    expect(await rows()).toEqual([{ agentId: seed.agentId, action: 'block', conditionJson: {} }]);
    await db
      .delete(schema.approvalRules)
      .where(
        and(
          eq(schema.approvalRules.entityId, seed.entityId),
          eq(schema.approvalRules.toolName, tool),
        ),
      );
  });

  it('a template row rewrites the rows it covers: a server for its tools, Everyone for every agent', async () => {
    const [other] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        slug: `autre-${Date.now()}`,
        name: 'Autre',
        personality: 'p',
      })
      .returning();
    if (!other) throw new Error('agent not created');
    const put = (
      agentId: string,
      toolName: string,
      action: 'auto_approve' | 'require_approval' | 'block',
    ) =>
      db
        .insert(schema.approvalRules)
        .values({ entityId: seed.entityId, agentId, toolName, action });
    await put(seed.agentId, 'tpl__read', 'require_approval');
    await put(seed.agentId, 'tpl__write', 'block');
    await put(other.id, 'tpl__read', 'require_approval');
    await db.insert(schema.approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'tpl__read',
      action: 'block',
      conditionJson: { workspacePath: 'D:/keep' },
    });
    const of = async (agentId: string) =>
      (
        await db
          .select()
          .from(schema.approvalRules)
          .where(
            and(
              eq(schema.approvalRules.entityId, seed.entityId),
              eq(schema.approvalRules.agentId, agentId),
            ),
          )
      )
        .filter((r) => r.toolName.startsWith('tpl'))
        .map((r) => `${r.toolName}=${r.action}${r.conditionFolder ? `@${r.conditionFolder}` : ''}`)
        .sort();

    // The agent's server row: its own tools of that server, nobody else's,
    // and never a folder row.
    expect(
      await setApprovalRuleRepo(db, seed.entityId, {
        agentId: seed.agentId,
        toolName: 'tpl__*',
        action: 'auto_approve',
        scope: 'agent',
        conditionJson: {},
      }),
    ).toEqual({ ok: true });
    expect(await of(seed.agentId)).toEqual([
      'tpl__*=auto_approve',
      'tpl__read=auto_approve',
      'tpl__read=block@D:/keep',
      'tpl__write=auto_approve',
    ]);
    expect(await of(other.id)).toEqual(['tpl__read=require_approval']);

    // Everyone + one tool: that tool's row, for every agent of the workspace.
    expect(
      await setApprovalRuleRepo(db, seed.entityId, {
        agentId: seed.agentId,
        toolName: 'tpl__read',
        action: 'block',
        scope: 'entity',
        conditionJson: {},
      }),
    ).toEqual({ ok: true });
    expect(await of(seed.agentId)).toContain('tpl__read=block');
    expect(await of(other.id)).toEqual(['tpl__read=block']);

    // A rule for every tool is the level's job, refused here.
    expect(
      await setApprovalRuleRepo(db, seed.entityId, {
        agentId: seed.agentId,
        toolName: '*',
        action: 'auto_approve',
        scope: 'agent',
        conditionJson: {},
      }),
    ).toHaveProperty('refused');
    await db.delete(schema.approvalRules).where(eq(schema.approvalRules.entityId, seed.entityId));
  });

  it('the read-only preset blocks its tools; removing it gives each back the value handed in, and keeps a row set by hand', async () => {
    await db.insert(schema.approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'run_command',
      action: 'require_approval',
    });
    await setReadOnlyPresetRepo(db, seed.entityId, seed.agentId, true);
    const rows = async () =>
      (
        await db
          .select()
          .from(schema.approvalRules)
          .where(eq(schema.approvalRules.agentId, seed.agentId))
      )
        .map((r) => `${r.toolName}=${r.action}`)
        .sort();
    expect(await rows()).toEqual(READONLY_PRESET_TOOLS.map((t) => `${t}=block`).sort());
    // Back to the level's values: the rows stay, they are not deleted (#917).
    const restore = Object.fromEntries(
      READONLY_PRESET_TOOLS.map((t) => [
        t,
        t === 'run_command' ? 'require_approval' : 'auto_approve',
      ]),
    ) as Record<string, 'auto_approve' | 'require_approval'>;
    await setReadOnlyPresetRepo(db, seed.entityId, seed.agentId, false, restore);
    expect(await rows()).toEqual(READONLY_PRESET_TOOLS.map((t) => `${t}=${restore[t]}`).sort());
    // A missing value is a caller's fault, said loud.
    await setReadOnlyPresetRepo(db, seed.entityId, seed.agentId, true);
    await expect(setReadOnlyPresetRepo(db, seed.entityId, seed.agentId, false, {})).rejects.toThrow(
      /no value to restore/,
    );
    await db.delete(schema.approvalRules).where(eq(schema.approvalRules.agentId, seed.agentId));
  });
});

describe('connectors and folders @cap:connecter-un-service/moteur', () => {
  it('the key is encrypted once; an assignment names its operations; a connector of another workspace is refused', async () => {
    const { id } = await createApiKeyConnectorRepo(db, seed.entityId, {
      slug: 'tavily',
      name: 'Tavily',
      apiKey: 'tvly-123',
    });
    const [c] = await db.select().from(schema.connectors).where(eq(schema.connectors.id, id));
    expect(c!.apiKey!.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(c!.apiKey!)).toBe('tvly-123');
    const again = await createApiKeyConnectorRepo(db, seed.entityId, {
      slug: 'tavily',
      name: 'T2',
      apiKey: c!.apiKey!,
    });
    const [c2] = await db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, again.id));
    expect(c2!.apiKey).toBe(c!.apiKey);

    expect(
      await setAgentConnectorAssignmentRepo(db, seed.entityId, {
        agentId: seed.agentId,
        connectorId: id,
        assigned: true,
        enabledOperations: ['tavily_search'],
      }),
    ).toEqual({ ok: true });
    const [a] = await db
      .select()
      .from(schema.agentConnectorAssignments)
      .where(eq(schema.agentConnectorAssignments.connectorId, id));
    expect(a!.enabledOperations).toEqual(['tavily_search']);

    const { id: elsewhere } = await createWorkspaceRepo(db, { userId: seed.userId, name: 'Other' });
    const foreign = await createApiKeyConnectorRepo(db, elsewhere, {
      slug: 'tavily',
      name: 'Theirs',
      apiKey: 'x',
    });
    expect(
      await setAgentConnectorAssignmentRepo(db, seed.entityId, {
        agentId: seed.agentId,
        connectorId: foreign.id,
        assigned: true,
        enabledOperations: null,
      }),
    ).toEqual({ error: 'connector_not_found' });
  });

  it('a folder already hidden from the Code tab elsewhere in the workspace arrives hidden', async () => {
    const [other] = await db
      .insert(schema.agents)
      .values({ entityId: seed.entityId, slug: 'notes', name: 'Notes', personality: 'x' })
      .returning();
    await db.insert(schema.agentWorkspaces).values({
      agentId: other!.id,
      entityId: seed.entityId,
      label: 'Vault',
      path: 'C:\\Vault',
      hiddenFromCode: true,
    });
    const r = await addAgentWorkspaceRepo(db, seed.entityId, {
      agentId: seed.agentId,
      label: 'Vault',
      path: 'c:/vault',
    });
    const [row] = await db
      .select()
      .from(schema.agentWorkspaces)
      .where(eq(schema.agentWorkspaces.id, 'id' in r ? r.id : ''));
    expect(row!.hiddenFromCode).toBe(true);
  });
});

describe('resolveSkillIdsBySlug', () => {
  it('this workspace’s own row wins over the system one; another workspace’s same-slug row never passes', async () => {
    const { id: other } = await createWorkspaceRepo(db, { userId: seed.userId, name: 'Squatter' });
    const [system] = await db
      .insert(schema.agentSkills)
      .values({ entityId: other, slug: 'obsidian', name: 'sys', content: 'c', createdBy: 'system' })
      .returning();
    const [squat] = await db
      .insert(schema.agentSkills)
      .values({
        entityId: other,
        slug: 'citation-discipline',
        name: 'fake',
        content: 'c',
        createdBy: 'user',
      })
      .returning();
    void squat;
    const [own] = await db
      .insert(schema.agentSkills)
      .values({ entityId: seed.entityId, slug: 'obsidian', name: 'mine', content: 'c' })
      .returning();
    const found = await resolveSkillIdsBySlug(
      db,
      seed.entityId,
      ['obsidian', 'citation-discipline'],
      ['obsidian', 'citation-discipline'],
    );
    expect(found.get('obsidian')).toBe(own!.id);
    expect(found.get('obsidian')).not.toBe(system!.id);
    expect(found.has('citation-discipline')).toBe(false);
  });
});

describe('a stdio MCP server and its environment @cap:connecter-un-service/moteur', () => {
  it('is written active, its environment encrypted value by value, and read back as the runner reads it', async () => {
    const { id } = await createStdioMcpServerRepo(db, seed.entityId, {
      name: 'Bench printer',
      slug: 'bench-printer',
      command: 'node',
      args: ['server.js'],
      env: { RECORDS_DIR: 'D:/records', TOKEN: 'secret-token' },
      availableTools: [{ name: 'request_print', inputSchema: {} }],
      instructions: 'Print requests wait here.',
    });
    const [row] = await db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id));
    expect(row).toMatchObject({
      entityId: seed.entityId,
      slug: 'bench-printer',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      active: true,
      instructions: 'Print requests wait here.',
      availableTools: [{ name: 'request_print', inputSchema: {} }],
    });
    const stored = row!.envVars as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual(['RECORDS_DIR', 'TOKEN']);
    for (const v of Object.values(stored)) expect(v.startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('secret-token');
    expect(decrypt(stored['TOKEN']!)).toBe('secret-token');
    expect(decryptMcpServerEnv(row!.envVars)).toEqual({
      RECORDS_DIR: 'D:/records',
      TOKEN: 'secret-token',
    });
  });

  it("encrypts with the caller's function when it lends one (the runner lends it to create_mcp)", async () => {
    const { id } = await createStdioMcpServerRepo(
      db,
      seed.entityId,
      {
        name: 'x',
        slug: 'x-server',
        command: 'node',
        args: [],
        env: { A: 'one' },
        availableTools: [],
        instructions: null,
      },
      (v) => `lent:${v}`,
    );
    const [row] = await db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id));
    expect(row!.envVars).toEqual({ A: 'lent:one' });
  });

  it('an environment that cannot be read is said, never a variable dropped in silence', () => {
    expect(decryptMcpServerEnv(null)).toEqual({});
    expect(() => decryptMcpServerEnv(['a'])).toThrow(
      /mcp_server_env_invalid: env_vars is not an object/,
    );
    expect(() => decryptMcpServerEnv({ A: 3 })).toThrow(
      /mcp_server_env_invalid: A is not a string/,
    );
    // A value written in clear does not decrypt: the runner would not start the server.
    expect(() => decryptMcpServerEnv({ A: 'D:/records' })).toThrow();
  });
});
