// scenario-tools.test.ts — la liste fermée des outils d'un scénario, posée sur l'instance d'une campagne (décision 1B).
//
// Sur l'instance réellement appliquée (PGlite, semée comme `up` la sème) : ce
// qu'un job de chaque agent pourrait APPELER, lu dans la liste du runner
// (`resolveAgentToolNames`, dont un test du runner prouve qu'elle égale celle
// d'`executeJob`) et jugé par la règle de l'exécution (`matchApprovalRule`),
// avant, pendant et après la liste.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { matchApprovalRule } from '@nodal-agents/tools';
import { SCENARIOS, scenarioById } from '../../workflows/scenarios';
import { resolveAgentToolNames } from '@nodal-agents/orchestration';
import { existsSync } from 'node:fs';
import {
  applyScenarioTools,
  parseScenarioTools,
  recoverScenarioTools,
  scenarioToolsFingerprint,
} from '../../workflows/scenario-tools';
import { readProcessStarters } from '../../workflows/stack';
import { applyCampaignConfig, type AppliedCampaign } from '../apply';
import { loadCampaignConfig } from '../config';
import { teamDrift } from '../team';
import { TEST_KEYS, fakeCommunityInstaller, freshInstanceDb, isolateUserHome } from './harness';

const home = isolateUserHome();
const config = loadCampaignConfig();
let db: AnyDrizzleDb;
let applied: AppliedCampaign;
let entityId: string;
/** Le journal de la liste, dans un dossier jetable : jamais l'état du banc de la machine. */
let journal: string;

afterAll(() => home.restore());

beforeEach(async () => {
  ({ db } = await freshInstanceDb());
  const scratch = mkdtempSync(join(tmpdir(), 'scenario-tools-'));
  journal = join(scratch, 'bench', 'scenario-tools.journal.json');
  applied = await applyCampaignConfig(db, config, TEST_KEYS, {
    foldersRoot: join(scratch, 'folders'),
    printerRecordsDir: join(scratch, 'bench-printer-records'),
    installCommunitySkill: fakeCommunityInstaller(db).install,
  });
  entityId = applied.tested.entityId;
});

/** Ce qu'un job de l'agent peut appeler : ses outils, moins ceux que la règle gagnante bloque. */
async function callable(slug: string): Promise<string[]> {
  const agentId = applied.agents[slug]!.id;
  const rules = await db
    .select({
      id: d.approvalRules.id,
      entityId: d.approvalRules.entityId,
      agentId: d.approvalRules.agentId,
      toolName: d.approvalRules.toolName,
      action: d.approvalRules.action,
      conditionJson: d.approvalRules.conditionJson,
    })
    .from(d.approvalRules)
    .where(d.eq(d.approvalRules.entityId, entityId));
  return [...(await resolveAgentToolNames(db, agentId))]
    .sort()
    .filter((t) => matchApprovalRule(rules as never, t, agentId, entityId)?.action !== 'block');
}

/** Toutes les règles de l'espace, sans leurs identifiants ni leurs dates : l'état à retrouver. */
async function rules(): Promise<string[]> {
  const rows = await db
    .select({
      agentId: d.approvalRules.agentId,
      toolName: d.approvalRules.toolName,
      action: d.approvalRules.action,
      conditionJson: d.approvalRules.conditionJson,
    })
    .from(d.approvalRules)
    .where(d.eq(d.approvalRules.entityId, entityId));
  return rows.map((r) => JSON.stringify(r)).sort();
}

const OFFICE = (t: string) => /^(xlsx|docx|pptx)_/.test(t);

describe('the closed tool list of each scenario (decision 1B)', () => {
  it('every scenario declares a valid list, and its fingerprint is the list’s, not its order', async () => {
    for (const s of SCENARIOS) {
      expect(await parseScenarioTools(s.id, s.tools)).toEqual([...s.tools]);
    }
    expect(scenarioToolsFingerprint(['return_result', 'ask_user'])).toBe(
      scenarioToolsFingerprint(['ask_user', 'return_result']),
    );
    expect(scenarioToolsFingerprint(['return_result'])).not.toBe(
      scenarioToolsFingerprint(['return_result', 'run_command']),
    );
  });

  it('refuses a tool the product does not have, a list without return_result, an entry twice', async () => {
    await expect(parseScenarioTools('x', ['return_result', 'print_now'])).rejects.toThrow(
      'scenario_tools_invalid: x: no tool of the product is named print_now',
    );
    await expect(parseScenarioTools('x', ['return_result', 'nonexistent_*'])).rejects.toThrow(
      'no tool of the product is named nonexistent_*',
    );
    await expect(parseScenarioTools('x', ['ask_user'])).rejects.toThrow(
      'return_result cannot be blocked: list it',
    );
    await expect(parseScenarioTools('x', ['return_result', 'return_result'])).rejects.toThrow(
      'an entry is listed twice',
    );
  });

  it('the print list: each agent can call exactly its listed tools, and nobody can start a process', async () => {
    const t = await applyScenarioTools(
      db,
      entityId,
      'print',
      scenarioById('print')!.tools,
      journal,
    );
    try {
      expect(await callable('chef')).toEqual([
        'ask_user',
        'assign_chercheur',
        'assign_imageur',
        'bench_printer__get_print_request',
        'bench_printer__request_print',
        'file_edit',
        'file_list',
        'file_move',
        'file_read',
        'file_search',
        'file_write',
        'load_tools',
        'mark_memory_helpful',
        'mark_memory_outdated',
        'nodal_docs',
        'query_memory',
        'register_project',
        'return_result',
        'save_memory',
        'search_history',
        'skill_view',
      ]);
      // The runner gives every agent create_task and list_tasks (delegation's
      // task tools): a task outlives the trial, so the list closes them.
      const chefId = applied.agents['chef']!.id;
      expect([...(await resolveAgentToolNames(db, chefId))]).toEqual(
        expect.arrayContaining(['create_task', 'list_tasks', 'run_command']),
      );
      // The Chercheur keeps neither its web connectors nor web_search here.
      expect(
        (await callable('chercheur')).filter((x) => /tavily|firecrawl|web_search/.test(x)),
      ).toEqual([]);
      expect(await readProcessStarters(db, entityId)).toEqual([]);
      // What was closed, said per agent: Chef's process, office and other tools.
      expect(t.closed['chef']).toEqual(
        expect.arrayContaining(['run_command', 'declare_verification', 'xlsx_read', 'web_search']),
      );
    } finally {
      await t.restore();
    }
  });

  it('restoring gives every rule back as it was, a folder rule with its folder, and the team is the configuration again', async () => {
    // A rule the owner set on a tool the print list closes, confined to a folder.
    const chef = applied.agents['chef']!.id;
    await d.setApprovalRuleRepo(db, entityId, {
      agentId: chef,
      toolName: 'xlsx_read',
      action: 'auto_approve',
      scope: 'agent',
      conditionJson: { workspacePath: 'D:/bench/project' },
    });
    const before = await rules();
    const callableBefore = await callable('chef');
    const t = await applyScenarioTools(
      db,
      entityId,
      'print',
      scenarioById('print')!.tools,
      journal,
    );
    expect(await rules()).not.toEqual(before);
    await t.restore();
    expect(await rules()).toEqual(before);
    expect(await callable('chef')).toEqual(callableBefore);
    await d.setApprovalRuleRepo(db, entityId, {
      agentId: chef,
      toolName: 'xlsx_read',
      action: null,
      scope: 'agent',
      conditionJson: {},
    });
    expect(await teamDrift(db, config, applied)).toEqual([]);
  });

  it('the next trial of another scenario gets ITS list, and nothing of the previous one', async () => {
    const print = await applyScenarioTools(
      db,
      entityId,
      'print',
      scenarioById('print')!.tools,
      journal,
    );
    await print.restore();
    const code = await applyScenarioTools(
      db,
      entityId,
      'code',
      scenarioById('code')!.tools,
      journal,
    );
    try {
      const chef = await callable('chef');
      expect(chef).toEqual(expect.arrayContaining(['run_command', 'declare_verification']));
      expect(chef.filter((x) => x.startsWith('bench_printer__') || OFFICE(x))).toEqual([]);
      expect((await readProcessStarters(db, entityId)).map((p) => p.agent)).toEqual([
        'chef',
        'chercheur',
        'imageur',
      ]);
    } finally {
      await code.restore();
    }
    const excel = await applyScenarioTools(
      db,
      entityId,
      'file',
      scenarioById('file')!.tools,
      journal,
    );
    try {
      const chef = await callable('chef');
      expect(chef.filter(OFFICE).every((x) => x.startsWith('xlsx_'))).toBe(true);
      expect(chef).toContain('xlsx_set_range');
      expect(chef).not.toContain('run_command');
    } finally {
      await excel.restore();
    }
    expect(await teamDrift(db, config, applied)).toEqual([]);
  });

  it('a list that names an unknown tool closes nothing: refused before any rule is written', async () => {
    const before = await rules();
    await expect(
      applyScenarioTools(db, entityId, 'x', ['return_result', 'not_a_tool'], journal),
    ).rejects.toThrow('scenario_tools_invalid');
    expect(await rules()).toEqual(before);
  });

  // Revue de #863, passe 1 (P2) : un banc tué entre la pose et la remise.
  it('a bench killed mid-trial: the next start puts every rule back from the journal, a folder rule with its folder', async () => {
    const chef = applied.agents['chef']!.id;
    await d.setApprovalRuleRepo(db, entityId, {
      agentId: chef,
      toolName: 'xlsx_read',
      action: 'auto_approve',
      scope: 'agent',
      conditionJson: { workspacePath: 'D:/bench/project' },
    });
    const before = await rules();
    // Applied, and the process dies: no finally, no restore.
    await applyScenarioTools(db, entityId, 'print', scenarioById('print')!.tools, journal);
    expect(existsSync(journal)).toBe(true);
    expect(await rules()).not.toEqual(before);
    // A new trial cannot start on top of it.
    await expect(
      applyScenarioTools(db, entityId, 'code', scenarioById('code')!.tools, journal),
    ).rejects.toThrow('scenario_tools_journal_pending');
    // The next start.
    const back = await recoverScenarioTools(db, journal);
    expect(back?.scenario).toBe('print');
    expect(back!.rules).toBeGreaterThan(0);
    expect(await rules()).toEqual(before);
    expect(existsSync(journal)).toBe(false);
    expect(await recoverScenarioTools(db, journal)).toBeNull();
  });

  // Revue de #863, passe 1 (P2) : les outils d'un serveur MCP dont la liste est vide ou périmée.
  it('an MCP server whose tools are unknown is closed whole, by its server tier, unless the list opens it', async () => {
    const { matchApprovalRule: match } = await import('@nodal-agents/tools');
    const chef = applied.agents['chef']!.id;
    const [server] = await db
      .insert(d.mcpServers)
      .values({ entityId, name: 'Notes', slug: 'notes-srv', transport: 'stdio', command: 'node' })
      .returning({ id: d.mcpServers.id });
    await d.attachMcpServerToAgent(db, { entityId, agentId: chef, mcpServerId: server!.id });
    // Nothing of it is in the runner's list yet: its tools are unknown.
    expect(
      [...(await resolveAgentToolNames(db, chef))].filter((t) => t.startsWith('notes_srv__')),
    ).toEqual([]);
    const t = await applyScenarioTools(
      db,
      entityId,
      'print',
      scenarioById('print')!.tools,
      journal,
    );
    try {
      expect(t.closed['chef']).toContain('notes_srv__*');
      const all = await db
        .select()
        .from(d.approvalRules)
        .where(d.eq(d.approvalRules.entityId, entityId));
      // Any tool the server may offer at the job's start is refused.
      expect(match(all as never, 'notes_srv__write_note', chef, entityId)?.action).toBe('block');
      // The bench printer, which the list opens, is not.
      expect(match(all as never, 'bench_printer__request_print', chef, entityId)?.action).not.toBe(
        'block',
      );
    } finally {
      await t.restore();
    }
    // A list that names some of the server's tools one by one cannot close the rest: refused.
    await expect(
      applyScenarioTools(db, entityId, 'x', ['return_result', 'notes_srv__read'], journal),
    ).rejects.toThrow();
  });

  // Revue de #863, passe 2 (P2-1) : une règle exacte sur un outil que le cache ne connaît pas.
  it('a closed server: an exact rule on a tool its cache does not know is closed too, then given back', async () => {
    const { matchApprovalRule: match } = await import('@nodal-agents/tools');
    const chef = applied.agents['chef']!.id;
    const [server] = await db
      .insert(d.mcpServers)
      .values({ entityId, name: 'Notes', slug: 'notes-srv', transport: 'stdio', command: 'node' })
      .returning({ id: d.mcpServers.id });
    await d.attachMcpServerToAgent(db, { entityId, agentId: chef, mcpServerId: server!.id });
    // Allowed without asking, for Chef and for the whole workspace: both outrank the tier.
    for (const scope of ['agent', 'entity'] as const)
      await d.setApprovalRuleRepo(db, entityId, {
        agentId: chef,
        toolName: scope === 'agent' ? 'notes_srv__write_note' : 'notes_srv__send_note',
        action: 'auto_approve',
        scope,
        conditionJson: {},
      });
    const before = await rules();
    const t = await applyScenarioTools(
      db,
      entityId,
      'print',
      scenarioById('print')!.tools,
      journal,
    );
    const all = await db
      .select()
      .from(d.approvalRules)
      .where(d.eq(d.approvalRules.entityId, entityId));
    expect(match(all as never, 'notes_srv__write_note', chef, entityId)?.action).toBe('block');
    expect(match(all as never, 'notes_srv__send_note', chef, entityId)?.action).toBe('block');
    expect(t.closed['chef']).toEqual(
      expect.arrayContaining(['notes_srv__*', 'notes_srv__send_note', 'notes_srv__write_note']),
    );
    expect(await t.restore()).toEqual({ changed: [] });
    expect(await rules()).toEqual(before);
  });

  // Revue de #863, passe 2 (P2-2) : la remise ne touche que ce que le banc a écrit.
  it('an owner edit made DURING a trial survives the restore, and is named', async () => {
    const chef = applied.agents['chef']!.id;
    const t = await applyScenarioTools(
      db,
      entityId,
      'print',
      scenarioById('print')!.tools,
      journal,
    );
    // The owner, during the trial, allows xlsx_read for Chef inside a folder.
    await d.setApprovalRuleRepo(db, entityId, {
      agentId: chef,
      toolName: 'xlsx_read',
      action: 'auto_approve',
      scope: 'agent',
      conditionJson: { workspacePath: 'D:/owner/work' },
    });
    const { changed } = await t.restore();
    expect(changed).toEqual([
      expect.stringContaining(
        `xlsx_read of agent ${chef} (now auto_approve {"workspacePath":"D:/owner/work"}`,
      ),
    ]);
    const [row] = await db
      .select({ action: d.approvalRules.action, conditionJson: d.approvalRules.conditionJson })
      .from(d.approvalRules)
      .where(
        d.and(d.eq(d.approvalRules.agentId, chef), d.eq(d.approvalRules.toolName, 'xlsx_read')),
      );
    expect(row).toEqual({
      action: 'auto_approve',
      conditionJson: { workspacePath: 'D:/owner/work' },
    });
    expect(existsSync(journal)).toBe(false);
  });

  it('a stale journal: owner edits made after the kill survive recovery, a rule created since is never deleted, and both are named', async () => {
    const chef = applied.agents['chef']!.id;
    await applyScenarioTools(db, entityId, 'print', scenarioById('print')!.tools, journal);
    // After the kill, the owner changes Chef's run_command rule (the bench had blocked it)…
    await d.setRunCommandRuleRepo(db, entityId, chef, 'require_approval');
    // …and sets a rule on list_models, which had none before the bench blocked it.
    await d.setApprovalRuleRepo(db, entityId, {
      agentId: chef,
      toolName: 'list_models',
      action: 'require_approval',
      scope: 'agent',
      conditionJson: {},
    });
    const back = await recoverScenarioTools(db, journal);
    expect(back!.changed.map((c) => c.split(' of agent ')[0]).sort()).toEqual([
      'list_models',
      'run_command',
    ]);
    expect(back!.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(back!.writtenAt)).not.toBeNaN();
    const ruleOf = async (tool: string) =>
      (
        await db
          .select({ action: d.approvalRules.action })
          .from(d.approvalRules)
          .where(d.and(d.eq(d.approvalRules.agentId, chef), d.eq(d.approvalRules.toolName, tool)))
      )[0]?.action ?? null;
    expect(await ruleOf('run_command')).toBe('require_approval');
    expect(await ruleOf('list_models')).toBe('require_approval');
    // Everything else the bench had written is put back: xlsx_read has no rule again.
    expect(await ruleOf('xlsx_read')).toBeNull();
    expect(existsSync(journal)).toBe(false);
  });
});
