// written-file-type.test.ts — la règle pure, sans disque ni base (#263).
//
// La question « code ou document ? » est posée AVANT l'écriture. Sur un
// dossier neuf, `hasMarker` répond non tant que le manifeste n'est pas sur le
// disque : le premier `package.json` d'un dépôt était typé `document`, et
// seule la SECONDE écriture faisait du dossier un projet (constat 4 de la
// revue de #66, sorti de #211). Ce fichier fige l'inverse : le fichier écrit
// qui EST un manifeste fait de son dossier un projet dès cette écriture.

import { describe, it, expect } from 'vitest';
import { PROJECT_MARKERS } from '@nodal-agents/shared';
import { classifyWrittenFile } from '../verification/written-file-type';

const ROOT = 'C:/work/espace';
/** Un dossier neuf : aucun marqueur sur le disque, rien de déclaré. */
const neuf = (absPath: string) =>
  classifyWrittenFile({
    absPath,
    workspaceRoots: [ROOT],
    declaredCodeProjectPaths: [],
    hasMarker: () => false,
  });

describe('le premier manifeste d’un dépôt neuf est du code @cap:verifier-un-livrable/moteur', () => {
  it('le fichier écrit qui est lui-même un manifeste classe son dossier projet de code', () => {
    expect(neuf(`${ROOT}/mon-app/package.json`)).toBe('code_project');
    expect(neuf(`${ROOT}/mon-app/pyproject.toml`)).toBe('code_project');
    expect(neuf(`${ROOT}/mon-app/Cargo.toml`)).toBe('code_project');
    // À la racine de l'espace aussi : c'est là qu'un dépôt neuf commence.
    expect(neuf(`${ROOT}/package.json`)).toBe('code_project');
  });

  it('tout marqueur de la liste partagée compte, sauf `.git`, qui est un dossier', () => {
    for (const m of PROJECT_MARKERS) {
      if (m === '.git') continue;
      expect(neuf(`${ROOT}/x/${m}`), m).toBe('code_project');
    }
    expect(neuf(`${ROOT}/x/.git`)).toBe('document');
  });

  it('un fichier ordinaire dans un dossier neuf reste un document', () => {
    expect(neuf(`${ROOT}/mon-app/README.md`)).toBe('document');
    expect(neuf(`${ROOT}/notes/rapport.csv`)).toBe('document');
    // Un nom qui RESSEMBLE à un manifeste n'en est pas un.
    expect(neuf(`${ROOT}/mon-app/package.json.bak`)).toBe('document');
    expect(neuf(`${ROOT}/mon-app/my-package.json`)).toBe('document');
  });

  it('un manifeste plus profond que la racine résolue suit la racine (#435)', () => {
    // `notes/site/index.html` : ni `notes` ni l'espace ne portent de marqueur.
    // `resolveProjectRoots` résout la racine à `notes` — règle du sous-dossier
    // de premier niveau — et c'est elle qui décide en aval : l'intention
    // assigne la vérification à `notes`, et l'enregistrement la refuse faute
    // de marqueur. Classer `code_project` ici ferait perdre au fichier sa clé
    // de livrable document. Le manifeste ne compte que s'il EST à la racine.
    expect(neuf(`${ROOT}/notes/site/index.html`)).toBe('document');
    // Aux deux endroits où le manifeste EST la racine résolue, il compte.
    expect(neuf(`${ROOT}/mon-app/package.json`)).toBe('code_project');
    expect(neuf(`${ROOT}/package.json`)).toBe('code_project');
  });

  it('la seconde écriture donne la même réponse que la première : le manifeste est sur le disque', () => {
    const avecManifeste = classifyWrittenFile({
      absPath: `${ROOT}/mon-app/src/index.ts`,
      workspaceRoots: [ROOT],
      declaredCodeProjectPaths: [],
      hasMarker: (dir) => dir === `${ROOT}/mon-app`,
    });
    expect(avecManifeste).toBe('code_project');
  });
});
