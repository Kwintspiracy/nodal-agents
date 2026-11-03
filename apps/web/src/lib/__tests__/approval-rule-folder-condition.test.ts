// approval-rule-folder-condition.test.ts — « Approve for this project » écrit
// une VRAIE ligne conditionnée, et depuis #917 elle vit À CÔTÉ de la ligne de
// l'outil : rien d'écrit sur l'une ne touche l'autre.
//
// Ce que ce fichier verrouille (issue #346, constats de Reviewer C passe 1) :
// une règle agent+outil peut porter `condition_json.workspacePath`, soit
// « approuvé, mais seulement quand l'agent travaille dans ce dossier ». Les
// surfaces qui écrivent une règle `auto_approve` ailleurs — les deux bascules
// Yolo, l'écran d'autonomie — ne connaissent pas cette condition et
// l'écrasaient : une permission posée comme « seulement ici » devenait valable
// partout, sans un mot.
//
// Assertions sur les LIGNES écrites, jamais sur des compteurs d'appels.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, approvalRules, agentWorkspaces, approvalRequests } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

const FOLDER = 'D:\\APPS\\NodalAI';

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  await testDb.insert(agentWorkspaces).values({
    agentId: seed.agentId,
    entityId: seed.entityId,
    label: 'nodal',
    path: FOLDER,
    position: 0,
  });
});

/** The row confined to the folder when there is one, else the tool's row. */
async function rowFor(toolName: string) {
  const rows = await rowsFor(toolName);
  return rows.find((r) => r.conditionFolder !== '') ?? rows[0];
}

async function rowsFor(toolName: string) {
  return testDb
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.entityId, seed.entityId), eq(approvalRules.toolName, toolName)));
}

async function poserRegleDossier(toolName: string) {
  const { setAgentApprovalRuleAction } = await import('../actions.ts');
  return setAgentApprovalRuleAction({
    agentId: seed.agentId,
    toolName,
    action: 'auto_approve',
    scope: 'agent',
    workspacePath: FOLDER,
  });
}

describe('la règle confinée à un dossier @cap:approuver-une-action/moteur', () => {
  it('écrit condition_json avec le chemin, sans migration', async () => {
    expect((await poserRegleDossier('mcp_x__read')).ok).toBe(true);
    const row = await rowFor('mcp_x__read');
    expect(row!.action).toBe('auto_approve');
    expect(row!.agentId).toBe(seed.agentId);
    expect(row!.conditionJson).toEqual({ workspacePath: FOLDER });
  });

  it('refuse un dossier qui n’est pas attaché à cet agent', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__other',
      action: 'auto_approve',
      scope: 'agent',
      workspacePath: 'D:\\APPS\\PasAMoi',
    });
    expect(r.ok).toBe(false);
    expect(await rowFor('mcp_x__other')).toBeUndefined();
  });

  it('refuse une condition sur une règle Everyone', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__everyone',
      action: 'auto_approve',
      scope: 'entity',
      workspacePath: FOLDER,
    });
    expect(r.ok).toBe(false);
    expect(await rowFor('mcp_x__everyone')).toBeUndefined();
  });

  it('la ligne de l’outil et sa ligne de dossier COEXISTENT : changer l’une ne touche pas l’autre (#917)', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('mcp_x__restrict')).ok).toBe(true);
    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__restrict',
      action: 'require_approval',
      scope: 'agent',
    });
    expect(r.ok).toBe(true);
    const rows = await rowsFor('mcp_x__restrict');
    expect(rows.map((x) => `${x.action}@${x.conditionFolder}`).sort()).toEqual([
      `auto_approve@${FOLDER}`,
      'require_approval@',
    ]);
  });

  it('un changement qui garde le dossier le GARDE vraiment', async () => {
    // Ce que la ligne « Change » de la carte envoie : la même condition.
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('mcp_x__keep')).ok).toBe(true);
    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__keep',
      action: 'block',
      scope: 'agent',
      workspacePath: FOLDER,
    });
    expect(r.ok).toBe(true);
    const row = await rowFor('mcp_x__keep');
    expect(row!.action).toBe('block');
    expect(row!.conditionJson).toEqual({ workspacePath: FOLDER });
  });
});

describe('une permission partout ne touche jamais une ligne de dossier (#917) @cap:approuver-une-action/moteur', () => {
  // Avant #917, la ligne de dossier et la permission partout étaient la MÊME
  // ligne : écrire l'une effaçait l'autre, d'où un garde qui refusait. Elles
  // coexistent : la permission partout est la ligne de l'outil, la ligne de
  // dossier reste ce que le propriétaire a posé pour ce dossier.
  it('une autorisation GLOBALE sur le même outil écrit la ligne de l’outil, et laisse le dossier', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('mcp_x__widen')).ok).toBe(true);
    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__widen',
      action: 'block',
      scope: 'agent',
    });
    expect(r.ok).toBe(true);
    const rows = await rowsFor('mcp_x__widen');
    expect(rows.map((x) => `${x.action}@${x.conditionFolder}`).sort()).toEqual([
      `auto_approve@${FOLDER}`,
      'block@',
    ]);
  });

  it('Run commands et la bascule code_task écrivent la ligne de l’outil, jamais celle du dossier', async () => {
    const { setRunCommandRuleAction, setCodeTaskYoloAction } = await import('../actions.ts');
    expect((await poserRegleDossier('run_command')).ok).toBe(true);
    expect((await setRunCommandRuleAction({ agentId: seed.agentId, action: 'block' })).ok).toBe(
      true,
    );
    expect(
      (await rowsFor('run_command')).map((x) => `${x.action}@${x.conditionFolder}`).sort(),
    ).toEqual([`auto_approve@${FOLDER}`, 'block@']);

    expect((await poserRegleDossier('code_task')).ok).toBe(true);
    // Off is Ask first: the row stays, it is never deleted (#917).
    expect((await setCodeTaskYoloAction({ agentId: seed.agentId, enabled: false })).ok).toBe(true);
    expect(
      (await rowsFor('code_task')).map((x) => `${x.action}@${x.conditionFolder}`).sort(),
    ).toEqual([`auto_approve@${FOLDER}`, 'require_approval@']);
  });

  it('la ligne d’un outil ne se retire pas : sans elle, la porte refuserait l’outil', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__stays',
      action: 'block',
      scope: 'agent',
    });
    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__stays',
      action: null,
      scope: 'agent',
    });
    expect(r.ok).toBe(false);
    expect((await rowFor('mcp_x__stays'))!.action).toBe('block');
  });
});

describe('la chaîne d’une demande SANS agent @cap:approuver-une-action/moteur', () => {
  it('ne montre aucune ligne : une règle pour tous les agents ne décide d’aucun appel (#917)', async () => {
    // Une demande dont la ligne porte `agent_id` NULL (agent supprimé, job
    // système). Depuis #917 la porte n'obéit qu'à la ligne d'un agent ; une
    // règle « Everyone » est un modèle. La carte ne montre donc rien qui
    // n'ait décidé, et le dit.
    const { setAgentApprovalRuleAction, listApprovalsAction } = await import('../actions.ts');
    expect(
      (
        await setAgentApprovalRuleAction({
          agentId: seed.agentId,
          toolName: 'mcp_orphan__read',
          action: 'require_approval',
          scope: 'entity',
        })
      ).ok,
    ).toBe(true);

    const [ligne] = await testDb
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: null,
        toolName: 'mcp_orphan__read',
        toolInput: {},
        status: 'pending',
      })
      .returning();

    const lecture = await listApprovalsAction({ status: 'pending', jobIds: [seed.jobId] });
    expect(lecture.ok).toBe(true);
    if (!lecture.ok) return;
    const carte = lecture.data.find((r) => r.id === ligne!.id);
    expect(carte).toBeDefined();
    expect(carte!.ruleChain).toEqual([]);
  });

  it('pour un outil qui remplace un fichier partagé, la carte montre aussi le réglage, gagnant quand l’outil est Autonomous', async () => {
    const { setAgentApprovalRuleAction, listApprovalsAction } = await import('../actions.ts');
    for (const [toolName, action] of [
      ['file_move', 'auto_approve'],
      ['setting:replace_shared_file', 'require_approval'],
    ] as const) {
      expect(
        (
          await setAgentApprovalRuleAction({
            agentId: seed.agentId,
            toolName,
            action,
            scope: 'agent',
          })
        ).ok,
      ).toBe(true);
    }
    const [ligne] = await testDb
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'file_move',
        toolInput: {},
        status: 'pending',
      })
      .returning();
    const lecture = await listApprovalsAction({ status: 'pending', jobIds: [seed.jobId] });
    if (!lecture.ok) throw new Error(lecture.message);
    const carte = lecture.data.find((r) => r.id === ligne!.id);
    expect(
      carte!.ruleChain.map((r) => ({ tool: r.toolName, action: r.action, wins: r.wins })),
    ).toEqual([
      { tool: 'file_move', action: 'auto_approve', wins: false },
      { tool: 'setting:replace_shared_file', action: 'require_approval', wins: true },
    ]);
  });
});

describe("l'onglet Approvals reçoit la condition, pas seulement l'action @cap:regler-autonomie/moteur", () => {
  // Issue #361 : `listAgentApprovalRulesAction` ne renvoyait que
  // (id, toolName, action). Une règle « approuvée seulement dans Dev »
  // arrivait donc à l'écran indiscernable d'une permission globale.

  async function lireRegle(toolName: string) {
    const { listAgentApprovalRulesAction } = await import('../actions.ts');
    const r = await listAgentApprovalRulesAction(seed.agentId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.message);
    return r.data.find((x) => x.toolName === toolName);
  }

  it('rend la condition et le LIBELLÉ du dossier, pas son chemin', async () => {
    expect((await poserRegleDossier('mcp_x__lu')).ok).toBe(true);
    const regle = await lireRegle('mcp_x__lu');
    expect(regle).toBeDefined();
    expect(regle!.conditionJson).toEqual({ workspacePath: FOLDER });
    // « nodal » est le label du dossier dans agent_workspaces, pose au beforeAll.
    expect(regle!.workspaceLabel).toBe('nodal');
  });

  it("rend null sur une règle sans condition, et rien d'autre ne change", async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect(
      (
        await setAgentApprovalRuleAction({
          agentId: seed.agentId,
          toolName: 'mcp_x__sans_condition',
          action: 'block',
          scope: 'agent',
        })
      ).ok,
    ).toBe(true);

    const regle = await lireRegle('mcp_x__sans_condition');
    expect(regle!.action).toBe('block');
    expect(regle!.conditionJson).toEqual({});
    expect(regle!.workspaceLabel).toBeNull();
  });

  it('tranche entre deux libellés visant le MÊME dossier, toujours de la même façon', async () => {
    // `agent_workspaces` n'est unique que sur (agent_id, label) : deux
    // libellés peuvent viser un seul chemin. Sans ordre total, le libellé
    // affiché changeait d'une lecture à l'autre (revue Reviewer C, passes 2
    // et 3). C'est le premier dans l'ordre du propriétaire, puis le libellé.
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    const PARTAGE = 'D:\APPS\Partage';
    await testDb.insert(agentWorkspaces).values([
      {
        agentId: seed.agentId,
        entityId: seed.entityId,
        label: 'second',
        path: PARTAGE,
        position: 7,
      },
      {
        agentId: seed.agentId,
        entityId: seed.entityId,
        label: 'premier',
        path: PARTAGE,
        position: 2,
      },
    ]);
    expect(
      (
        await setAgentApprovalRuleAction({
          agentId: seed.agentId,
          toolName: 'mcp_x__partage',
          action: 'auto_approve',
          scope: 'agent',
          workspacePath: PARTAGE,
        })
      ).ok,
    ).toBe(true);

    const regle = await lireRegle('mcp_x__partage');
    expect(regle!.workspaceLabel).toBe('premier');
  });

  it('nomme le CHEMIN quand le dossier a été détaché de l’agent', async () => {
    // Une règle qui survit au détachement de son dossier ne vaut plus nulle
    // part. Se taire la ferait lire « partout » : le pire des deux sens.
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    const AUTRE = 'D:\APPS\Detache';
    await testDb.insert(agentWorkspaces).values({
      agentId: seed.agentId,
      entityId: seed.entityId,
      label: 'detache',
      path: AUTRE,
      position: 1,
    });
    expect(
      (
        await setAgentApprovalRuleAction({
          agentId: seed.agentId,
          toolName: 'mcp_x__orphelin',
          action: 'auto_approve',
          scope: 'agent',
          workspacePath: AUTRE,
        })
      ).ok,
    ).toBe(true);
    await testDb.delete(agentWorkspaces).where(eq(agentWorkspaces.path, AUTRE));

    const regle = await lireRegle('mcp_x__orphelin');
    expect(regle!.conditionJson).toEqual({ workspacePath: AUTRE });
    expect(regle!.workspaceLabel).toBe(AUTRE);
  });
});
