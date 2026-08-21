// checkpoints.test.ts — le filet sous les écritures (manque 3).
//
// Un `mode: "write"` qui part de travers n'avait aucun retour arrière. Le seul
// recours du propriétaire était son propre historique git — s'il avait pensé à
// commiter, dans un workspace qui se trouve être un dépôt. La plupart des
// workspaces d'agents ne sont ni l'un ni l'autre.
//
// Ce qui est testé ici est la propriété que le plan désignait comme la SEULE
// qui compte : restaurer rend vraiment le contenu d'origine, vérifié au
// SHA-256. Vérifier qu'un commit fantôme existe ne prouve rien — c'est
// exactement le test qui passerait sur une implémentation qui ne restaure pas.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, listCheckpoints, restoreCheckpoint, ensureStore } from './checkpoints';

let root: string;
let store: string;
let ws: string;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-cp-'));
  store = join(root, 'checkpoints');
  ws = join(root, 'workspace');
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

describe('snapshot', () => {
  it('crée le magasin à la première utilisation', async () => {
    await writeFile(join(ws, 'a.txt'), 'un');
    const cp = await snapshot(store, ws, 'test');
    expect(cp).not.toBeNull();
    expect(existsSync(join(store, 'store', 'HEAD'))).toBe(true);
  });

  it('ne réenregistre pas un arbre inchangé', async () => {
    // Sinon un job de dix tours produit dix instantanés identiques, et le seul
    // utile devient introuvable.
    await writeFile(join(ws, 'a.txt'), 'un');
    const first = await snapshot(store, ws, 'premier');
    const second = await snapshot(store, ws, 'second');
    expect(first).not.toBeNull();
    expect(second, 'un arbre identique a produit un second instantané').toBeNull();
  });

  it('enregistre quand le contenu change', async () => {
    await writeFile(join(ws, 'a.txt'), 'un');
    await snapshot(store, ws, 'premier');
    await writeFile(join(ws, 'a.txt'), 'deux');
    expect(await snapshot(store, ws, 'second')).not.toBeNull();
  });

  it("n'écrit RIEN dans le workspace", async () => {
    // La propriété qui rend le mécanisme acceptable : un filet qui laisse des
    // traces dans le projet qu'il protège n'est pas transparent.
    await writeFile(join(ws, 'a.txt'), 'un');
    await snapshot(store, ws, 'test');
    expect(existsSync(join(ws, '.git')), 'un .git est apparu dans le workspace').toBe(false);
    expect(existsSync(join(ws, '.gitignore'))).toBe(false);
  });

  it('sépare deux workspaces', async () => {
    const ws2 = join(root, 'workspace2');
    await mkdir(ws2, { recursive: true });
    await writeFile(join(ws, 'a.txt'), 'A');
    await writeFile(join(ws2, 'b.txt'), 'B');
    await snapshot(store, ws, 'ws1');
    await snapshot(store, ws2, 'ws2');

    const l1 = await listCheckpoints(store, ws);
    const l2 = await listCheckpoints(store, ws2);
    expect(l1).toHaveLength(1);
    expect(l2).toHaveLength(1);
    expect(l1[0]!.sha).not.toBe(l2[0]!.sha);
  });
});

describe('restoreCheckpoint', () => {
  it('rend le contenu EXACT, vérifié au SHA-256', async () => {
    // LE test. Un « un commit existe » passerait sur une implémentation qui ne
    // restaure rien du tout.
    const original = 'contenu original\nligne deux\n';
    await writeFile(join(ws, 'code.txt'), original);
    const cp = await snapshot(store, ws, 'avant');
    expect(cp).not.toBeNull();

    await writeFile(join(ws, 'code.txt'), 'un agent a tout casse');
    expect(sha256(await readFile(join(ws, 'code.txt'), 'utf-8'))).not.toBe(sha256(original));

    await restoreCheckpoint(store, ws, cp!.sha);

    expect(
      sha256(await readFile(join(ws, 'code.txt'), 'utf-8')),
      'le contenu restauré ne correspond pas à l’original',
    ).toBe(sha256(original));
  });

  it('restaure un fichier supprimé', async () => {
    await writeFile(join(ws, 'perdu.txt'), 'important');
    const cp = await snapshot(store, ws, 'avant');
    await rm(join(ws, 'perdu.txt'));
    expect(existsSync(join(ws, 'perdu.txt'))).toBe(false);

    await restoreCheckpoint(store, ws, cp!.sha);
    expect(existsSync(join(ws, 'perdu.txt')), 'un fichier supprimé n’est pas revenu').toBe(true);
    expect(await readFile(join(ws, 'perdu.txt'), 'utf-8')).toBe('important');
  });

  it('prend un instantané de sûreté AVANT de restaurer', async () => {
    // Restaurer est une décision, et l'état qu'elle jette peut être celui qu'il
    // fallait garder.
    await writeFile(join(ws, 'a.txt'), 'v1');
    const cp = await snapshot(store, ws, 'v1');
    await writeFile(join(ws, 'a.txt'), 'v2-non-enregistre');

    const res = await restoreCheckpoint(store, ws, cp!.sha);
    expect(res.safety, 'aucun instantané de sûreté avant la restauration').not.toBeNull();

    // Et il est réellement utilisable : on revient à l'état qu'on venait de jeter.
    await restoreCheckpoint(store, ws, res.safety!.sha);
    expect(await readFile(join(ws, 'a.txt'), 'utf-8')).toBe('v2-non-enregistre');
  });
});

describe('listCheckpoints', () => {
  it('rend une liste vide plutôt que d’échouer sur un magasin absent', async () => {
    expect(await listCheckpoints(join(root, 'inexistant'), ws)).toEqual([]);
  });

  it('rend les plus récents en premier', async () => {
    await writeFile(join(ws, 'a.txt'), '1');
    await snapshot(store, ws, 'premier');
    await writeFile(join(ws, 'a.txt'), '2');
    await snapshot(store, ws, 'second');

    const l = await listCheckpoints(store, ws);
    expect(l).toHaveLength(2);
    expect(l[0]!.label).toContain('second');
  });
});

describe('ensureStore', () => {
  it('est idempotent', async () => {
    await ensureStore(store);
    await ensureStore(store);
    expect(existsSync(join(store, 'store', 'HEAD'))).toBe(true);
  });
});

describe('la clé de workspace', () => {
  it('traite les deux séparateurs comme le même workspace (Windows)', async () => {
    // Trouvé par un essai live, pas par un unitaire : un instantané pris via
    // `C:/Users/x` était invisible depuis `C:\Users\x`. Le magasin se
    // remplissait et `checkpoints list` ne montrait rien — sans erreur.
    if (process.platform !== 'win32') return;
    await writeFile(join(ws, 'a.txt'), 'contenu');
    await snapshot(store, ws, 'via backslash');

    const avecSlashes = ws.split('\\').join('/');
    expect(avecSlashes).not.toBe(ws); // sinon le test ne prouve rien
    expect(
      (await listCheckpoints(store, avecSlashes)).length,
      'le même workspace écrit autrement est invisible',
    ).toBe(1);
  });

  it('ignore un séparateur final', async () => {
    await writeFile(join(ws, 'a.txt'), 'contenu');
    await snapshot(store, ws, 'sans slash final');
    expect((await listCheckpoints(store, ws + '/')).length).toBe(1);
  });
});
