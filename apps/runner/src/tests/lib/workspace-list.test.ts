// workspace-list.test.ts — UN AGENT, UN DOSSIER.
//
// Constat de Quentin (26/08), après une journée de symptômes qui remontaient
// tous ici : « Un agent, un dossier, voilà c'est tout. »
//
// Le workspace partagé était injecté à TOUS les agents, y compris à ceux à qui
// le propriétaire avait explicitement attaché un dossier. L'agent recevait
// alors un prompt disant « ton seul dossier est Dev » et des outils qui en
// connaissaient deux. Il écrivait `shared/outputs/x.html`, les outils
// routaient vers le partagé, et lui annonçait
// `C:\…\Documents\Dev\shared\outputs\x.html` — en collant sa racine au chemin
// relatif. Un chemin qui n'existe nulle part, et dont le début juste le rend
// crédible.

import { describe, it, expect } from 'vitest';
import { resolveWorkspaceList } from '../../lib/workspace-list.ts';

const DEV = { label: 'Dev', path: 'C:/Users/kwint/Documents/Dev' };
const VAULT = { label: 'Obsidian Vault', path: 'D:/Obsidian Vaults/Kwint Vault' };
const SHARED = 'C:/Users/kwint/.nodalai/workspaces/e1/shared';

describe('resolveWorkspaceList', () => {
  it('un agent qui a un dossier garde AUSSI le partagé — c’est son lien avec les autres', () => {
    // Objection décisive de Quentin sur une première version de ce correctif,
    // qui retirait le partagé à quiconque avait un dossier : « si mon agent a
    // besoin de partager un fichier avec un autre agent, comment il fait ? »
    // Le partagé est le SEUL terrain commun entre un agent qui tient un coffre
    // Obsidian et un agent qui génère des images.
    const r = resolveWorkspaceList([DEV], 'shared', SHARED);
    expect(
      r.workspaces,
      'le partagé a disparu : l’agent n’a plus aucun moyen d’échanger un fichier',
    ).toEqual([DEV, { label: 'shared', path: SHARED }]);
    expect(r.sharedPath).toBe(SHARED);
  });

  it('le dossier du PROPRIÉTAIRE reste en tête — le prompt présente le premier', () => {
    const r = resolveWorkspaceList([DEV, VAULT], 'shared', SHARED);
    expect(r.workspaces.map((w) => w.label)).toEqual(['Dev', 'Obsidian Vault', 'shared']);
  });

  it('AUCUN dossier attaché : le partagé est son seul workspace', () => {
    // Le cas des agents utilitaires — générateur d'images, assistant de chat.
    const r = resolveWorkspaceList([], 'shared', SHARED);
    expect(r.workspaces).toEqual([{ label: 'shared', path: SHARED }]);
    expect(r.sharedPath).toBe(SHARED);
  });

  it('pas de partagé disponible : rien d’inventé', () => {
    // `sharedPath` est null quand le mkdir a échoué. Fabriquer une entrée ferait
    // écrire l'agent dans un dossier qui n'existe pas.
    const r = resolveWorkspaceList([DEV], 'shared', null);
    expect(r.workspaces).toEqual([DEV]);
    expect(r.sharedPath).toBeNull();
  });

  it('n’ajoute pas un second partagé si l’espace en porte déjà un', () => {
    const deja = [DEV, { label: 'shared', path: SHARED }];
    const r = resolveWorkspaceList(deja, 'shared', SHARED);
    expect(r.workspaces).toHaveLength(2);
  });

  it('ne modifie pas la liste qu’on lui passe', () => {
    const attached = [DEV];
    resolveWorkspaceList(attached, 'shared', SHARED);
    expect(attached).toHaveLength(1);
  });
});
