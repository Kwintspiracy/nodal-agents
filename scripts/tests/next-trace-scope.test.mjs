// next-trace-scope.test.mjs — la porte qui refuse un build web dont le traçage
// est sorti du dépôt.
//
// Les manifestes sont écrits sur disque comme Next les écrit : un `.nft.json`
// par page, des chemins RELATIFS au dossier du manifeste, et deux manifestes du
// serveur à la racine de `.next`. Les assertions portent sur ce que la porte
// rend — quels manifestes, quels fichiers, quels dossiers — pas sur le fait
// qu'elle ait été appelée.
//
// Lancer depuis la racine : pnpm test:scripts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, parse } from 'node:path';
import { scanTracesOutsideRoot, formatTracesOutsideRoot } from '../lib/next-trace-scope.mjs';

let root;
let nextDir;

function writeManifest(relPath, files) {
  const p = join(nextDir, relPath);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify({ version: 1, files }));
  return p;
}

/** Un chemin tel que Next l'écrit : relatif au dossier du manifeste, en `/`. */
function relFrom(manifest, target) {
  return relative(join(manifest, '..'), target).replace(/\\/g, '/');
}

beforeEach(() => {
  // Le « dépôt » est un sous-dossier : son parent sert d'« extérieur ».
  const sandbox = mkdtempSync(join(tmpdir(), 'nodal-trace-scope-'));
  root = join(sandbox, 'repo');
  nextDir = join(root, 'apps', 'web', '.next');
  mkdirSync(nextDir, { recursive: true });
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('scanTracesOutsideRoot', () => {
  it('passe un build dont chaque manifeste reste dans le dépôt', () => {
    const page = join(nextDir, 'server', 'app', 'agents', 'page.js.nft.json');
    writeManifest('server/app/agents/page.js.nft.json', [
      relFrom(page, join(root, 'node_modules', 'react', 'index.js')),
      relFrom(page, join(nextDir, 'server', 'chunks', '123.js')),
    ]);
    writeManifest('next-server.js.nft.json', ['../../../node_modules/next/dist/server/next.js']);

    const scan = scanTracesOutsideRoot(nextDir, root);

    expect(scan.manifestsScanned).toBe(2);
    expect(scan.outside).toEqual([]);
    // La taille lue est celle des fichiers sur disque : le chiffre que le build
    // rapporte pour comparer un manifeste sain à un manifeste qui a fui.
    expect(scan.manifestBytes).toBeGreaterThan(100);
    expect(formatTracesOutsideRoot(scan, root)).toBeNull();
  });

  it('nomme le manifeste, le fichier et le dossier sortis du dépôt', () => {
    const page = join(nextDir, 'server', 'app', '(dashboard)', 'page.js.nft.json');
    const fuite = join(root, '..', 'home', 'quelqu-un', '.nodalai', 'workspaces', 'notes.md');
    writeManifest('server/app/(dashboard)/page.js.nft.json', [
      relFrom(page, join(root, 'node_modules', 'react', 'index.js')),
      relFrom(page, fuite),
    ]);

    const scan = scanTracesOutsideRoot(nextDir, root);

    expect(scan.outside).toEqual([
      {
        manifest: join('server', 'app', '(dashboard)', 'page.js.nft.json'),
        count: 1,
        examples: [resolve(fuite)],
      },
    ]);
    const report = formatTracesOutsideRoot(scan, root);
    expect(report).toContain(join('server', 'app', '(dashboard)', 'page.js.nft.json'));
    expect(report).toContain(resolve(fuite));
    expect(report).toContain('1 file');
  });

  it("attrape un chemin absolu — ce que Next écrit pour un fichier d'un AUTRE lecteur", () => {
    // Sous Windows, `path.relative` entre deux lecteurs rend un chemin absolu :
    // c'est la forme exacte des 1,77 M d'entrées du 05/10 (`C:\Users\…` dans
    // un build fait sur D:). Un chemin absolu qui ne descend pas du dépôt est
    // dehors, quelle que soit la plateforme.
    const ailleurs = resolve(parse(root).root, 'ailleurs', 'AppData', 'cache.bin');
    writeManifest('server/app/page.js.nft.json', [ailleurs.replace(/\\/g, '/')]);

    const scan = scanTracesOutsideRoot(nextDir, root);

    expect(scan.outside).toHaveLength(1);
    expect(scan.outside[0].examples).toEqual([ailleurs]);
  });

  it('ne garde que quelques exemples mais compte tout, et groupe par dossier', () => {
    const page = join(nextDir, 'server', 'app', 'page.js.nft.json');
    const home = join(root, '..', 'home', 'u');
    const files = [];
    for (let i = 0; i < 40; i++) files.push(relFrom(page, join(home, 'Pictures', `p${i}.jpg`)));
    for (let i = 0; i < 3; i++) files.push(relFrom(page, join(home, '.nodalai', `s${i}`)));
    writeManifest('server/app/page.js.nft.json', files);

    const scan = scanTracesOutsideRoot(nextDir, root);

    expect(scan.outside[0].count).toBe(43);
    expect(scan.outside[0].examples).toHaveLength(5);
    // Les dossiers les plus gros d'abord : c'est ce qu'on cherche en premier.
    expect(scan.directories[0]).toEqual({ dir: resolve(home, 'Pictures'), count: 40 });
    expect(scan.directories[1]).toEqual({ dir: resolve(home, '.nodalai'), count: 3 });
    expect(formatTracesOutsideRoot(scan, root)).toContain('43 files');
  });

  it("ne lit pas la copie de .next/standalone, dont les chemins relatifs n'ont plus de sens", () => {
    // build-pack recopie .next/server par-dessus la copie standalone ; ses
    // manifestes, relus depuis là, pointeraient trois dossiers trop haut.
    writeManifest('standalone/apps/web/.next/server/app/page.js.nft.json', [
      '../../../../../../../../../../../../ailleurs.js',
    ]);
    writeManifest('next-server.js.nft.json', ['../../../node_modules/next/dist/server/next.js']);

    const scan = scanTracesOutsideRoot(nextDir, root);

    expect(scan.manifestsScanned).toBe(1);
    expect(scan.outside).toEqual([]);
  });

  it("refuse un .next qui n'a aucun manifeste : rien vérifié n'est pas vert", () => {
    expect(() => scanTracesOutsideRoot(nextDir, root)).toThrow(/no \.nft\.json/i);
  });

  it('refuse un .next absent plutôt que de rendre « rien dehors »', () => {
    expect(() => scanTracesOutsideRoot(join(root, 'nulle-part'), root)).toThrow(/nulle-part/);
  });
});
