// campaign/reset.ts — entre deux essais, l'instance revient à son état de départ.
//
// Ce que la page « Nodal du banc » demande (17/10) : agents, mémoire et
// dossiers de travail remis à l'état de départ, pour que chaque essai parte
// du même point. Quatre gestes, dans cet ordre, et un refus plutôt qu'un essai
// joué sur un état inconnu :
//
//   1. Rien ne tourne dans les espaces de la campagne (`assertSpaceIdle`, la
//      même garde que l'espace banc) : remettre à zéro sous un job vivant
//      fausserait l'essai suivant ET celui-là.
//   2. L'équipe est celle de la configuration (`teamDrift`, lue par les
//      lecteurs du produit). Elle n'est PAS réécrite en silence : les droits
//      de la racine sont coupés, aucun agent ne peut modifier l'équipe, ses
//      skills ou ses connecteurs. Un écart serait donc un défaut de Nodal, et
//      le réécrire le cacherait (invariant #4) : la campagne s'arrête en le
//      nommant.
//   3. La mémoire : les souvenirs des deux espaces (`agent_memory`), ET leur
//      historique de runs, que l'outil `search_history` relit (la mémoire
//      « à la demande » de Nodal) ; avec eux, les tâches et projets que les
//      runs ont posés. Les résultats et les preuves de l'essai ont été
//      exportés AVANT (run.ts) : rien n'est perdu.
//   4. Les dossiers de travail : le dossier partagé de chaque espace et chaque
//      dossier attaché par la configuration sont vidés, puis reposés tels que
//      la configuration les décrit (un coffre Obsidian retrouve son
//      `.obsidian/`). Les fichiers de départ d'un scénario sont posés ensuite
//      par l'essai lui-même (`prepareTrial`).

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { assertSpaceIdle } from '../space/space';
import type { AppliedCampaign } from './apply';
import type { CampaignConfig, CampaignFolder } from './config';
import { teamDrift } from './team';

export interface ResetDeps {
  /** Le dossier des espaces de travail de l'instance (`workspacesRoot()` du produit). */
  readonly workspacesRoot: string;
  /** Le libellé du dossier partagé d'un espace (`SHARED_WORKSPACE_LABEL`). */
  readonly sharedLabel: string;
}

export interface ResetReport {
  readonly memories: number;
  readonly runs: number;
  readonly folders: string[];
}

/** Vide un dossier sans le supprimer, puis y pose ce que la configuration demande. */
export function reseedFolder(path: string, seed: CampaignFolder['seed']): void {
  mkdirSync(path, { recursive: true });
  for (const name of readdirSync(path)) {
    rmSync(join(path, name), { recursive: true, force: true, maxRetries: 3 });
  }
  if (seed === 'obsidian-vault') mkdirSync(join(path, '.obsidian'), { recursive: true });
}

/** Les dossiers que la remise à zéro repose, et comment. */
export function campaignFolders(
  applied: AppliedCampaign,
  deps: ResetDeps,
): Array<{ path: string; seed: CampaignFolder['seed'] }> {
  return [
    { path: join(deps.workspacesRoot, applied.tested.entityId, deps.sharedLabel), seed: 'empty' },
    { path: join(deps.workspacesRoot, applied.judge.entityId, deps.sharedLabel), seed: 'empty' },
    ...applied.folders.map((f) => ({ path: f.path, seed: f.seed })),
  ];
}

export async function resetBetweenTrials(
  db: AnyDrizzleDb,
  config: CampaignConfig,
  applied: AppliedCampaign,
  deps: ResetDeps,
): Promise<ResetReport> {
  const d = await import('@nodal-agents/db');
  const entityIds = [applied.tested.entityId, applied.judge.entityId];
  for (const id of entityIds) await assertSpaceIdle(db, id);

  const drift = await teamDrift(db, config, applied);
  if (drift.length > 0) {
    throw new Error(
      `campaign_team_drift: the team is no longer the configuration's, and no agent can change it ` +
        `(root grants are off). The campaign stops rather than hide it:\n  - ${drift.join('\n  - ')}`,
    );
  }

  const agentIds = Object.values(applied.agents).map((a) => a.id);
  const ofCampaign = d.or(
    d.inArray(d.agentMemory.entityId, entityIds),
    d.inArray(d.agentMemory.agentId, agentIds),
  );
  const [mem] = await db.select({ n: d.count() }).from(d.agentMemory).where(ofCampaign);
  await db.delete(d.agentMemory).where(ofCampaign);
  const [runs] = await db
    .select({ n: d.count() })
    .from(d.agentJobs)
    .where(d.inArray(d.agentJobs.entityId, entityIds));
  await db.delete(d.agentTasks).where(d.inArray(d.agentTasks.entityId, entityIds));
  await db.delete(d.codeProjects).where(d.inArray(d.codeProjects.entityId, entityIds));
  // Les jobs ensuite : appels d'outils, approbations, écritures constatées
  // partent avec eux (ON DELETE CASCADE) ; les appels de modèle restent,
  // détachés (SET NULL), ils ne sont lus par aucun agent.
  await db.delete(d.agentJobs).where(d.inArray(d.agentJobs.entityId, entityIds));

  const folders = campaignFolders(applied, deps);
  for (const f of folders) reseedFolder(f.path, f.seed);
  return {
    memories: Number(mem?.n ?? 0),
    runs: Number(runs?.n ?? 0),
    folders: folders.map((f) => f.path),
  };
}
