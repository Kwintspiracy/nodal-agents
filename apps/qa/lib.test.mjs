// lib.test.mjs — les jugements du portail, prouvés.
//
// Le portail se dénonçait à 0 % de couverture (issue #57). Il avait raison, et
// une revue Codex a trouvé SIX erreurs de jugement dans ces quelques
// fonctions — dont deux qui le faisaient mentir : une CI annulée affichée
// verte, et des cas ignorés comptés comme rouges.
//
// Chaque test ci-dessous nomme le cas réel qui l'a motivé. Un portail qui se
// trompe sur un verdict est pire que pas de portail : il fait croire qu'on
// regarde.

import { describe, it, expect } from 'vitest';
import {
  etatCi,
  colonneDeCarte,
  sortDuCas,
  compterParcours,
  parcoursDunWorkflow,
  declencheursDunWorkflow,
  cadenceDe,
} from './lib.mjs';

describe('etatCi — le vert ne s’accorde qu’à ce qui a réussi', () => {
  it('tout en succès ⇒ vert', () => {
    expect(etatCi([{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }])).toBe('vert');
  });

  it('un échec ⇒ rouge', () => {
    expect(etatCi([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('rouge');
  });

  it('ANNULÉ n’est pas vert', () => {
    // Le cas qui a motivé le correctif : le 10/09, quatre exécutions ont été
    // annulées, chaque push remplaçant la précédente. Elles s'affichaient vertes.
    expect(etatCi([{ status: 'COMPLETED', conclusion: 'CANCELLED' }])).toBe('rouge');
  });

  it('DÉLAI DÉPASSÉ et ACTION REQUISE ne sont pas verts non plus', () => {
    expect(etatCi([{ conclusion: 'TIMED_OUT' }])).toBe('rouge');
    expect(etatCi([{ conclusion: 'ACTION_REQUIRED' }])).toBe('rouge');
  });

  it('un état INCONNU n’est jamais vert', () => {
    // Le défaut est le rouge : un tableau qui verdit ce qu'il ne comprend pas
    // ment sur le seul point qui compte.
    expect(etatCi([{ conclusion: 'UN_ETAT_QUE_GITHUB_INVENTERA' }])).toBe('rouge');
  });

  it('un contexte de statut ANCIEN, en attente, n’est pas vert', () => {
    // Les status contexts ne portent pas `status` mais `state` : la première
    // version lisait `status`, ne trouvait rien, et concluait au vert.
    expect(etatCi([{ state: 'PENDING' }])).toBe('en cours');
    expect(etatCi([{ state: 'SUCCESS' }])).toBe('vert');
    expect(etatCi([{ state: 'FAILURE' }])).toBe('rouge');
  });

  it('en cours ⇒ ni vert ni rouge', () => {
    expect(etatCi([{ status: 'IN_PROGRESS' }, { conclusion: 'SUCCESS' }])).toBe('en cours');
  });

  it('aucun contrôle ⇒ rien à dire, pas un verdict', () => {
    expect(etatCi([])).toBeNull();
    expect(etatCi(null)).toBeNull();
  });

  it('NEUTRAL et SKIPPED comptent comme réussis', () => {
    // Un contrôle qui ne s'applique pas n'est pas un échec.
    expect(etatCi([{ conclusion: 'NEUTRAL' }, { conclusion: 'SKIPPED' }])).toBe('vert');
  });
});

describe('colonneDeCarte — déduite de faits', () => {
  it('une PR mergée est faite, une PR ouverte est en review', () => {
    expect(colonneDeCarte({ type: 'pr', etat: 'MERGED' })).toBe('Fait');
    expect(colonneDeCarte({ type: 'pr', etat: 'OPEN' })).toBe('En review');
  });

  it('une PR FERMÉE sans merge n’attend pas de review', () => {
    // La PR #2 de Snyk, fermée sans merge, gonflait la colonne « En review » —
    // qui doit rester un appel à l'action, pas un cimetière.
    expect(colonneDeCarte({ type: 'pr', etat: 'CLOSED' })).toBe('Abandonné');
  });

  it('une issue étiquetée décision attend Quentin', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: ['décision'] })).toBe(
      'À faire',
    );
  });

  it('une issue étiquetée test va dans À tester', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: ['test', 'dette'] })).toBe(
      'À tester',
    );
  });

  it('« décision » prime sur « test » — c’est elle qui bloque', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: ['test', 'décision'] })).toBe(
      'À faire',
    );
  });

  it('une issue ouverte sans étiquette parlante est en cours', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: [] })).toBe('En cours');
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN' })).toBe('En cours');
  });

  it('une issue fermée est faite', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'CLOSED', etiquettes: ['décision'] })).toBe(
      'Fait',
    );
  });
});

describe('sortDuCas — ignoré n’est pas rouge', () => {
  it('un passage du premier coup est vert', () => {
    expect(sortDuCas([{ status: 'passed' }])).toBe('vert');
  });

  it('un échec est rouge', () => {
    expect(sortDuCas([{ status: 'failed' }])).toBe('rouge');
  });

  it('IGNORÉ n’est pas rouge', () => {
    // Le rapport committé porte 36 cas ignorés. Ils s'affichaient tous comme
    // des régressions — le défaut même que ce portail dénonce ailleurs.
    expect(sortDuCas([{ status: 'skipped' }])).toBe('ignoré');
    expect(sortDuCas([])).toBe('ignoré');
  });

  it('passé au SECOND essai est instable, pas vert', () => {
    // Le seul signal qui distingue un test sûr d'un test instable. Le
    // confondre avec un succès, c'est le perdre.
    expect(sortDuCas([{ status: 'failed' }, { status: 'passed' }])).toBe('instable');
  });

  it('un essai ignoré parmi des passages ne change rien', () => {
    expect(sortDuCas([{ status: 'skipped' }, { status: 'passed' }])).toBe('vert');
  });

  it('compterParcours ventile les quatre sorts', () => {
    const c = compterParcours(['vert', 'vert', 'rouge', 'ignoré', 'instable']);
    expect(c).toEqual({ total: 5, vert: 2, rouge: 1, ignoré: 1, instable: 1 });
  });
});

describe('declencheursDunWorkflow — une détection muette qui se trompe répond quand même', () => {
  // Le cas réel : un `\b` écrit depuis un script shell est devenu un caractère
  // de contrôle littéral dans le fichier. La regex cherchait un caractère
  // invisible, ne trouvait jamais rien, et le portail affichait « à la main »
  // pour TOUS les parcours — y compris les deux joués à chaque PR. Rien ne
  // l'a signalé pendant une journée.
  const CI = `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest`;

  const NOCTURNE = `name: Qualité

on:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

jobs:
  mesure:
    runs-on: ubuntu-latest`;

  it('lit push et pull_request', () => {
    expect(declencheursDunWorkflow(CI)).toEqual(['push', 'pull_request']);
  });

  it('lit schedule et le déclenchement manuel', () => {
    expect(declencheursDunWorkflow(NOCTURNE)).toEqual(['schedule', 'manuel']);
  });

  it('un fichier sans bloc `on:` ne déclenche rien', () => {
    expect(declencheursDunWorkflow('jobs:\n  ci:\n    runs-on: ubuntu-latest')).toEqual([]);
  });

  it('ne confond pas un `push` de texte avec un déclencheur', () => {
    // `declencheurs.push(...)` dans un commentaire, un `git push` dans un
    // script : ce ne sont pas des déclencheurs. L'ancre en début de ligne est
    // ce qui les distingue.
    const wf = `name: X

on:
  workflow_dispatch:

jobs:
  x:
    steps:
      - run: git push origin main`;
    expect(declencheursDunWorkflow(wf)).toEqual(['manuel']);
  });
});

describe('cadenceDe — garder n’est pas constater', () => {
  it('une PR prime sur tout : c’est la seule cadence qui BLOQUE', () => {
    expect(cadenceDe(['push', 'pull_request', 'schedule'])).toBe('chaque PR');
  });

  it('la nuit constate, elle ne bloque pas', () => {
    expect(cadenceDe(['schedule', 'manuel'])).toBe('chaque nuit');
  });

  it('un push sur main est entre les deux', () => {
    expect(cadenceDe(['push', 'manuel'])).toBe('chaque push sur main');
  });

  it('rien d’automatique ⇒ à la main', () => {
    expect(cadenceDe(['manuel'])).toBe('à la main');
    expect(cadenceDe([])).toBe('à la main');
  });
});

describe('parcoursDunWorkflow — nommés et balayés', () => {
  const TOUS = [
    'smoke.spec.ts',
    'autonomy-approvals.spec.ts',
    'agent-flows.spec.ts',
    'oauth.spec.ts',
  ];

  it('lit les parcours NOMMÉS en toutes lettres', () => {
    const wf = `
      - name: Two journeys
        run: >
          playwright test
          tests/e2e/smoke.spec.ts
          tests/e2e/autonomy-approvals.spec.ts`;
    const r = parcoursDunWorkflow(wf, TOUS);
    expect(r.balaye).toBe(false);
    expect(r.joues.sort()).toEqual(['autonomy-approvals.spec.ts', 'smoke.spec.ts']);
  });

  it('comprend un BALAYAGE et ses exclusions', () => {
    // Sans ça, le portail annonçait « 2 parcours en CI » pour toujours, même
    // une fois la mesure nocturne en place : il affirmait que 28 parcours ne
    // tournent jamais alors qu'ils tournaient chaque nuit.
    const wf = `
      - name: Tous les parcours
        run: |
          mapfile -t specs < <(ls tests/e2e/*.spec.ts | grep -v 'agent-flows.spec.ts')
          npx playwright test "\${specs[@]}"`;
    const r = parcoursDunWorkflow(wf, TOUS);
    expect(r.balaye).toBe(true);
    expect(r.exclus).toEqual(['agent-flows.spec.ts']);
    expect(r.joues.sort()).toEqual([
      'autonomy-approvals.spec.ts',
      'oauth.spec.ts',
      'smoke.spec.ts',
    ]);
  });

  it('un workflow qui ne parle d’aucun parcours n’en joue aucun', () => {
    const r = parcoursDunWorkflow('- run: pnpm typecheck', TOUS);
    expect(r.joues).toEqual([]);
  });
});
