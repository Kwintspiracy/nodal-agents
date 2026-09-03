import { describe, it, expect } from 'vitest';
import { projectKey, isWindowsPath, isAbsolutePath, normalizePath } from '../project-key';

describe('isAbsolutePath', () => {
  it('accepte les deux systèmes, refuse le relatif', () => {
    expect(isAbsolutePath('C:/Dev')).toBe(true);
    expect(isAbsolutePath('/srv/app')).toBe(true);
    expect(isAbsolutePath('//serveur/part')).toBe(true);
    expect(isAbsolutePath('relatif/app')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
  });
});

describe('projectKey', () => {
  it('replie la casse des chemins Windows à lettre de lecteur', () => {
    expect(projectKey('C:\\Dev\\App\\')).toBe('c:/dev/app');
    expect(projectKey('C:/Dev/App')).toBe(projectKey('c:\\dev\\app'));
  });

  it('replie la casse des partages UNC', () => {
    // La normalisation rend `\\serveur\part` sous la forme `//serveur/part` :
    // sans la seconde forme de isWindowsPath, un partage réseau serait traité
    // comme sensible à la casse et dupliquerait ses projets.
    expect(projectKey('\\\\serveur\\part\\App')).toBe('//serveur/part/app');
    expect(projectKey('//SERVEUR/part/App')).toBe('//serveur/part/app');
  });

  it('PRÉSERVE la casse des chemins POSIX — deux dossiers différents', () => {
    // Le cœur de la règle : sur un système sensible à la casse, confondre les
    // deux ferait qu'en masquer un masquerait l'autre.
    expect(projectKey('/srv/App')).toBe('/srv/App');
    expect(projectKey('/srv/App')).not.toBe(projectKey('/srv/app'));
  });

  it('ne confond pas un UNC et un chemin POSIX de même écriture', () => {
    expect(projectKey('//serveur/part/App')).not.toBe(projectKey('/serveur/part/app'));
  });

  it('ignore le slash final et les slashes redondants en fin', () => {
    expect(projectKey('D:/x/')).toBe(projectKey('D:/x'));
    expect(projectKey('/srv/App//')).toBe('/srv/App');
  });

  it('est idempotent — la clé d’une clé est la même clé', () => {
    for (const p of ['C:\\Dev\\App\\', '//srv/part/App', '/srv/App', 'D:/x/']) {
      expect(projectKey(projectKey(p))).toBe(projectKey(p));
    }
  });
});

describe('isWindowsPath', () => {
  it('reconnaît les deux formes, et rien d’autre', () => {
    expect(isWindowsPath('c:/dev')).toBe(true);
    expect(isWindowsPath('C:/Dev')).toBe(true);
    expect(isWindowsPath('//serveur/part')).toBe(true);
    expect(isWindowsPath('/srv/app')).toBe(false);
    expect(isWindowsPath('relatif/app')).toBe(false);
    // Un chemin Windows non normalisé n'est PAS reconnu : les appelants
    // normalisent d'abord (c'est ce que fait projectKey).
    expect(isWindowsPath('C:\\Dev')).toBe(false);
  });
});

describe('normalizePath', () => {
  it('uniformise les slashes et retire le slash final', () => {
    expect(normalizePath('C:\\Dev\\App\\')).toBe('C:/Dev/App');
    expect(normalizePath('/srv/app///')).toBe('/srv/app');
    expect(normalizePath('/')).toBe('');
  });
});
