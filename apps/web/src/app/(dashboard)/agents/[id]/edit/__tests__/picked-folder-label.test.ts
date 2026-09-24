// picked-folder-label.test.ts — le libellé d'un dossier choisi par Browse…
// (#461, revue de la PR #467).
//
// Valider Browse… attache le dossier sans écran intermédiaire : ce qui ne peut
// pas s'attacher doit le dire, avec le libellé en cause, et jamais rentrer en
// silence (invariant #4).

import { describe, it, expect } from 'vitest';
import { folderName, pickedFolderLabel } from '../picked-folder-label.ts';

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

  it('folderName rend "" pour une racine POSIX', () => {
    expect(folderName('/')).toBe('');
  });
});
