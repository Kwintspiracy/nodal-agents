// approval-rule-folder-condition.test.ts — « Approve for this project » écrit
// une VRAIE ligne conditionnée, et rien ne peut l'élargir en silence.
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

async function rowFor(toolName: string) {
  const [row] = await testDb
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.entityId, seed.entityId), eq(approvalRules.toolName, toolName)));
  return row;
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

  it('un changement qui RESTREINT retire la condition, et c’est voulu', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('mcp_x__restrict')).ok).toBe(true);
    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__restrict',
      action: 'require_approval',
      scope: 'agent',
    });
    expect(r.ok).toBe(true);
    const row = await rowFor('mcp_x__restrict');
    expect(row!.action).toBe('require_approval');
    expect(row!.conditionJson).toEqual({});
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

describe('rien n’élargit une règle de dossier en silence @cap:approuver-une-action/moteur', () => {
  it('une autorisation GLOBALE sur le même outil est refusée, et nomme le dossier', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('mcp_x__widen')).ok).toBe(true);

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'mcp_x__widen',
      action: 'auto_approve',
      scope: 'agent',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(FOLDER);

    // LA LIGNE N'A PAS BOUGÉ : le refus n'est pas qu'un message.
    const row = await rowFor('mcp_x__widen');
    expect(row!.conditionJson).toEqual({ workspacePath: FOLDER });
  });

  it('la bascule Yolo de run_command est refusée plutôt que d’écraser le dossier', async () => {
    const { setAgentApprovalRuleAction, setRunCommandRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('run_command')).ok).toBe(true);

    const r = await setRunCommandRuleAction({ agentId: seed.agentId, action: 'auto_approve' });
    expect(r.ok).toBe(false);

    const row = await rowFor('run_command');
    expect(row!.conditionJson).toEqual({ workspacePath: FOLDER });
    expect(row!.action).toBe('auto_approve');

    // Et l'éteindre reste possible : cela ne fait que retirer une permission.
    expect((await setRunCommandRuleAction({ agentId: seed.agentId, action: null })).ok).toBe(true);
    expect(await rowFor('run_command')).toBeUndefined();
    void setAgentApprovalRuleAction;
  });

  it('la bascule Yolo de code_task est refusée de la même façon', async () => {
    const { setCodeTaskYoloAction } = await import('../actions.ts');
    expect((await poserRegleDossier('code_task')).ok).toBe(true);
    expect((await setCodeTaskYoloAction({ agentId: seed.agentId, enabled: true })).ok).toBe(false);
    expect((await rowFor('code_task'))!.conditionJson).toEqual({ workspacePath: FOLDER });
  });

  // Issue #401. L'onglet Connectors écrit une règle sur le MOTIF du serveur
  // (`<prefix>__*`) au moment où le propriétaire dit « faire confiance ». Ce
  // motif est une règle comme une autre : s'il porte déjà une limite de
  // dossier, la confiance la remplacerait par une permission valable partout.
  it('le motif MCP de l’onglet Connectors est refusé quand il porte une limite de dossier', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('cogni_cortex__*')).ok).toBe(true);

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'cogni_cortex__*',
      action: 'auto_approve',
      scope: 'agent',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(FOLDER);

    const row = await rowFor('cogni_cortex__*');
    expect(row!.conditionJson).toEqual({ workspacePath: FOLDER });
  });

  it('le drapeau explicite, lui, retire la condition et laisse une règle sans dossier', async () => {
    // `confirmWidening` n'est envoyé que par le chemin qui a MONTRÉ la perte
    // en nommant le dossier et reçu un oui. Ce que le garde protégeait, c'est
    // le silence ; ici il n'y en a plus, et la ligne doit donc bouger.
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('cogni_cortex__confirme')).ok).toBe(true);

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'cogni_cortex__confirme',
      action: 'auto_approve',
      scope: 'agent',
      confirmWidening: true,
    });
    expect(r.ok).toBe(true);

    const row = await rowFor('cogni_cortex__confirme');
    expect(row!.action).toBe('auto_approve');
    expect(row!.conditionJson).toEqual({});
  });

  it('le drapeau à false ne vaut pas accord', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');
    expect((await poserRegleDossier('cogni_cortex__faux')).ok).toBe(true);

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'cogni_cortex__faux',
      action: 'auto_approve',
      scope: 'agent',
      confirmWidening: false,
    });
    expect(r.ok).toBe(false);
    expect((await rowFor('cogni_cortex__faux'))!.conditionJson).toEqual({
      workspacePath: FOLDER,
    });
  });
});

describe('la chaîne d’une demande SANS agent @cap:approuver-une-action/moteur', () => {
  it('lit quand même les règles Everyone, au lieu de dire « Tool default »', async () => {
    // Une demande dont la ligne porte `agent_id` NULL (agent supprimé, job
    // système) affichait « Tool default » comme gagnante alors qu'une règle
    // d'entité décidait : le mensonge même que #346 ferme (Reviewer C, passe 1).
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
    expect(
      carte!.ruleChain.map((r) => ({ tool: r.toolName, scope: r.scope, wins: r.wins })),
    ).toEqual([{ tool: 'mcp_orphan__read', scope: 'entity', wins: true }]);
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
