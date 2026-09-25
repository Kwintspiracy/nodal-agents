// delivered-media.test.ts — CE QUE LA ROUTE D'UN MÉDIA LIVRÉ ACCEPTE DE SERVIR (#490).
//
// De vrais dossiers sur le disque, de vraies lignes d'audit. Le chemin donné
// au résolveur est celui que l'ENCART affiche (`fileChangesOfAuditRows`), comme
// le navigateur le renvoie : le chemin brut ne sort jamais du serveur (#161).
// Ce qui est relu : le fichier retrouvé, ou le refus et son code.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

import { resolveDeliveredMedia } from '../delivered-media.ts';
import { fileChangesOfAuditRows, type AuditRowForChanges } from '../file-change-groups.ts';

let ROOT: string;
let OTHER: string;
let OUTSIDE: string;

beforeEach(async () => {
  ROOT = await realpath(await mkdtemp(join(tmpdir(), 'nodal-media-root-')));
  OTHER = await realpath(await mkdtemp(join(tmpdir(), 'nodal-media-other-')));
  OUTSIDE = await realpath(await mkdtemp(join(tmpdir(), 'nodal-media-outside-')));
});

afterEach(async () => {
  for (const d of [ROOT, OTHER, OUTSIDE]) await rm(d, { recursive: true, force: true });
});

/** Ce que `generate_speech` laisse en audit : la carte nomme le chemin ABSOLU. */
const ecrit = (path: string, action: 'written' | 'created' = 'written'): AuditRowForChanges => ({
  toolName: 'generate_speech',
  toolInput: { text: 'x', path },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action }] },
});

const lu = (path: string): AuditRowForChanges => ({
  toolName: 'file_read',
  toolInput: { path },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'listed' }] },
});

/** Le chemin que l'encart affiche pour le n-ième fichier livré. */
function affiche(rows: AuditRowForChanges[], roots: string[], i = 0): string {
  const f = fileChangesOfAuditRows(rows, roots)[i];
  if (f === undefined) throw new Error(`no delivered file #${i}`);
  return f.filePath;
}

async function fichier(path: string, bytes = 'RIFF....WAVE'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
}

describe('resolveDeliveredMedia @cap:travailler-sur-des-fichiers/moteur', () => {
  it('retrouve le WAV que le run a écrit, par le chemin que l’encart affiche', async () => {
    const wav = join(ROOT, 'outputs', 'voix.wav');
    await fichier(wav, 'RIFF1234WAVEdata');
    const rows = [ecrit(wav)];
    const roots = [ROOT];

    const res = await resolveDeliveredMedia(rows, roots, affiche(rows, roots), 0);

    expect(res).toEqual({
      ok: true,
      media: {
        absPath: wav,
        fileName: 'voix.wav',
        size: 16,
        kind: 'audio',
        contentType: 'audio/wav',
      },
    });
  });

  it('un chemin que ce run n’a pas livré n’ouvre rien, même s’il existe', async () => {
    const wav = join(ROOT, 'outputs', 'voix.wav');
    const autre = join(ROOT, 'outputs', 'secret.wav');
    await fichier(wav);
    await fichier(autre);
    const rows = [ecrit(wav), lu(autre)];

    // Le fichier seulement LU n'est pas livré : il ne se sert pas.
    expect(await resolveDeliveredMedia(rows, [ROOT], 'outputs/secret.wav', 0)).toEqual({
      ok: false,
      code: 'not_delivered',
    });
    // Ni un chemin inventé, ni un rang au-delà de ceux du chemin.
    expect(await resolveDeliveredMedia(rows, [ROOT], '../../etc/passwd', 0)).toEqual({
      ok: false,
      code: 'not_delivered',
    });
    expect(await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT]), 1)).toEqual({
      ok: false,
      code: 'not_delivered',
    });
  });

  it('un fichier écrit hors des dossiers de l’entité n’est pas servi', async () => {
    const dehors = join(OUTSIDE, 'fuite.wav');
    await fichier(dehors);
    const rows = [ecrit(dehors)];

    expect(await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT]), 0)).toEqual({
      ok: false,
      code: 'outside',
    });
  });

  it('un lien posé dans le dossier ne fait pas sortir la lecture', async () => {
    await fichier(join(OUTSIDE, 'fuite.wav'));
    // Une jonction : la forme de lien qu'un compte Windows sans droits
    // d'administration peut créer, et un lien de dossier ailleurs.
    await symlink(OUTSIDE, join(ROOT, 'lien'), 'junction');
    const parLeLien = join(ROOT, 'lien', 'fuite.wav');
    const rows = [ecrit(parLeLien)];

    expect(await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT]), 0)).toEqual({
      ok: false,
      code: 'outside',
    });
  });

  it('un fichier supprimé depuis le dit : gone, pas « introuvable »', async () => {
    const wav = join(ROOT, 'voix.wav');
    const rows = [ecrit(wav)];

    expect(await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT]), 0)).toEqual({
      ok: false,
      code: 'gone',
    });
  });

  it('seuls les types de la liste fermée se servent : ni SVG, ni texte', async () => {
    const svg = join(ROOT, 'logo.svg');
    const txt = join(ROOT, 'notes.txt');
    await fichier(svg, '<svg onload="alert(1)"/>');
    await fichier(txt, 'bonjour');
    const rows = [ecrit(svg), ecrit(txt)];

    expect(await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT], 0), 0)).toEqual({
      ok: false,
      code: 'not_media',
    });
    expect(await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT], 1), 0)).toEqual({
      ok: false,
      code: 'not_media',
    });
  });

  it('un chemin relatif se résout dans le SEUL dossier qui le porte, jamais au hasard', async () => {
    const rows = [ecrit('clips/intro.mp4')];
    await fichier(join(OTHER, 'clips', 'intro.mp4'), 'mp4');

    const seul = await resolveDeliveredMedia(rows, [ROOT, OTHER], 'clips/intro.mp4', 0);
    expect(seul.ok && seul.media.absPath).toBe(join(OTHER, 'clips', 'intro.mp4'));
    expect(seul.ok && seul.media.kind).toBe('video');

    await fichier(join(ROOT, 'clips', 'intro.mp4'), 'autre');
    expect(await resolveDeliveredMedia(rows, [ROOT, OTHER], 'clips/intro.mp4', 0)).toEqual({
      ok: false,
      code: 'ambiguous',
    });
  });

  it('deux fichiers au MÊME chemin affiché : le rang désigne chacun le sien', async () => {
    // Deux chemins qui ne diffèrent que par un jeton masquent vers le même
    // texte (#161) : l'encart les affiche pareil, et `DeliveryFiles` les
    // distingue par leur rang (#380). Leur identité est le chemin BRUT.
    const a = join(ROOT, 'cles', 'sk-AAAA.png');
    const b = join(ROOT, 'cles', 'sk-BBBB.png');
    await fichier(a, 'AAAA');
    await fichier(b, 'BBBBBBBB');
    const masque = join(ROOT, 'cles', '[secret].png');
    const ligne = (brut: string): AuditRowForChanges => ({
      ...ecrit(masque),
      rawFilePaths: [brut],
    });
    const rows = [ligne(a), ligne(b)];
    expect(affiche(rows, [ROOT], 0)).toBe(affiche(rows, [ROOT], 1));

    const premier = await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT]), 0);
    const second = await resolveDeliveredMedia(rows, [ROOT], affiche(rows, [ROOT]), 1);
    expect(premier.ok && premier.media.absPath).toBe(a);
    expect(second.ok && second.media.absPath).toBe(b);
    expect(second.ok && second.media.size).toBe(8);
  });
});
