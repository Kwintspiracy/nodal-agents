// campaign/export.ts — ce qu'une campagne laisse dans le banc avant d'être effacée.
//
// La ligne de chaque essai va, comme toujours, dans apps/qa/data/workflows.ndjson
// (session.ts), avec l'id de la campagne et l'empreinte de la configuration.
// Les PREUVES vont à côté, une fois par essai, AVANT la remise à zéro qui les
// effacerait de l'instance : la ligne, les faits de l'arbre lus en base
// (jobs, appels d'outils et de modèles, approbations), et une copie des
// dossiers de travail tels que l'essai les a laissés. À la fin, le résumé de
// la campagne. Le dossier est hors du suivi de git (`bench/campaigns/`) : des
// classeurs et des rapports, pas du code.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { REPO } from '../workflows/paths';
import { redactHome } from '../workflows/redact';
import type { TreeFacts } from '../workflows/facts';
import type { TrialLine } from '../workflows/types';

/** Où les campagnes exportent leurs preuves, dans le dépôt qui les lance. */
export const EVIDENCE_ROOT = join(REPO, 'bench', 'campaigns');

export function campaignEvidenceDir(campaignId: string, root: string = EVIDENCE_ROOT): string {
  return join(root, campaignId);
}

/** Le dossier d'un essai : son rang dans la campagne, puis son scénario. */
export function trialEvidenceDir(campaignDir: string, index: number, scenario: string): string {
  return join(campaignDir, `${String(index).padStart(3, '0')}-${scenario}`);
}

export interface TrialEvidence {
  readonly line: TrialLine;
  /** Les faits de l'arbre ; null pour un essai sauté, qui n'a lancé aucun job. */
  readonly facts: TreeFacts | null;
  /** Les dossiers de travail de la campagne, copiés tels quels. */
  readonly folders: readonly string[];
}

/** Écrit les preuves d'un essai ; rend son dossier. */
export function exportTrial(campaignDir: string, index: number, e: TrialEvidence): string {
  const dir = trialEvidenceDir(campaignDir, index, e.line.scenario);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'line.json'), `${JSON.stringify(e.line, null, 2)}\n`, 'utf8');
  if (e.facts) {
    writeFileSync(
      join(dir, 'facts.json'),
      `${redactHome(JSON.stringify(e.facts, null, 1))}\n`,
      'utf8',
    );
  }
  e.folders.forEach((folder, i) => {
    if (!existsSync(folder)) return;
    cpSync(folder, join(dir, 'files', `${i + 1}-${basename(folder)}`), { recursive: true });
  });
  return dir;
}

/** Le résumé de la campagne, écrit à sa fin, quelle qu'elle soit. */
export function exportSummary(campaignDir: string, summary: Record<string, unknown>): string {
  mkdirSync(campaignDir, { recursive: true });
  const file = join(campaignDir, 'campaign.json');
  writeFileSync(file, `${redactHome(JSON.stringify(summary, null, 2))}\n`, 'utf8');
  return file;
}

/**
 * Les journaux de l'instance (runner, web, Postgres, lanceur), copiés AVANT
 * l'effacement : sans eux, une campagne qui échoue au démarrage ne laisse que
 * son message. Rend le dossier, ou null quand l'instance n'en a écrit aucun.
 */
export function exportInstanceLogs(campaignDir: string, instanceHome: string): string | null {
  const logs = join(instanceHome, 'logs');
  if (!existsSync(logs)) return null;
  const dir = join(campaignDir, 'instance-logs');
  cpSync(logs, dir, { recursive: true });
  return dir;
}
