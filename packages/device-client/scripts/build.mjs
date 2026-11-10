// build.mjs — builds the device client to ONE file a device project copies as
// is: dist/nodal-device.mjs, and its types, dist/nodal-device.d.ts (#950).
//
// Both are self-contained. The JavaScript has no import at all (the client
// has no runtime dependency; esbuild inlines the generated protocol
// constants). The declarations inline the generated protocol types, so the
// .d.ts imports nothing either — not Zod, not the monorepo.
//
//   node scripts/build.mjs [outDir]       (default: dist)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'nodal-device.ts');
const GENERATED_SPECIFIER = './protocol.generated.ts';

const BANNER = [
  '// nodal-device: connect a device to Nodal. Copy this file into your project.',
  '// No dependency. Node 20+, Electron, browsers. Docs: "Connect a device".',
].join('\n');

/** The client as one ES module. */
async function buildJs(outDir) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    banner: { js: BANNER },
  });
  const [file] = result.outputFiles;
  const out = join(outDir, 'nodal-device.mjs');
  writeFileSync(out, file.text);
  return out;
}

/** The declarations of `file`, emitted in memory. */
function emitDeclarations() {
  const options = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    declaration: true,
    emitDeclarationOnly: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    outDir: join(root, '.d-ts'),
  };
  const out = new Map();
  const program = ts.createProgram([entry], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const host = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    };
    throw new Error(ts.formatDiagnostics(diagnostics, host));
  }
  program.emit(undefined, (fileName, text) => out.set(resolve(fileName), text));
  const pick = (name) => {
    const found = [...out].find(([f]) => f.endsWith(name));
    if (!found) throw new Error(`build: no declarations emitted for ${name}`);
    return found[1];
  };
  return { client: pick('nodal-device.d.ts'), protocol: pick('protocol.generated.d.ts') };
}

/** The client's declarations with the protocol's inlined in place of their import. */
function inlineProtocol(client, protocol) {
  const sf = ts.createSourceFile('nodal-device.d.ts', client, ts.ScriptTarget.ES2022, true);
  const kept = sf.statements.filter(
    (s) =>
      !(
        (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
        s.moduleSpecifier &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === GENERATED_SPECIFIER
      ),
  );
  const text = kept.map((s) => client.slice(s.getFullStart(), s.getEnd())).join('');
  const declarations = `${BANNER}\n${protocol.replace(/^\/\/.*\n|^\/\*.*\*\/\n/gm, '')}\n${text.trim()}\n`;
  if (/\bfrom\s+['"]/.test(declarations) || /\bimport\(/.test(declarations)) {
    throw new Error('build: the declarations still import something');
  }
  return declarations;
}

export async function buildClient(outDir = join(root, 'dist')) {
  mkdirSync(outDir, { recursive: true });
  const js = await buildJs(outDir);
  const { client, protocol } = emitDeclarations();
  const dts = join(outDir, 'nodal-device.d.ts');
  writeFileSync(dts, inlineProtocol(client, protocol));
  return { js, dts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const { js, dts } = await buildClient(outDir);
  console.log(`wrote ${js}\nwrote ${dts}`);
}
