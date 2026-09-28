// own-job-row.test.ts — toute écriture d'agent_jobs faite par le code d'un run
// passe par `ownJobRow` (#566, revue Nodal de #575, passe 3).
//
// CE QUI S'EST PASSÉ. La règle « aucune écriture du run sur SA ligne hors de sa
// prise » était portée par cinq fonctions de job/state.ts. Trois écritures lui
// échappaient : `dashboard_publish` (result), l'intention de vérification
// (verification_skipped_surfaces) et le prompt système en préparation. Un run
// fauché pendant l'outil, repris par une autre prise qui termine avec SON
// résultat : l'UPDATE périmé écrasait ce résultat.
//
// LA FORME. La règle n'est pas une liste de fonctions : c'est un point de
// passage, `ownJobRow` (packages/db, repos/run-claim.ts), dans le WHERE de
// toute écriture d'`agent_jobs` du code qui tourne dans le scope d'un run —
// les outils, la boucle, le runtime CLI, l'orchestration. Ce test lit ce code
// et refuse toute écriture qui ne le porte pas, hors d'une liste blanche
// NOMMÉE : chaque exception porte, au-dessus de son écriture, le commentaire
// `agent_jobs-write: <clé>`, et la clé doit figurer ici avec sa raison. Une
// clé inutilisée est refusée aussi : la liste ne peut pas vieillir en silence.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Le code qui tourne dans le scope d'un run. */
const RACINES = [
  'packages/tools/src',
  'packages/orchestration/src',
  'apps/runner/src/job',
  'apps/runner/src/cli-runtime',
];

/** Les écritures qui ne passent pas par `ownJobRow`, et pourquoi. */
const LISTE_BLANCHE: Record<string, string> = {
  claim:
    "claimJob : LA prise elle-même (pending → processing, prise suivante) — la condition « sous ma prise » n'existe pas encore.",
  heartbeat:
    'touchJob : porte EXPLICITEMENT la prise que le battement tient (heldBy) ; son intervalle est partagé entre reprises imbriquées, il ne lit pas le scope.',
  'delegation-parent':
    'handleDelegation : suspend le parent sous sa prise EXPLICITE (parentClaimGeneration, paramètre obligatoire) et `processing`.',
  'orphan-child':
    "handleDelegation : annule l'enfant qu'il vient de créer quand le parent n'est plus délégable — la ligne d'un AUTRE job, gardée non terminale.",
  'delegation-resume':
    "resumeDelegated : remet le parent en file — la ligne d'un AUTRE job (ou du run qui l'appelle, déjà rendu), gardée sur `awaiting_delegation`.",
  'parent-cascade':
    "maybeResumeParent : annule le parent d'un enfant annulé — la ligne d'un AUTRE job, gardée sur `awaiting_delegation`.",
  'project-record':
    'attach.ts : `project_id`, posé UNE fois (WHERE project_id IS NULL) — un fait sur ce que le job a produit, vrai quel que soit le run qui le tient.',
  'chain-root':
    "finalize.ts : l'échéance de vérification de la RACINE de la chaîne (souvent un autre job), dans la transaction de finalisation qui la tient FOR UPDATE.",
};

function fichiers(dir: string): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) {
      if (nom === 'tests' || nom === '__tests__' || nom === 'node_modules') continue;
      out.push(...fichiers(p));
    } else if (nom.endsWith('.ts') && !nom.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

interface Ecriture {
  fichier: string;
  ligne: number;
  cle: string | null;
  passeParOwnJobRow: boolean;
}

function ecritures(): Ecriture[] {
  const out: Ecriture[] = [];
  for (const racine of RACINES) {
    for (const f of fichiers(join(REPO, racine))) {
      const src = readFileSync(f, 'utf8');
      const lignes = src.split('\n');
      // Les commentaires de fin de ligne sont blanchis (même longueur) : un `;`
      // dans un commentaire ne doit pas couper l'instruction qu'on lit.
      const sansCommentaires = src.replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
      let i = src.indexOf('.update(agentJobs)');
      while (i >= 0) {
        const fin = sansCommentaires.indexOf(';', i);
        const instruction = src.slice(i, fin < 0 ? undefined : fin);
        const ligne = src.slice(0, i).split('\n').length;
        const avant = lignes.slice(Math.max(0, ligne - 8), ligne).join('\n');
        const tag = /agent_jobs-write:\s*([a-z-]+)/.exec(avant);
        out.push({
          fichier: relative(REPO, f).split('\\').join('/'),
          ligne,
          cle: tag?.[1] ?? null,
          passeParOwnJobRow: instruction.includes('ownJobRow('),
        });
        i = src.indexOf('.update(agentJobs)', i + 1);
      }
    }
  }
  return out;
}

describe('every agent_jobs write of run-scoped code goes through ownJobRow (#566) @cap:suivre-execution/moteur', () => {
  const toutes = ecritures();

  it('finds the writes it is about (the scan is not empty)', () => {
    expect(toutes.length).toBeGreaterThan(15);
  });

  it('no write bypasses ownJobRow outside the named allowlist', () => {
    const fautives = toutes.filter(
      (e) => !e.passeParOwnJobRow && (e.cle === null || !(e.cle in LISTE_BLANCHE)),
    );
    expect(fautives.map((e) => `${e.fichier}:${String(e.ligne)}`)).toEqual([]);
  });

  it('every allowlist key is used (no stale exception)', () => {
    const utilisees = toutes
      .filter((e) => !e.passeParOwnJobRow && e.cle !== null)
      .map((e) => e.cle);
    expect([...new Set(utilisees)].sort()).toEqual(Object.keys(LISTE_BLANCHE).sort());
  });
});
