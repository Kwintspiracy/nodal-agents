// picked-folder-label.test.ts — le libellé d'un dossier choisi par Browse…
// (#461, revue de la PR #467).
//
// Valider Browse… attache le dossier sans écran intermédiaire : ce qui ne peut
// pas s'attacher doit le dire, avec le libellé en cause, et jamais rentrer en
// silence (invariant #4).

import { describe, it, expect } from 'vitest';
import {
  folderName,
  labelAfterRefusal,
  pickedFolderLabel,
  settled,
} from '../picked-folder-label.ts';

describe('pickedFolderLabel @cap:travailler-sur-des-fichiers/ecran', () => {
  it('sans libellé tapé : le nom du dossier, POSIX, Windows ou UNC', () => {
    expect(pickedFolderLabel('', '/home/ada/notes', [])).toEqual({ ok: true, label: 'notes' });
    expect(pickedFolderLabel('  ', 'C:\\Users\\ada\\Excel\\', [])).toEqual({
      ok: true,
      label: 'Excel',
    });
    expect(pickedFolderLabel('', '\\\\srv\\share', [])).toEqual({ ok: true, label: 'share' });
  });

  it('un libellé tapé passe avant le nom du dossier, rogné', () => {
    expect(pickedFolderLabel('  compta ', '/srv/notes', [])).toEqual({
      ok: true,
      label: 'compta',
    });
  });

  it('une racine sans nom : refusée, et dit', () => {
    const r = pickedFolderLabel('', '/', []);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.message).toBe(
        'This folder has no name to use as a label. Type a label, then Browse… again.',
      );
  });

  it('un libellé déjà porté par l’agent : refusé AVANT le serveur, en le nommant', () => {
    const derive = pickedFolderLabel('', '/backup/notes', ['notes', 'src']);
    expect(derive).toEqual({
      ok: false,
      label: 'notes',
      message:
        'This agent already has a folder labelled “notes”. Change the label, then Browse… again.',
    });
    const tape = pickedFolderLabel('src', '/elsewhere/code', ['notes', 'src']);
    expect(tape.ok).toBe(false);
    expect(tape.label).toBe('src');
  });

  it('un nom de dossier trop long est coupé à 80, la limite du serveur', () => {
    const long = 'x'.repeat(120);
    const r = pickedFolderLabel('', `/data/${long}`, []);
    expect(r).toEqual({ ok: true, label: 'x'.repeat(80) });
  });

  it('settled : un rejet devient un échec dit, jamais une exception', async () => {
    // Revue passe 3 (A : P2, C : mineur) : le rechargement de la liste APRÈS
    // un ajout réussi rejetait, l'exception remontait jusqu'à la fenêtre, qui
    // disait « The folder was not added » alors que le dossier était en base.
    expect(await settled(Promise.reject(new Error('fetch failed')))).toEqual({
      ok: false,
      message: 'fetch failed',
    });
    expect(await settled(Promise.resolve({ ok: true as const, data: [1] }))).toEqual({
      ok: true,
      data: [1],
    });
    expect(await settled(Promise.resolve({ ok: false as const, message: 'nope' }))).toEqual({
      ok: false,
      message: 'nope',
    });
  });

  it('une racine de lecteur Windows n’a pas de nom non plus', () => {
    // Revue finale (Reviewer A) : « D:\\ » donnait le libellé « D: ».
    expect(folderName('D:\\')).toBe('');
    expect(folderName('c:/')).toBe('');
    expect(pickedFolderLabel('', 'D:\\', []).ok).toBe(false);
    // Un libellé tapé reste possible sur une racine.
    expect(pickedFolderLabel('disque', 'D:\\', [])).toEqual({ ok: true, label: 'disque' });
  });

  it('labelAfterRefusal : le libellé en cause ne remplit le champ que pour un conflit', () => {
    // Revue finale (Reviewer A, P2) : TOUT refus écrivait le libellé dérivé dans
    // le champ ; après une erreur de base, le dossier suivant partait sous le
    // nom de l'ancien.
    expect(labelAfterRefusal('conflict', 'notes', '')).toBe('notes');
    expect(labelAfterRefusal('refused_before_server', 'notes', '')).toBe('notes');
    expect(labelAfterRefusal('db_error', 'notes', '')).toBe('');
    expect(labelAfterRefusal('validation_failed', 'notes', 'tapé')).toBe('tapé');
  });

  it('folderName rend "" pour une racine POSIX', () => {
    expect(folderName('/')).toBe('');
  });
});
