// workspace-git-target.test.ts — QUEL dossier la sonde git regarde.
//
// Constat de Quentin (26/08), sur un run réel. La sonde portait sur le
// workspace PARTAGÉ, sans condition. Un agent dont le vrai travail est dans
// `Documents/Dev/NodalAI` — un vrai dépôt — s'entendait donc décrire l'état git
// d'un répertoire de brouillon : une information fausse à la place d'une
// information utile, et précisément dans le bloc censé lui éviter de committer
// au mauvais endroit.
//
// Le choix vivait au milieu de `executeJob`, une fonction de 1 500 lignes :
// aucun test ne pouvait l'atteindre. Il est extrait pour ça.

import { describe, it, expect } from 'vitest';
import { gitProbeTarget } from '../../lib/workspace-git.ts';

const PARTAGE = 'C:/Users/kwint/.nodalai/workspaces/e1/shared';
const DEV = 'C:/Users/kwint/Documents/Dev';
const COFFRE = 'D:/Obsidian Vaults/Kwint Vault';

describe('gitProbeTarget', () => {
  it('sonde le dossier ATTACHÉ, pas le partagé', () => {
    expect(
      gitProbeTarget([DEV], PARTAGE),
      'la sonde décrit le brouillon partagé au lieu du dossier de travail',
    ).toBe(DEV);
  });

  it('prend le PREMIER dossier attaché — le même que le prompt présente en premier', () => {
    // L'ordre vient de la requête (`position, label`). S'en écarter ferait
    // parler les deux blocs de deux endroits différents, sans que rien ne le
    // signale.
    expect(gitProbeTarget([DEV, COFFRE], PARTAGE)).toBe(DEV);
    expect(gitProbeTarget([COFFRE, DEV], PARTAGE)).toBe(COFFRE);
  });

  it('retombe sur le partagé quand AUCUN dossier n’est attaché', () => {
    // Pour ces agents-là — Alfred, ComfyArtist… — le partagé EST le workspace,
    // et la question « suis-je dans un dépôt ? » porte bien sur lui.
    expect(gitProbeTarget([], PARTAGE)).toBe(PARTAGE);
  });

  it('rend null quand il n’y a ni dossier attaché ni partagé', () => {
    // `sharedWorkspacePath` est null quand la création du dossier a échoué.
    // Rendre autre chose que null ferait sonder un chemin inventé.
    expect(gitProbeTarget([], null)).toBeNull();
  });
});
