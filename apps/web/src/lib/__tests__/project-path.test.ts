// project-path.test.ts — la règle du sous-dossier, et le chemin qu'elle
// produit. C'est la MÊME règle que celle appliquée par `createProjectAction` :
// si l'aperçu montrait un chemin que l'action refuse, la modale promettrait un
// dossier qui ne serait jamais créé.

import { describe, it, expect } from 'vitest';
import { isSafeSubfolder, previewProjectPath } from '../project-path.ts';

const terrain = 'D:/Terrain';

describe('isSafeSubfolder', () => {
  it('accepte des segments relatifs, et le vide', () => {
    expect(isSafeSubfolder('')).toBe(true);
    expect(isSafeSubfolder('app')).toBe(true);
    expect(isSafeSubfolder('app/web')).toBe(true);
    expect(isSafeSubfolder('app\\web')).toBe(true);
    expect(isSafeSubfolder('.hidden')).toBe(true);
  });

  it('refuse tout ce qui sort du terrain, plutôt que de le nettoyer', () => {
    expect(isSafeSubfolder('..')).toBe(false);
    expect(isSafeSubfolder('../evil')).toBe(false);
    expect(isSafeSubfolder('app/../..')).toBe(false);
    expect(isSafeSubfolder('.')).toBe(false);
    expect(isSafeSubfolder('/etc')).toBe(false);
    expect(isSafeSubfolder('//serveur/partage')).toBe(false);
    expect(isSafeSubfolder('C:/Windows')).toBe(false);
    expect(isSafeSubfolder('c:\\Windows')).toBe(false);
    expect(isSafeSubfolder('app//web')).toBe(false);
    expect(isSafeSubfolder('app/\u0000')).toBe(false);
  });
});

describe('previewProjectPath', () => {
  it('le vide, c’est le terrain lui-même', () => {
    expect(previewProjectPath(terrain, '')).toBe('D:/Terrain');
    expect(previewProjectPath('D:/Terrain/', '')).toBe('D:/Terrain');
  });

  it('joint le sous-dossier au terrain, antislashs normalisés', () => {
    expect(previewProjectPath(terrain, 'app')).toBe('D:/Terrain/app');
    expect(previewProjectPath('D:\\Terrain', 'app\\web')).toBe('D:/Terrain/app/web');
    expect(previewProjectPath('D:/Terrain/', 'app')).toBe('D:/Terrain/app');
  });

  it('une saisie refusée n’a pas d’aperçu — jamais un chemin approximatif', () => {
    expect(previewProjectPath(terrain, '../evil')).toBeNull();
    expect(previewProjectPath(terrain, 'C:/Windows')).toBeNull();
  });
});
