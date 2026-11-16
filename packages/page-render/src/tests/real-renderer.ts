// real-renderer.ts — le VRAI moteur épinglé, pour les tests qui rendent (#1082).
//
// Il vit dans `NODALAI_RENDERER_DIR` quand la variable est posée (la CI
// l'installe là, une fois, en cache, par `nodal-agents renderer install`), et
// sinon dans `<dépôt>/.cache/page-renderer`, jamais dans le dossier de Nodal du
// développeur. Absent, le test ROUGIT en disant comment l'installer : un moteur
// manquant n'est jamais un test sauté en silence.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRendererStatus, RENDERER_DIR_ENV } from '../install';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/** Le dossier du moteur des tests. */
export function testRendererDir(): string {
  return process.env[RENDERER_DIR_ENV] ?? join(repoRoot, '.cache', 'page-renderer');
}

/** Le programme du moteur épinglé, ou une erreur qui dit comment l'installer. */
export async function realRendererPath(): Promise<string> {
  const dir = testRendererDir();
  const status = await readRendererStatus({ dir });
  if (status.kind === 'ready') return status.executablePath;
  throw new Error(
    `REAL_RENDERER_MISSING: the pinned page renderer is not installed in ${dir} (${status.kind}). ` +
      `Install it there: ${RENDERER_DIR_ENV}=${dir} pnpm --filter nodal-agents exec tsx src/index.ts renderer install`,
  );
}
