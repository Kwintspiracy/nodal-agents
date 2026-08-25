// rules-rollback.test.ts — capturer puis restaurer une règle d'approbation.
//
// Le bouton « 🔁 Toujours autoriser » d'une carte Telegram fait DEUX choses :
// il pose une règle auto_approve, puis il résout la demande en cours. Si la
// seconde échoue, la règle posée reste — l'agent se retrouve autorisé pour de
// bon alors que l'utilisateur n'a rien obtenu. D'où la capture d'avant et la
// restauration.
//
// Le cas qui compte est celui où il n'y avait AUCUNE règle : restaurer, là,
// veut dire SUPPRIMER la ligne — pas y réécrire une valeur. Une restauration
// qui écrirait `require_approval` laisserait une règle explicite fantôme, et
// une règle explicite ne se comporte pas comme une absence de règle : elle
// gagne sur la politique du workspace.
//
// Assertions sur les lignes réelles de approval_rules, jamais sur des appels.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, approvalRules } from '@nodal-agents/db';
import {
  getApprovalRule,
  restoreApprovalRule,
  upsertAutoApproveRule,
} from '../../approvals/rules.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

const TOOL = 'run_command';

function target() {
  return { entityId: seed.entityId, agentId: seed.agentId, toolName: TOOL };
}

async function lignes() {
  return db
    .select({ action: approvalRules.action })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, seed.entityId),
        eq(approvalRules.agentId, seed.agentId),
        eq(approvalRules.toolName, TOOL),
      ),
    );
}

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

describe('capture + restauration d’une règle d’approbation', () => {
  it('aucune règle avant → la restauration SUPPRIME la ligne, elle n’en réécrit pas une', async () => {
    const avant = await getApprovalRule(db, target());
    expect(avant, 'le test suppose qu’aucune règle n’existe au départ').toBeNull();

    await upsertAutoApproveRule(db, target());
    expect(await lignes()).toHaveLength(1);
    expect((await lignes())[0]!.action).toBe('auto_approve');

    // La résolution a échoué : on remet l'état d'avant.
    await restoreApprovalRule(db, { ...target(), previousAction: avant });

    expect(await lignes(), 'une règle fantôme a survécu au rollback').toHaveLength(0);
    expect(await getApprovalRule(db, target())).toBeNull();
  });

  it('une règle existait → la restauration rend son ACTION d’origine', async () => {
    await db.insert(approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: TOOL,
      action: 'block',
    });

    const avant = await getApprovalRule(db, target());
    expect(avant).toBe('block');

    await upsertAutoApproveRule(db, target());
    expect((await lignes())[0]!.action).toBe('auto_approve');

    await restoreApprovalRule(db, { ...target(), previousAction: avant });

    const apres = await lignes();
    expect(apres, 'la ligne d’origine a été supprimée au lieu d’être restaurée').toHaveLength(1);
    expect(apres[0]!.action, 'un blocage explicite a été perdu').toBe('block');

    await db
      .delete(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, seed.entityId),
          eq(approvalRules.agentId, seed.agentId),
          eq(approvalRules.toolName, TOOL),
        ),
      );
  });

  it('une règle posée ENTRE-TEMPS par quelqu’un d’autre n’est pas effacée', async () => {
    // Course réelle (revue du 25/08) : la carte capture « aucune règle », pose
    // son auto_approve, puis la résolution échoue. Entre les deux, le
    // propriétaire pose un `block` au dashboard sur le MÊME triplet. Un
    // rollback aveugle supprimait ce blocage en silence : annuler son propre
    // geste est une chose, annuler celui de quelqu'un d'autre en est une autre.
    const avant = await getApprovalRule(db, target());
    expect(avant).toBeNull();

    await upsertAutoApproveRule(db, target());

    // Le dashboard écrase le triplet pendant la fenêtre.
    await db
      .update(approvalRules)
      .set({ action: 'block' })
      .where(
        and(
          eq(approvalRules.entityId, seed.entityId),
          eq(approvalRules.agentId, seed.agentId),
          eq(approvalRules.toolName, TOOL),
        ),
      );

    // La carte échoue et tente son rollback avec l'état qu'elle avait capturé.
    await restoreApprovalRule(db, { ...target(), previousAction: avant });

    const apres = await lignes();
    expect(apres, 'le blocage posé au dashboard a été effacé par le rollback').toHaveLength(1);
    expect(apres[0]!.action).toBe('block');
  });
});
