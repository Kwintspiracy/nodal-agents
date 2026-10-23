// source-files.test.ts — ce qu'un scanner lit, c'est ce que git tient pour
// source. Un dossier de build, quel que soit son nom, n'est jamais lu.
//
// Le défaut (0.9.8, 23/10) : `pnpm bench:studio` écrit `apps/web/.next-studio`,
// ignoré par git, et les scanners portaient chacun leur liste de dossiers à
// sauter (`node_modules`, `dist`, `.next`…) que ce nom ne rejoignait pas.
// `release:check` rougissait sur les chunks compilés du Studio : 10 copies du
// préfixe MCP, 8 du dossier de Nodal, un tri par `requested_at`.
//
// Les arbres sont de vrais dépôts git temporaires, avec le `.gitignore` DU
// DÉPÔT : la preuve vaut pour les dossiers que le dépôt produit vraiment, et un
// dossier de build ajouté demain sans entrée dans le .gitignore se verrait
// d'abord dans `git status`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listSourceFiles,
  readSource,
  scanForMcpToolPrefixCopies,
  scanForModuleReferences,
  scanForMultilinePattern,
  scanForNodalHomeCopies,
  scanForPattern,
  type Violation,
} from '../architecture';
import { mkdtempSourceTree, sourceFilesUnder } from '../source-files';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Une source qui viole chaque règle exercée ici, en `.ts` comme en `.js`. */
const PLANTED = [
  "export const prefix = (s: string) => s.replace(/[^a-z0-9]/g, '_');",
  "export const home = join(homedir(), '.nodalai');",
  "export const mod = require('planted-module');",
  "export const marker = 'planted-marker';",
  '',
].join('\n');

/** Les dossiers que le .gitignore du dépôt range parmi les produits. */
const IGNORED = [
  '.next-studio/dev/server/chunks/ssr',
  '.next/server/chunks',
  'dist',
  'node_modules/some-pkg',
  '.turbo/cache',
  'coverage',
  'test-results',
  'out',
];

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function plant(tree: string, dir: string): void {
  mkdirSync(join(tree, dir), { recursive: true });
  writeFileSync(join(tree, dir, 'chunk.ts'), PLANTED);
  writeFileSync(join(tree, dir, 'chunk.js'), PLANTED);
}

/** Ce que CHAQUE scanner signale sous `srcDir`, en chemins relatifs triés. */
function reportedBy(srcDir: string): Record<string, string[]> {
  const files = (vs: readonly Violation[]): string[] =>
    [...new Set(vs.map((v) => relative(srcDir, v.file).split(sep).join('/')))].sort();
  const marker = { pattern: /planted-marker/, rule: 'planted' };
  return {
    scanForPattern: files(scanForPattern({ srcDir, extensions: ['.ts', '.js'] }, marker)),
    scanForMultilinePattern: files(scanForMultilinePattern({ srcDir }, marker)),
    scanForMcpToolPrefixCopies: files(scanForMcpToolPrefixCopies({ srcDir })),
    scanForNodalHomeCopies: files(scanForNodalHomeCopies({ srcDir, extensions: ['.ts', '.js'] })),
    scanForModuleReferences: files(
      scanForModuleReferences({ srcDirs: [srcDir], moduleName: 'planted-module', allowFiles: [] }),
    ),
    readSource: readSource({ srcDir }).includes('planted-marker') ? ['<read>'] : [],
    listSourceFiles: listSourceFiles(srcDir, { extensions: ['.ts', '.js'] })
      .map((f) => relative(srcDir, f).split(sep).join('/'))
      .sort(),
  };
}

const NOTHING = {
  scanForPattern: [],
  scanForMultilinePattern: [],
  scanForMcpToolPrefixCopies: [],
  scanForNodalHomeCopies: [],
  scanForModuleReferences: [],
  readSource: [],
  listSourceFiles: [],
};

describe('the invariant scanners read what git holds as source, never a build output', () => {
  let tree: string;
  let web: string;

  beforeAll(() => {
    tree = mkdtempSourceTree('source-files-');
    copyFileSync(join(REPO_ROOT, '.gitignore'), join(tree, '.gitignore'));
    web = join(tree, 'apps', 'web');
    mkdirSync(web, { recursive: true });
    // Le paquet existe dans le dépôt : git y suit au moins un fichier.
    writeFileSync(join(web, 'package.json'), '{ "name": "web" }\n');
    git(tree, 'add', '--', 'apps/web/package.json');
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  for (const dir of IGNORED) {
    it(`no scanner reports a violation planted under an ignored ${dir.split('/')[0]}/`, () => {
      plant(web, dir);
      try {
        expect(reportedBy(web)).toEqual(NOTHING);
      } finally {
        rmSync(join(web, dir.split('/')[0]!), { recursive: true, force: true });
      }
    });
  }

  it('every scanner reports the same file planted in a tracked source path', () => {
    plant(web, 'src');
    git(tree, 'add', '--', 'apps/web/src');
    try {
      expect(reportedBy(web)).toEqual({
        scanForPattern: ['src/chunk.js', 'src/chunk.ts'],
        scanForMultilinePattern: ['src/chunk.ts'],
        scanForMcpToolPrefixCopies: ['src/chunk.js', 'src/chunk.ts'],
        scanForNodalHomeCopies: ['src/chunk.js', 'src/chunk.ts'],
        scanForModuleReferences: ['src/chunk.js', 'src/chunk.ts'],
        readSource: ['<read>'],
        listSourceFiles: ['src/chunk.js', 'src/chunk.ts'],
      });
    } finally {
      git(tree, 'rm', '-r', '-q', '--cached', '--', 'apps/web/src');
      rmSync(join(web, 'src'), { recursive: true, force: true });
    }
  });

  // Une violation pas encore commitée est une violation : git la voit (`--others`).
  it('a new file not yet added, in a folder no .gitignore names, is source too', () => {
    plant(web, 'generated');
    try {
      expect(reportedBy(web).scanForMcpToolPrefixCopies).toEqual([
        'generated/chunk.js',
        'generated/chunk.ts',
      ]);
    } finally {
      rmSync(join(web, 'generated'), { recursive: true, force: true });
    }
  });

  it('a tracked file deleted from the disk is not listed', () => {
    plant(web, 'src');
    git(tree, 'add', '--', 'apps/web/src');
    unlinkSync(join(web, 'src', 'chunk.js'));
    try {
      expect(sourceFilesUnder(web).map((f) => relative(web, f).split(sep).join('/'))).toEqual([
        'package.json',
        'src/chunk.ts',
      ]);
    } finally {
      git(tree, 'rm', '-r', '-q', '--cached', '--', 'apps/web/src');
      rmSync(join(web, 'src'), { recursive: true, force: true });
    }
  });
});

// Une copie sans `.git` (un `git archive`, un dossier recopié) : aucun scanner ne
// devine ce qui est source. Il refuse, et dit pourquoi (invariant #4).
describe('without a git work tree, a scanner refuses instead of guessing', () => {
  it('outside any repository: names the directory and the reason', () => {
    const bare = mkdtempSync(join(tmpdir(), 'source-files-nogit-'));
    // git ne remonte pas au-dessus du dossier temporaire : sur une machine dont
    // le dossier personnel est un dépôt, il le trouverait (cas suivant).
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    // Forme longue : git compare le plafond au dossier courant, jamais à `RUNNER~1`.
    process.env.GIT_CEILING_DIRECTORIES = dirname(realpathSync.native(bare));
    try {
      writeFileSync(join(bare, 'chunk.ts'), PLANTED);
      expect(() => sourceFilesUnder(bare)).toThrow(/^source_files_need_git: .*source-files-nogit-/);
      expect(() => scanForNodalHomeCopies({ srcDir: bare })).toThrow(/source_files_need_git/);
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
      rmSync(bare, { recursive: true, force: true });
    }
  });

  // Une archive extraite DANS un autre dépôt (le dossier personnel en est un
  // sur la machine du propriétaire) : git répond avec ce dépôt-là. S'il ignore
  // la copie, il n'en montre rien, et zéro fichier lu serait zéro violation.
  it('inside another repository that ignores the copy: refuses, the folder holds files git hides', () => {
    const outer = mkdtempSourceTree('source-files-outer-');
    try {
      writeFileSync(join(outer, '.gitignore'), 'archive/\n');
      const copy = join(outer, 'archive', 'packages', 'x', 'src');
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, 'chunk.ts'), PLANTED);
      expect(() => sourceFilesUnder(copy)).toThrow(
        /^source_files_none_visible: .*archive.* holds files, and git shows none of them as source/,
      );
      expect(() => scanForNodalHomeCopies({ srcDir: copy })).toThrow(/source_files_none_visible/);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  // S'il ne l'ignore pas, git lit la copie avec les .gitignore qu'elle porte :
  // ses sources sont lues, son dossier de build ne l'est pas.
  it("inside another repository that does not ignore it: reads the copy by the copy's own .gitignore", () => {
    const outer = mkdtempSourceTree('source-files-outer-');
    try {
      const archive = join(outer, 'archive');
      mkdirSync(archive, { recursive: true });
      copyFileSync(join(REPO_ROOT, '.gitignore'), join(archive, '.gitignore'));
      const web = join(archive, 'apps', 'web');
      plant(web, 'src');
      plant(web, '.next-studio/dev/server/chunks');
      expect(reportedBy(web).scanForMcpToolPrefixCopies).toEqual(['src/chunk.js', 'src/chunk.ts']);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

// Ce que la liste rend quand elle ne trouve RIEN. Un dossier qui n'existe pas
// (un paquet renommé, une racine fausse) ou dont git ne montre rien alors qu'il
// contient des fichiers ferait passer chaque garde au vert sans rien lire : la
// liste refuse, avec la raison (invariant #4). Un dossier vraiment vide n'a rien
// à cacher : il rend une liste vide.
describe('a scan that would read nothing while there is something to read fails loud', () => {
  let tree: string;

  beforeAll(() => {
    tree = mkdtempSourceTree('source-files-nothing-');
    copyFileSync(join(REPO_ROOT, '.gitignore'), join(tree, '.gitignore'));
    writeFileSync(join(tree, 'package.json'), '{ "name": "root" }\n');
    git(tree, 'add', '--', '.gitignore', 'package.json');
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  it('a folder that does not exist: every scanner refuses, naming it', () => {
    const missing = join(tree, 'packages', 'renamed', 'src');
    expect(() => sourceFilesUnder(missing)).toThrow(
      /^source_files_dir_missing: .*renamed.* does not exist/,
    );
    expect(() => listSourceFiles(missing)).toThrow(/source_files_dir_missing/);
    expect(() => scanForNodalHomeCopies({ srcDir: missing })).toThrow(/source_files_dir_missing/);
    expect(() =>
      scanForModuleReferences({ srcDirs: [missing], moduleName: 'x', allowFiles: [] }),
    ).toThrow(/source_files_dir_missing/);
  });

  it('a folder that holds only ignored files: refuses', () => {
    plant(tree, 'apps/web/.next-studio/dev');
    try {
      expect(() => sourceFilesUnder(join(tree, 'apps', 'web', '.next-studio'))).toThrow(
        /^source_files_none_visible: .*\.next-studio/,
      );
    } finally {
      rmSync(join(tree, 'apps'), { recursive: true, force: true });
    }
  });

  // Le bon dépôt, un dossier neuf dont rien n'est encore ajouté : git le montre
  // (`--others`), il est lu. Ce n'est pas une copie dans un autre dépôt.
  it('a new package of the repository, nothing added yet: its files are source', () => {
    plant(tree, 'packages/new/src');
    try {
      const src = join(tree, 'packages', 'new', 'src');
      expect(sourceFilesUnder(src).map((f) => relative(src, f).split(sep).join('/'))).toEqual([
        'chunk.js',
        'chunk.ts',
      ]);
      expect(reportedBy(src).scanForMcpToolPrefixCopies).toEqual(['chunk.js', 'chunk.ts']);
    } finally {
      rmSync(join(tree, 'packages'), { recursive: true, force: true });
    }
  });

  it('an empty folder: nothing to read, nothing hidden, an empty list', () => {
    const empty = join(tree, 'empty', 'nested');
    mkdirSync(empty, { recursive: true });
    try {
      expect(sourceFilesUnder(join(tree, 'empty'))).toEqual([]);
    } finally {
      rmSync(join(tree, 'empty'), { recursive: true, force: true });
    }
  });
});

// Le dépôt lui-même : plus aucun test ne garde SA liste de dossiers de build à
// sauter. Une telle liste a raté `.next-studio` ; la suivante raterait le
// suivant. Un test qui parcourt le dépôt appelle `listSourceFiles`.
describe('no test of the repository walks it with its own list of build folders', () => {
  const BUILD = String.raw`node_modules|\.next[\w-]*|dist|\.turbo|out|coverage|build|test-results|playwright-report`;
  const OWN_LIST = new RegExp(
    [
      String.raw`(?:===|!==)\s*['"](?:${BUILD})['"]`,
      String.raw`['"](?:${BUILD})['"]\s*(?:===|!==)`,
      String.raw`new Set\(\[[^\]]*['"](?:${BUILD})['"]`,
      String.raw`\[[^\]]*['"](?:${BUILD})['"][^\]]*\]\s*\.(?:includes|some)\(`,
    ].join('|'),
  );
  const TEST_PATH = /(^|[\\/])(tests|__tests__)[\\/]|\.test\.[^.]+$/;

  function offenders(): string[] {
    return ['apps', 'packages', 'scripts']
      .flatMap((top) =>
        listSourceFiles(join(REPO_ROOT, top), {
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'],
        }),
      )
      .map((f) => relative(REPO_ROOT, f).split(sep).join('/'))
      .filter(
        (rel) => TEST_PATH.test(rel) && rel !== 'packages/test-kit/src/tests/source-files.test.ts',
      )
      .filter((rel) => {
        const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
        return /\breaddir(?:Sync)?\(/.test(text) && OWN_LIST.test(text);
      });
  }

  it('finds none in apps/, packages/ and scripts/', () => {
    expect(offenders()).toEqual([]);
  });

  it('would catch the walkers it replaced', () => {
    const old = [
      "if (nom === 'node_modules' || nom === '.next') continue;",
      "const SKIP_DIRS = new Set(['node_modules', '.next', 'tests']);",
      "if (!['node_modules', 'dist', '.next'].includes(e)) walk(full, acc);",
      "const skip = new Set([\n    'node_modules',\n    'dist',\n  ]);",
    ];
    for (const line of old) expect(OWN_LIST.test(line), line).toBe(true);
    expect(OWN_LIST.test("await mkdir(join(ws, 'node_modules'), { recursive: true });")).toBe(
      false,
    );
  });
});
