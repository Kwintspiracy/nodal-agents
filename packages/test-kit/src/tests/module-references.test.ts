// module-references.test.ts — `scanForModuleReferences` voit toutes les façons
// d'atteindre un module, pas seulement l'`import` littéral d'une ligne (#698).
//
// La revue de la PR #699 l'a montré : un `import(pathToFileURL(resolved).href)`
// calculé, un `require(...)` ou un `import` sur deux lignes passaient la
// première garde, ligne à ligne. Chaque forme est écrite ici dans un vrai
// fichier, et la prose qui cite le nom ne doit pas sonner.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForModuleReferences } from '../architecture';

const root = mkdtempSync(join(tmpdir(), 'nodal-modrefs-'));
const src = join(root, 'src');
mkdirSync(join(src, 'lib'), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const LOADS: Record<string, string> = {
  'static.ts': "import Pkg from 'some-pkg';\n",
  'multiline.ts': "import {\n  thing,\n} from\n  'some-pkg';\n",
  'dynamic.ts': "const m = await import('some-pkg');\n",
  'require.cjs': "const m = require('some-pkg');\n",
  'computed.ts':
    "const entry = createRequire(anchor).resolve('some-pkg');\nawait import(pathToFileURL(entry).href);\n",
  'subpath.mjs': 'const m = await import("some-pkg/dist/binary.js");\n',
  'segments.ts': "const p = join(root, 'node_modules', 'some-pkg', 'dist');\n",
  'template.ts': 'const p = `${root}/node_modules/some-pkg/dist/index.js`;\n',
};
const PROSE: Record<string, string> = {
  'message.ts': "throw new Error('some-pkg introuvable depuis ici');\n",
  'platform.ts': "const p = '@some-pkg/linux-x64';\n",
  'sibling.ts': "import { x } from './some-pkg-binaries.ts';\n",
  'comment.ts': "// import Pkg from 'some-pkg';\n/* require('some-pkg') */\nexport {};\n",
};
for (const [name, body] of Object.entries({ ...LOADS, ...PROSE })) {
  writeFileSync(join(src, name), body);
}
writeFileSync(join(src, 'lib', 'door.ts'), "export const load = () => import('some-pkg');\n");

describe('scanForModuleReferences', () => {
  const found = scanForModuleReferences({
    srcDirs: [src],
    moduleName: 'some-pkg',
    allowFiles: ['lib/door.ts'],
  });
  const files = new Set(found.map((v) => v.file.split(/[\\/]/).pop()));

  it('catches every form that can load or resolve the module', () => {
    expect([...files].sort()).toEqual(Object.keys(LOADS).sort());
  });

  it('reports the line the name sits on, even in a multi-line import', () => {
    expect(found.find((v) => v.file.endsWith('multiline.ts'))?.line).toBe(4);
  });

  it('leaves the allowed door alone', () => {
    expect(found.some((v) => v.file.endsWith('door.ts'))).toBe(false);
  });
});
