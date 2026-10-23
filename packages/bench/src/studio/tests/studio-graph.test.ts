// studio-graph.test.ts — ce que le serveur de Bench Studio compile n'emploie aucun motif qu'un bundler suit.
//
// Bench Studio sert ses pages par Next (Turbopack) depuis apps/web, qui n'importe
// du banc que ses points d'entrée (`@nodal-agents/bench/studio`, `/results`).
// Turbopack suit TOUT le graphe de ces modules pour le compiler, et il suit
// aussi, comme une dépendance à embarquer, les résolutions que le module fait
// par LUI-MÊME : `createRequire(import.meta.url).resolve('tsx/cli')` dans la
// déclaration de l'imprimante du banc (atteinte par la page : studio/runtime.ts
// -> workflows/session.ts `readScenarioEnv` -> workflows/stack.ts
// `readBenchPrinter`) lui a fait embarquer tsx, puis esbuild et son binaire
// natif, et la page répondait 500 (« Unknown module type » sur esbuild.exe,
// main du 23/10).
//
// La règle, générale : depuis chaque point d'entrée du paquet, aucun module
// atteint n'emploie un des motifs que Turbopack et webpack suivent comme une
// dépendance : `require.resolve`, `createRequire(import.meta.url)` (le
// `require` du module), `import.meta.resolve`, `new URL('./x', import.meta.url)`.
// Un module qui doit trouver un fichier sur le disque part d'une racine sur
// le disque (la déclaration : `createRequire(<paquet du banc>/package.json)`,
// mesuré servi par le Studio le 23/10). Et le graphe n'atteint ni le code de
// campagne ni le serveur de l'imprimante : ceux-là ne servent que le CLI. Le graphe est lu par le compilateur
// TypeScript lui-même (`ts.createSourceFile`) : un texte dans une chaîne (le
// source du courtier MXC) n'est pas un appel. Servir la page en CI coûterait
// une compilation Next complète par PR pour la même preuve ; ce contrôle prend
// une seconde et nomme la chaîne.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const BENCH = resolve(__dirname, '..', '..', '..');

/** Ce que le serveur du Studio ne doit jamais compiler : ce qui ne sert que le CLI. */
const CLI_ONLY = [
  join(BENCH, 'src', 'campaign') + '/',
  join(BENCH, 'src', 'printer', 'server.ts'),
  join(BENCH, 'src', 'printer', 'main.ts'),
].map((p) => p.replace(/\\/g, '/'));

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

interface Edge {
  readonly spec: string;
  /** `import type` / `export type` de déclaration : effacé à la compilation, jamais suivi. */
  readonly typeOnly: boolean;
}

/** Ce qu'un module importe, et ce qu'il résout par nom ou désigne comme fichier, lu dans son AST. */
export function readModule(file: string, text: string): { edges: Edge[]; resolves: string[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  const resolves: string[] = [];
  const literal = (n: ts.Node | undefined): string | null =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
  const isImportMeta = (n: ts.Node): boolean =>
    ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword;
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const spec = literal(n.moduleSpecifier);
      // Seul `import type …` est effacé : `import { type X }` reste un import
      // pour ses effets sous `verbatimModuleSyntax`, et le bundler le suit.
      const typeOnly = !!n.importClause?.isTypeOnly;
      if (spec) edges.push({ spec, typeOnly });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const spec = literal(n.moduleSpecifier);
      // De même : seul `export type { … } from` est effacé.
      const typeOnly = n.isTypeOnly;
      if (spec) edges.push({ spec, typeOnly });
    } else if (ts.isCallExpression(n)) {
      const arg = literal(n.arguments[0]);
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && arg) {
        edges.push({ spec: arg, typeOnly: false });
      } else if (ts.isIdentifier(n.expression) && n.expression.text === 'require' && arg) {
        edges.push({ spec: arg, typeOnly: false });
      } else if (
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'createRequire' &&
        n.arguments[0] &&
        ts.isPropertyAccessExpression(n.arguments[0]) &&
        isImportMeta(n.arguments[0].expression) &&
        n.arguments[0].name.text === 'url'
      ) {
        resolves.push('takes the module’s own require (createRequire(import.meta.url))');
      } else if (
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'resolve' &&
        arg !== null
      ) {
        const target = n.expression.expression;
        if ((ts.isIdentifier(target) && target.text === 'require') || isImportMeta(target))
          resolves.push(`resolves "${arg}" at run time`);
      }
    } else if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'URL'
    ) {
      const [first, second] = n.arguments ?? [];
      const rel = literal(first);
      if (
        rel?.startsWith('.') &&
        second &&
        ts.isPropertyAccessExpression(second) &&
        isImportMeta(second.expression) &&
        second.name.text === 'url'
      )
        resolves.push(`points the bundler at the file "${rel}"`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { edges, resolves };
}

/** Le graphe des modules du banc atteints depuis `entry` (imports de valeurs, statiques ou dynamiques). */
function walk(entry: string): Map<string, string | null> {
  const parent = new Map<string, string | null>([[entry, null]]);
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.shift()!;
    for (const e of readModule(file, readFileSync(file, 'utf8')).edges) {
      if (e.typeOnly || !e.spec.startsWith('.')) continue;
      const next = resolveRelative(file, e.spec);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        todo.push(next);
      }
    }
  }
  return parent;
}

const rel = (f: string): string => relative(BENCH, f).replace(/\\/g, '/');
function chainTo(parent: Map<string, string | null>, file: string): string {
  const out: string[] = [];
  for (let f: string | null = file; f; f = parent.get(f) ?? null) out.unshift(rel(f));
  return out.join(' -> ');
}

/** Ce que le graphe d'une entrée fait qu'un bundler ne sait pas servir : une ligne par trouvaille, avec sa chaîne. */
export function studioGraphFindings(
  entry: string,
  cliOnly: readonly string[] = CLI_ONLY,
): { reached: number; findings: string[] } {
  const parent = walk(entry);
  const findings: string[] = [];
  for (const file of parent.keys()) {
    const norm = file.replace(/\\/g, '/');
    if (cliOnly.some((p) => (p.endsWith('/') ? norm.startsWith(p) : norm === p)))
      findings.push(`reaches CLI-only code: ${chainTo(parent, file)}`);
    for (const r of readModule(file, readFileSync(file, 'utf8')).resolves)
      findings.push(`${r}: ${chainTo(parent, file)}`);
  }
  return { reached: parent.size, findings: [...new Set(findings)].sort() };
}

describe('what the Bench Studio server compiles', () => {
  const pkg = JSON.parse(readFileSync(join(BENCH, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };

  it.each(Object.entries(pkg.exports))(
    'the export %s uses no pattern a bundler follows, and reaches no CLI-only code',
    (_name, target) => {
      const { reached, findings } = studioGraphFindings(resolve(BENCH, target));
      expect(reached).toBeGreaterThanOrEqual(1);
      expect(findings).toEqual([]);
    },
  );

  it('the studio entry really walks the bench: its data, the scenarios, the stack reads', () => {
    const parent = walk(resolve(BENCH, pkg.exports['./studio']!));
    const files = [...parent.keys()].map(rel);
    for (const f of ['src/studio/data.ts', 'src/workflows/scenarios.ts', 'src/workflows/stack.ts'])
      expect(files).toContain(f);
  });

  it('reads calls from the syntax tree, never from a string', () => {
    const r = readModule(
      'x.ts',
      [
        "import { createRequire } from 'node:module';",
        "import type { T } from './types-only';",
        "export { type U } from './also-types';",
        "const tsx = createRequire(import.meta.url).resolve('tsx/cli');",
        "const ok = createRequire(join(root, 'package.json')).resolve('tsx/cli');",
        "const p = require.resolve('esbuild');",
        "const m = import.meta.resolve('zod');",
        "const u = new URL('./main.ts', import.meta.url);",
        'const s = "createRequire(x).resolve(\'in-a-string\')";',
        "void import('./lazy');",
      ].join('\n'),
    );
    expect(r.resolves).toEqual([
      'takes the module’s own require (createRequire(import.meta.url))',
      'resolves "esbuild" at run time',
      'resolves "zod" at run time',
      'points the bundler at the file "./main.ts"',
    ]);
    expect(r.edges).toEqual([
      { spec: 'node:module', typeOnly: false },
      { spec: './types-only', typeOnly: true },
      { spec: './also-types', typeOnly: false },
      { spec: './lazy', typeOnly: false },
    ]);
  });
});

// Sous `verbatimModuleSyntax` (tsconfig.base.json), seul un `import type` /
// `export type` DE DÉCLARATION est effacé. `import { type X } from './m'` sort
// en `import {} from './m'` : un import pour ses effets, que le bundler suit et
// compile. La garde le suit donc aussi (revue de #866, passe 1).
describe('an inline type specifier still brings its module into the Studio graph', () => {
  const tree = mkdtempSync(join(tmpdir(), 'studio-graph-'));
  const campaign = join(tree, 'campaign');
  mkdirSync(campaign, { recursive: true });
  writeFileSync(
    join(campaign, 'run.ts'),
    'export type Campaign = { id: string };\nexport const started = 1;\n',
  );
  const cliOnly = [campaign.replace(/\\/g, '/') + '/'];
  const entryWith = (name: string, line: string): string => {
    const file = join(tree, name);
    writeFileSync(file, `${line}\nexport const x = 1;\n`);
    return file;
  };
  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  it.each([
    ['import-inline', "import { type Campaign } from './campaign/run';"],
    ['export-inline', "export { type Campaign } from './campaign/run';"],
    ['import-mixed', "import { type Campaign, started } from './campaign/run';"],
  ])('%s: a CLI-only module reached through it is a finding', (name, line) => {
    const { findings } = studioGraphFindings(entryWith(`${name}.ts`, line), cliOnly);
    expect(findings).toEqual([
      expect.stringMatching(/^reaches CLI-only code: .*campaign\/run\.ts$/),
    ]);
  });

  it.each([
    ['import-type', "import type { Campaign } from './campaign/run';"],
    ['export-type', "export type { Campaign } from './campaign/run';"],
  ])('%s: a declaration erased at compile time reaches nothing', (name, line) => {
    const { findings } = studioGraphFindings(entryWith(`${name}.ts`, line), cliOnly);
    expect(findings).toEqual([]);
  });
});
