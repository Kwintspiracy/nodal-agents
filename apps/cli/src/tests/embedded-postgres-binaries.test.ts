// embedded-postgres-binaries.test.ts — ce que `up` dit quand la porte npm a
// sauté le paquet de binaires (issue #247).
//
// Le rapport du propriétaire, 19/09/2026 : `npm install nodal-agents@latest`
// s'est terminé sur `npm warn allow-scripts ... @embedded-postgres/windows-x64`
// puis « ça n'a pas marché ». Ce que ces cas tiennent, c'est la PHRASE : elle
// nomme le paquet et la commande, sinon elle ne sert à rien.
//
// Les binaires réels ne sont pas mis en scène : la règle est pure, le disque
// est injecté. Un seul cas touche la vraie installation, et c'est le seul qui
// prouve que la résolution du paquet optionnel marche vraiment.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  embeddedPostgresPackageName,
  inspectEmbeddedPostgres,
  platformPackageDir,
  probeEmbeddedPostgres,
  readSymlinkManifest,
  type PlatformBinaries,
} from '../lib/embedded-postgres-binaries.ts';

/** Une installation macOS complète : trois binaires, dix-sept liens présents. */
const PKG_DIR = '/opt/app/node_modules/@embedded-postgres/darwin-arm64';
const BINARIES: PlatformBinaries = {
  pg_ctl: `${PKG_DIR}/native/bin/pg_ctl`,
  initdb: `${PKG_DIR}/native/bin/initdb`,
  postgres: `${PKG_DIR}/native/bin/postgres`,
};
const MANIFEST = [
  { source: 'native/lib/libcrypto.3.dylib', target: 'native/lib/libcrypto.dylib' },
  { source: 'native/lib/libedit.0.dylib', target: 'native/lib/libedit.dylib' },
];

/** Le disque, en table : tout ce qui n'est pas listé n'existe pas. */
function diskWith(present: readonly string[]): (path: string) => boolean {
  const set = new Set(present.map((p) => p.replace(/\\/g, '/')));
  return (path: string) => set.has(path.replace(/\\/g, '/'));
}

const ALL_LINKS = MANIFEST.map((entry) => `${PKG_DIR}/${entry.target}`);
const ALL_BINARIES = [BINARIES.pg_ctl, BINARIES.initdb, BINARIES.postgres];

describe('embedded Postgres binaries @cap:installer-et-demarrer/moteur', () => {
  it('says nothing when the binaries and the links are all there', () => {
    const verdict = inspectEmbeddedPostgres({
      packageName: '@embedded-postgres/darwin-arm64',
      binaries: BINARIES,
      packageDir: PKG_DIR,
      symlinks: MANIFEST,
      exists: diskWith([...ALL_BINARIES, ...ALL_LINKS]),
    });
    expect(verdict).toEqual({ ok: true, packageName: '@embedded-postgres/darwin-arm64' });
  });

  it('a missing binary names the package, the file, and the command to type', () => {
    const verdict = inspectEmbeddedPostgres({
      packageName: '@embedded-postgres/darwin-arm64',
      binaries: BINARIES,
      packageDir: PKG_DIR,
      symlinks: MANIFEST,
      exists: diskWith([BINARIES.pg_ctl, BINARIES.initdb, ...ALL_LINKS]),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('BINARIES_MISSING');
    expect(verdict.missing).toEqual([BINARIES.postgres]);
    expect(verdict.message).toContain('@embedded-postgres/darwin-arm64');
    expect(verdict.message).toContain('npm approve-scripts @embedded-postgres/darwin-arm64');
    expect(verdict.message).toContain('npm install -g nodal-agents@latest');
    expect(verdict.message).toContain(BINARIES.postgres);
  });

  it('a promised link that is absent is named as npm’s install-script gate', () => {
    const verdict = inspectEmbeddedPostgres({
      packageName: '@embedded-postgres/darwin-arm64',
      binaries: BINARIES,
      packageDir: PKG_DIR,
      symlinks: MANIFEST,
      exists: diskWith([...ALL_BINARIES, `${PKG_DIR}/native/lib/libedit.dylib`]),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('HYDRATION_SKIPPED');
    expect(verdict.missing).toEqual([join(PKG_DIR, 'native/lib/libcrypto.dylib')]);
    expect(verdict.message).toContain("npm's install-script gate skipped");
    expect(verdict.message).toContain('@embedded-postgres/darwin-arm64');
    expect(verdict.message).toContain('npm approve-scripts @embedded-postgres/darwin-arm64');
  });

  // Le manifeste Windows vaut `[]` dans le paquet publié : le script d'install
  // n'y crée aucun lien. Refuser de démarrer là-dessus inventerait une panne.
  it('an empty manifest is not a fault, which is exactly the Windows case', () => {
    const verdict = inspectEmbeddedPostgres({
      packageName: '@embedded-postgres/windows-x64',
      binaries: BINARIES,
      packageDir: PKG_DIR,
      symlinks: [],
      exists: diskWith(ALL_BINARIES),
    });
    expect(verdict).toEqual({ ok: true, packageName: '@embedded-postgres/windows-x64' });
  });

  it('an unreadable manifest is read as empty, not as a wall', () => {
    const verdict = inspectEmbeddedPostgres({
      packageName: '@embedded-postgres/linux-x64',
      binaries: BINARIES,
      packageDir: PKG_DIR,
      symlinks: null,
      exists: diskWith(ALL_BINARIES),
    });
    expect(verdict.ok).toBe(true);
  });

  it('a package that cannot be loaded at all says so, with the same command', () => {
    const verdict = inspectEmbeddedPostgres({
      packageName: '@embedded-postgres/linux-x64',
      binaries: null,
      packageDir: null,
      symlinks: null,
      exists: diskWith([]),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('PACKAGE_MISSING');
    expect(verdict.message).toContain('@embedded-postgres/linux-x64 is not installed');
    expect(verdict.message).toContain('npm approve-scripts @embedded-postgres/linux-x64');
  });

  it('a platform with no build is refused without naming a package', () => {
    const verdict = inspectEmbeddedPostgres({
      packageName: null,
      binaries: null,
      packageDir: null,
      symlinks: null,
      exists: diskWith([]),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('UNSUPPORTED_PLATFORM');
    expect(verdict.message).not.toContain('approve-scripts');
  });
});

describe('embedded Postgres package name @cap:installer-et-demarrer/moteur', () => {
  // La table de `embedded-postgres/dist/binary.js`, recopiée : si elle diverge,
  // le message nomme un paquet que personne ne peut approuver.
  it.each([
    ['darwin', 'arm64', '@embedded-postgres/darwin-arm64'],
    ['darwin', 'x64', '@embedded-postgres/darwin-x64'],
    ['linux', 'x64', '@embedded-postgres/linux-x64'],
    ['linux', 'arm64', '@embedded-postgres/linux-arm64'],
    ['linux', 'arm', '@embedded-postgres/linux-arm'],
    ['linux', 'ia32', '@embedded-postgres/linux-ia32'],
    ['linux', 'ppc64', '@embedded-postgres/linux-ppc64'],
    ['win32', 'x64', '@embedded-postgres/windows-x64'],
  ])('%s/%s needs %s', (platform, arch, expected) => {
    expect(embeddedPostgresPackageName(platform, arch)).toBe(expected);
  });

  it.each([
    ['win32', 'arm64'],
    ['darwin', 'ia32'],
    ['freebsd', 'x64'],
  ])('%s/%s has no build', (platform, arch) => {
    expect(embeddedPostgresPackageName(platform, arch)).toBeNull();
  });
});

describe('embedded Postgres manifest and layout @cap:installer-et-demarrer/moteur', () => {
  it('reads the entries of a real pg-symlinks.json and drops malformed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nodal-symlinks-'));
    try {
      mkdirSync(join(dir, 'native'));
      writeFileSync(
        join(dir, 'native', 'pg-symlinks.json'),
        JSON.stringify([
          { source: 'native/lib/libpq.so.5.18', target: 'native/lib/libpq.so' },
          { source: 42 },
          'nonsense',
        ]),
      );
      expect(readSymlinkManifest(dir)).toEqual([
        { source: 'native/lib/libpq.so.5.18', target: 'native/lib/libpq.so' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an absent manifest reads as no links at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nodal-symlinks-'));
    try {
      expect(readSymlinkManifest(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the package root is three levels above native/bin/pg_ctl', () => {
    expect(platformPackageDir(BINARIES).replace(/\\/g, '/')).toBe(PKG_DIR);
  });

  // Le seul cas qui touche l'installation réelle. Il prouve la résolution du
  // paquet optionnel, que rien d'autre n'exerce : `embedded-postgres` n'expose
  // que `dist/index.js`, et `binary.js` se charge par chemin.
  it('this install is complete, and the probe can see it', async () => {
    const verdict = await probeEmbeddedPostgres();
    expect(verdict.ok ? '' : verdict.message).toBe('');
    expect(verdict.ok).toBe(true);
  });
});
