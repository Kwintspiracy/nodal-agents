// depot.test.mjs — le CÂBLAGE, pas seulement les fonctions.
//
// `lib.test.mjs` éprouve chaque jugement du portail isolément. Il ne voyait
// rien du branchement, et trois oublis de branchement le laissaient entièrement
// vert tout en rendant les faux verts que ce lot existe pour tuer (revue de la
// PR #113, 2e passe) :
//
//   - ne plus passer la liste des parcours au parseur : un balayage ne joue
//     plus rien, et trente parcours deviennent « jamais joués » ;
//   - ne plus reporter « illisible » du parseur jusqu'aux lignes rendues : une
//     panne de lecture repasse pour un dépôt plein de parcours morts ;
//   - ne plus retirer les commentaires du texte d'un workflow : une phrase qui
//     dit « pnpm bench » redevient une étape exécutée, et l'alerte « aucun
//     workflow ne lance le banc » se tait. (Pour les PARCOURS, cet appel-ci
//     n'est pas la seule défense : `parcoursDunWorkflow` retire les
//     commentaires lui-même.) Une phrase d'explication redevient une exécution.
//
// Chaque test ci-dessous tourne sur un FAUX dépôt, monté en dossier temporaire,
// et rougit sur la mutation qu'il nomme.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciDuDepot, parcoursDuDepot } from './depot.mjs';

let racine;

/** Les fichiers « suivis par git » de ce faux dépôt. */
const FICHIERS = [
  '.github/workflows/nuit.yml',
  '.github/workflows/pr.yml',
  'apps/web/tests/e2e/a.spec.ts',
  'apps/web/tests/e2e/b.spec.ts',
  'apps/web/tests/e2e/c.spec.ts',
];
const TOUS = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'];

/** Un parcours plausible : une phrase d'intention, puis un cas. */
const specFactice = (quoi) =>
  `/**\n * ${quoi}\n */\nimport { test } from '@playwright/test';\n\ntest('${quoi}', async () => {});\n`;

/** La mesure nocturne : elle BALAIE le dossier, en excluant \`c.spec.ts\`. */
const NUIT = `name: Nightly
on:
  schedule:
    - cron: '17 3 * * *'
jobs:
  mesure:
    runs-on: ubuntu-latest
    steps:
      # Historique : tests/e2e/b.spec.ts demandait un serveur local, il ne le
      # demande plus. Cette phrase ne joue rien — elle EXPLIQUE.
      - name: Every journey
        run: |
          mapfile -t specs < <(ls tests/e2e/*.spec.ts | grep -v "c.spec.ts")
          npx playwright test "\${specs[@]}"
`;

/**
 * La porte de chaque PR : elle NOMME un seul parcours — et elle en cite un
 * second dans un COMMENTAIRE, pour dire pourquoi elle ne le joue pas. C'est
 * cette phrase-là qui, lue comme du YAML, déclarait un parcours joué.
 */
const PR = `name: CI
on:
  pull_request:
jobs:
  e2e-smoke:
    runs-on: ubuntu-latest
    steps:
      # Deliberately NOT tests/e2e/c.spec.ts here: it needs a live provider.
      # The bench (pnpm bench) and --coverage run in the nightly job, not here.
      - run: npx playwright test tests/e2e/a.spec.ts
`;

function ecrire(fichiers) {
  for (const [chemin, contenu] of Object.entries(fichiers)) {
    const complet = join(racine, chemin);
    mkdirSync(join(complet, '..'), { recursive: true });
    writeFileSync(complet, contenu, 'utf8');
  }
}

beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), 'qa-depot-'));
  ecrire({
    '.github/workflows/nuit.yml': NUIT,
    '.github/workflows/pr.yml': PR,
    'apps/web/tests/e2e/a.spec.ts': specFactice('the smoke journey'),
    'apps/web/tests/e2e/b.spec.ts': specFactice('the second journey'),
    'apps/web/tests/e2e/c.spec.ts': specFactice('the excluded journey'),
  });
});

afterAll(() => {
  rmSync(racine, { recursive: true, force: true });
});

const lire = () => {
  const workflows = ciDuDepot(FICHIERS, TOUS, racine);
  return { workflows, parcours: parcoursDuDepot(FICHIERS, workflows, { racine }) };
};
const par = (parcours, nom) => parcours.find((p) => p.nom === nom);

describe('le câblage du portail — un faux dépôt, lu de bout en bout', () => {
  it('le balayage nocturne joue ce qu’il balaie, la PR ce qu’elle nomme', () => {
    // MUTATION : ne plus passer `tousLesParcours` au parseur. Le balayage ne
    // rend alors plus aucun nom, et ces trois assertions tombent.
    const { parcours } = lire();
    expect(par(parcours, 'a.spec.ts').cadence).toBe('every pull request');
    expect(par(parcours, 'b.spec.ts').cadence).toBe('every night');
    expect(par(parcours, 'b.spec.ts').jouParLaCi).toBe(true);
  });

  it('le parcours EXCLU du balayage n’est joué par personne', () => {
    const { parcours } = lire();
    expect(par(parcours, 'c.spec.ts').jouParLaCi).toBe(false);
    expect(par(parcours, 'c.spec.ts').cadence).toBe(null);
  });

  it('un parcours nommé dans un COMMENTAIRE n’est pas joué pour autant', () => {
    // `nuit.yml` parle de `tests/e2e/b.spec.ts` dans un commentaire, et `pr.yml`
    // de `c.spec.ts`. Aucune des deux phrases ne joue quoi que ce soit : `b` est
    // joué par le BALAYAGE, `c` par personne.
    const { workflows, parcours } = lire();
    const pr = workflows.find((w) => w.fichier.endsWith('pr.yml'));
    expect(pr.specsNommees).toEqual(['a.spec.ts']);
    // Le balayage exclut `c.spec.ts` ; rien ne doit le rattraper par une phrase.
    expect(par(parcours, 'c.spec.ts').jouParLaCi).toBe(false);
  });

  it('l’exclusion à guillemets doubles est bien LUE, et le workflow reste lisible', () => {
    const { workflows } = lire();
    const nuit = workflows.find((w) => w.fichier.endsWith('nuit.yml'));
    expect(nuit.parcoursExclus).toEqual(['c.spec.ts']);
    expect(nuit.parcoursIllisibles).toBe(false);
    expect(nuit.balayeLesParcours).toBe(true);
  });

  it('un workflow ILLISIBLE se propage jusqu’aux lignes, qui cessent d’être rouges', () => {
    // MUTATION : oublier `parcoursIllisibles` dans le workflow rendu, ou
    // `ciIllisible` sur la ligne du parcours. Le portail annonce alors trois
    // parcours morts pour une panne de LECTURE.
    const perdu = mkdtempSync(join(tmpdir(), 'qa-depot-illisible-'));
    // `avant` est repris dans le FINALLY : une assertion qui échoue ici laissait
    // `racine` sur un dossier effacé, et les tests suivants tombaient pour une
    // raison qui n'était pas la leur (revue de la PR #113, 3e passe).
    const avant = racine;
    try {
      racine = perdu;
      ecrire({
        '.github/workflows/nuit.yml': NUIT.replace(
          `ls tests/e2e/*.spec.ts | grep -v "c.spec.ts"`,
          `ls tests/e2e/*.spec.ts | grep -vE 'c.spec.ts|b.spec.ts'`,
        ),
        '.github/workflows/pr.yml': PR,
        'apps/web/tests/e2e/a.spec.ts': specFactice('the smoke journey'),
        'apps/web/tests/e2e/b.spec.ts': specFactice('the second journey'),
        'apps/web/tests/e2e/c.spec.ts': specFactice('the excluded journey'),
      });
      const { workflows, parcours } = lire();
      const nuit = workflows.find((w) => w.fichier.endsWith('nuit.yml'));
      expect(nuit.parcoursIllisibles).toBe(true);
      expect(nuit.specsNommees).toEqual([]);
      // La PR nomme toujours `a.spec.ts` : il garde sa cadence.
      expect(par(parcours, 'a.spec.ts').cadence).toBe('every pull request');
      // Les deux autres ne sont plus joués — mais on ne le dit PAS.
      for (const nom of ['b.spec.ts', 'c.spec.ts']) {
        expect(par(parcours, nom).jouParLaCi).toBe(false);
        expect(par(parcours, nom).ciIllisible).toBe(true);
      }
    } finally {
      racine = avant;
      rmSync(perdu, { recursive: true, force: true });
    }
  });

  it('ce qu’un workflow dit en COMMENTAIRE, il ne le lance pas', () => {
    // `pr.yml` parle de `pnpm bench` et de `--coverage` pour dire qu'il ne les
    // lance PAS. MUTATION : retirer `sansCommentairesYaml` de `ciDuDepot`, et
    // ces deux phrases deviennent des étapes exécutées — dont l'alerte
    // « aucun workflow ne lance le banc » dépend directement.
    //
    // Pour les PARCOURS, cet appel-ci n'est pas la seule défense :
    // `parcoursDunWorkflow` retire les commentaires lui-même. C'est le banc et
    // la couverture qui n'ont que celle-là.
    const { workflows } = lire();
    const pr = workflows.find((w) => w.fichier.endsWith('pr.yml'));
    expect(pr.lanceBanc).toBe(false);
    expect(pr.lanceCouverture).toBe(false);
    expect(pr.specsNommees).toEqual(['a.spec.ts']);
  });

  it('le nombre de cas et l’intention viennent du FICHIER, pas d’un compte inventé', () => {
    const { parcours } = lire();
    expect(par(parcours, 'a.spec.ts').cas).toBe(1);
    expect(par(parcours, 'a.spec.ts').intention).toContain('the smoke journey');
  });
});
