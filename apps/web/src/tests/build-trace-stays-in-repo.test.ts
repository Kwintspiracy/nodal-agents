// @vitest-environment node
//
// Le traceur de Next ne suit jamais un chemin hors de sa base.
//
// POURQUOI (05/10/2026). `next build` traçait le dossier personnel de la machine
// qui construit — 1 776 635 fichiers par page, 24,5 Go de tas, 16 min. Le
// traceur (@vercel/nft, recopié dans Next) ÉVALUE `os.homedir()` et
// `os.tmpdir()` au moment du build, et parcourt en entier le dossier qu'il en
// tire. Son garde « hors de la base » ne voyait que les chemins relatifs en
// `..` ; entre deux lecteurs Windows, `path.relative` rend un chemin ABSOLU, et
// le garde le laissait passer. patches/next@16.3.0.patch le referme pour tous
// les appelants de Next à la fois.
//
// Ce test appelle le module EXACT que Next appelle
// (`next/dist/compiled/@vercel/nft`), sur des modules qui font ce que fait le
// code du dépôt : `homedir()` nu, joint à un sous-dossier qui existe, et
// `tmpdir()`. Le dossier personnel est un faux, plein de fichiers, posé hors de
// la base — sur la même racine, et sur une AUTRE racine quand la machine en a
// une (Windows : dépôt sur D:, dossier personnel sur C:, comme chez Quentin et
// sur les runners Windows de GitHub). Sous Linux et macOS il n'existe qu'une
// racine : le cas « autre lecteur » y est sauté, et c'est la réponse — il n'y
// existe pas.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface NftJob {
  fileList: Set<string>;
}
interface NftModule {
  nodeFileTrace(
    files: string[],
    opts: { base: string; processCwd: string; ignore?: (path: string) => boolean },
  ): Promise<NftJob>;
}

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const nft = require('next/dist/compiled/@vercel/nft') as NftModule;

// Les modules tracés : la forme de chaque appel du dépôt qui a fui le 05/10, et
// ce que chacun tire du dossier personnel quand rien ne l'arrête (le témoin).
const FIXTURES: Record<string, { src: string[]; leaks: string[] }> = {
  // apps/web/src/lib/actions.ts (navigateur de dossiers) : le dossier entier.
  'bare-homedir.mjs': {
    src: [
      "import { homedir } from 'node:os';",
      'export function a() { const home = homedir(); return { home }; }',
    ],
    leaks: [
      join('.nodalai', 'secrets.json'),
      join('.nodalai', 'workspaces', 'projet', 'notes.md'),
      join('Pictures', 'photo.jpg'),
    ],
  },
  // workspace-roots.ts, workspaces-root.ts, checkpoints/root.ts…
  'joined-homedir.mjs': {
    src: [
      "import { homedir } from 'node:os';",
      "import { join } from 'node:path';",
      "export const root = join(homedir(), '.nodalai', 'workspaces');",
    ],
    leaks: [join('.nodalai', 'workspaces', 'projet', 'notes.md')],
  },
  'require-homedir.cjs': {
    src: [
      "const os = require('os');",
      "const path = require('path');",
      "module.exports = path.join(os.homedir(), '.nodalai');",
    ],
    leaks: [join('.nodalai', 'secrets.json'), join('.nodalai', 'workspaces', 'projet', 'notes.md')],
  },
  // Même mécanisme, autre fonction : le traceur évalue aussi `tmpdir()`.
  'joined-tmpdir.mjs': {
    src: [
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "export const cache = join(tmpdir(), '.nodalai');",
    ],
    leaks: [join('.nodalai', 'secrets.json'), join('.nodalai', 'workspaces', 'projet', 'notes.md')],
  },
};

const ENV_KEYS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'] as const;

/** Un faux dossier personnel, avec ce qu'un vrai contient. */
function fakeHome(dir: string): string {
  mkdirSync(join(dir, '.nodalai', 'workspaces', 'projet'), { recursive: true });
  mkdirSync(join(dir, 'Pictures'), { recursive: true });
  writeFileSync(join(dir, '.nodalai', 'workspaces', 'projet', 'notes.md'), 'privé');
  writeFileSync(join(dir, '.nodalai', 'secrets.json'), '{}');
  writeFileSync(join(dir, 'Pictures', 'photo.jpg'), 'jpg');
  return dir;
}

/** Trace un fixture avec le dossier personnel (et temporaire) pointé sur `home`. */
async function traceWithHome(base: string, fixture: string, home: string): Promise<string[]> {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) process.env[k] = home;
  try {
    // Pas d'`ignore` : c'est le garde de nft lui-même qui est jugé, pas celui
    // d'un appelant. Next en passe un ; le passage webpack des pages, celui qui
    // a fui, ne connaissait que des motifs.
    const job = await nft.nodeFileTrace([join(base, fixture)], { base, processCwd: base });
    return [...job.fileList].sort();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Dans le dépôt (ignoré par git), pour que la base soit sur le lecteur du dépôt.
const sandboxParent = resolve(here, '..', '..', '.cache');
let sandbox = '';
let base = '';
let sameRootHome = '';
let otherRootHome = '';
const otherRootAvailable = parse(tmpdir()).root.toLowerCase() !== parse(here).root.toLowerCase();

beforeAll(() => {
  mkdirSync(sandboxParent, { recursive: true });
  sandbox = mkdtempSync(join(sandboxParent, 'trace-'));
  base = join(sandbox, 'base');
  mkdirSync(base);
  for (const [name, { src }] of Object.entries(FIXTURES)) {
    writeFileSync(join(base, name), src.join('\n') + '\n');
  }
  sameRootHome = fakeHome(join(sandbox, 'home'));
  otherRootHome = fakeHome(mkdtempSync(join(tmpdir(), 'nodal-fake-home-')));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(otherRootHome, { recursive: true, force: true });
});

describe('le traceur de Next reste dans sa base', () => {
  for (const [fixture, { leaks }] of Object.entries(FIXTURES)) {
    it(`${fixture} — témoin : un dossier personnel DANS la base est tracé`, async () => {
      // Sans ce témoin, les cas suivants passeraient aussi avec un traceur qui
      // n'évaluerait plus ce chemin du tout, et ne prouveraient rien.
      const files = await traceWithHome(sandbox, join('base', fixture), sameRootHome);
      expect(files).toEqual([join('base', fixture), ...leaks.map((l) => join('home', l))].sort());
    });

    it(`${fixture} : un dossier personnel hors de la base, même racine, n'est pas tracé`, async () => {
      expect(await traceWithHome(base, fixture, sameRootHome)).toEqual([fixture]);
    });

    it(`${fixture} : le dépôt DANS le dossier personnel (la CI Linux, /home/runner/work/…), rien du dossier n'est tracé`, async () => {
      // Le dossier personnel est ici le parent de la base : `sandbox` contient
      // `base/` et `home/`. Le traceur évalue `sandbox`, et ne doit en garder
      // ni `home/`, ni les fixtures voisins.
      expect(await traceWithHome(base, fixture, sandbox)).toEqual([fixture]);
    });

    it.runIf(otherRootAvailable)(
      `${fixture} : un dossier personnel sur un AUTRE lecteur n'est pas tracé`,
      async () => {
        expect(await traceWithHome(base, fixture, otherRootHome)).toEqual([fixture]);
      },
    );
  }
});
