// code-projects-roots.test.ts — les racines d'un espace, et QUI les détient.
//
// Constat P2 de la revue Codex (26/08). Les racines étaient dédupliquées par
// texte brut. Deux agents attachant le MÊME dossier Windows avec des casses
// différentes — `C:/Dev` et `c:/dev` — en produisaient DEUX ; `within` les fait
// toutes deux matcher, donc la première gagnait le rattachement, mais les
// détenteurs restaient indexés sur leur propre graphie. Un projet annoncé aux
// agents avec la MOITIÉ de ses détenteurs, et rien à l'écran pour le dire.
//
// POURQUOI une fonction pure plutôt qu'un test sur disque : fabriquer deux
// dossiers ne différant que par la casse prouve DEUX choses opposées selon
// l'hôte — un seul dossier sur Windows, deux sur la CI Linux. Le premier jet de
// ce test passait d'ailleurs avec la correction débranchée, parce que ses deux
// chemins (`/dev` et `/dev/`) se normalisaient déjà pareil : il ne testait rien.

import { describe, it, expect } from 'vitest';
import { canonicalRoots } from '../../job/code-projects.ts';

describe('canonicalRoots', () => {
  it('deux CASSES du même dossier Windows = UNE racine, et TOUS les détenteurs', () => {
    const { roots, ownersByRoot } = canonicalRoots([
      { path: 'C:\\Users\\kwint\\Documents\\Dev', agentName: 'Lead-Dev' },
      { path: 'c:/users/kwint/documents/dev', agentName: 'Dev C' },
    ]);

    expect(roots, 'le même dossier compte deux fois').toHaveLength(1);
    expect(
      [...(ownersByRoot.get(roots[0]!) ?? [])].sort(),
      'un détenteur attaché par l’autre graphie a été perdu',
    ).toEqual(['Dev C', 'Lead-Dev']);
  });

  it('deux dossiers POSIX qui ne diffèrent que par la casse restent DEUX', () => {
    // La contrepartie : sur un système sensible à la casse, ce sont deux
    // dossiers légitimes. Les fondre ferait disparaître le travail de l'un.
    const { roots } = canonicalRoots([
      { path: '/srv/App', agentName: 'A' },
      { path: '/srv/app', agentName: 'B' },
    ]);
    expect(roots).toHaveLength(2);
  });

  it('écarte les racines de disque, garde le reste trié du plus profond au moins profond', () => {
    // Le tri fait le travail ailleurs : un workspace niché doit gagner sur son
    // parent, sinon le parent avale ses écritures.
    const { roots } = canonicalRoots([
      { path: 'C:/', agentName: 'A' },
      { path: '/', agentName: 'B' },
      { path: 'C:/Dev', agentName: 'C' },
      { path: 'C:/Dev/niche', agentName: 'D' },
    ]);
    expect(roots).toEqual(['C:/Dev/niche', 'C:/Dev']);
  });

  it('un slash final ne fabrique pas une seconde racine', () => {
    const { roots, ownersByRoot } = canonicalRoots([
      { path: '/srv/app', agentName: 'A' },
      { path: '/srv/app/', agentName: 'B' },
    ]);
    expect(roots).toHaveLength(1);
    expect([...(ownersByRoot.get(roots[0]!) ?? [])].sort()).toEqual(['A', 'B']);
  });
});
