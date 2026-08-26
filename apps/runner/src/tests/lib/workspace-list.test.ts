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
  it('un agent qui a un dossier n’en voit QUE lui — jamais le partagé en plus', () => {
    const r = resolveWorkspaceList([DEV], 'shared', SHARED);
    expect(r.workspaces, 'le partagé a été ajouté à un agent qui a son dossier').toEqual([DEV]);
    expect(
      r.sharedPath,
      'le partagé reste annoncé, donc son inventaire et ses consignes reviennent',
    ).toBeNull();
  });

  it('plusieurs dossiers attachés : tous, et toujours pas le partagé', () => {
    const r = resolveWorkspaceList([DEV, VAULT], 'shared', SHARED);
    expect(r.workspaces).toEqual([DEV, VAULT]);
    expect(r.sharedPath).toBeNull();
  });

  it('AUCUN dossier attaché : le partagé devient son workspace', () => {
    // Le cas des agents utilitaires — générateur d'images, assistant de chat.
    // Rien ne change pour eux, et c'est le seul cas où le partagé apparaît.
    const r = resolveWorkspaceList([], 'shared', SHARED);
    expect(r.workspaces).toEqual([{ label: 'shared', path: SHARED }]);
    expect(r.sharedPath).toBe(SHARED);
  });

  it('aucun dossier ET pas de partagé : liste vide, rien d’inventé', () => {
    // `sharedPath` est null quand le mkdir a échoué. Fabriquer une entrée ferait
    // écrire l'agent dans un dossier qui n'existe pas.
    const r = resolveWorkspaceList([], 'shared', null);
    expect(r.workspaces).toEqual([]);
    expect(r.sharedPath).toBeNull();
  });

  it('ne modifie pas la liste qu’on lui passe', () => {
    // `executeJob` réutilise le tableau d'origine ; une mutation surprise s'y
    // propagerait sans bruit.
    const attached = [DEV];
    resolveWorkspaceList(attached, 'shared', SHARED);
    expect(attached).toHaveLength(1);
  });
});
