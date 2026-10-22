// scenario-tools.test.ts — la liste fermée des outils d'un scénario, posée sur l'instance d'une campagne (décision 1B).
//
// Sur l'instance réellement appliquée (PGlite, semée comme `up` la sème) : ce
// qu'un job de chaque agent pourrait APPELER, lu par les lecteurs du produit
// (`computeAgentToolNames`, les outils de délégation) et jugé par la règle de
// l'exécution (`matchApprovalRule`), avant, pendant et après la liste.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { matchApprovalRule } from '@nodal-agents/tools';
import { SCENARIOS, scenarioById } from '../../workflows/scenarios';
import {
  agentToolNames,
  applyScenarioTools,
  parseScenarioTools,
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

afterAll(() => home.restore());

beforeEach(async () => {
  ({ db } = await freshInstanceDb());
  const scratch = mkdtempSync(join(tmpdir(), 'scenario-tools-'));
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
  return (await agentToolNames(db, entityId, agentId)).filter(
    (t) => matchApprovalRule(rules as never, t, agentId, entityId)?.action !== 'block',
  );
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
    const t = await applyScenarioTools(db, entityId, 'print', scenarioById('print')!.tools);
    try {
      expect(await callable('chef')).toEqual([
        'ask_user',
        'assign_chercheur',
        'assign_imageur',
        'bench_printer__get_print_request',
        'bench_printer__request_print',
        'file_edit',
        'file_list',
        'file_read',
        'file_search',
        'file_write',
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
    const t = await applyScenarioTools(db, entityId, 'print', scenarioById('print')!.tools);
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
    const print = await applyScenarioTools(db, entityId, 'print', scenarioById('print')!.tools);
    await print.restore();
    const code = await applyScenarioTools(db, entityId, 'code', scenarioById('code')!.tools);
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
    const excel = await applyScenarioTools(db, entityId, 'file', scenarioById('file')!.tools);
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
      applyScenarioTools(db, entityId, 'x', ['return_result', 'not_a_tool']),
    ).rejects.toThrow('scenario_tools_invalid');
    expect(await rules()).toEqual(before);
  });
});
