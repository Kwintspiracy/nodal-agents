// eslint-configs-accord.test.mjs — la garde qui aurait vu l'issue #249.
//
// Le dépôt a deux points d'entrée ESLint : `eslint.config.js` à la racine, que
// quelqu'un lance à la main, et `apps/web/eslint.config.mjs`, que la CI lance.
// Ils se contredisaient. Sept annotations `import()` d'`actions.ts` étaient
// rouges d'un côté et vertes de l'autre, et trente-deux `eslint-disable` de
// règles Next étaient rouges à la racine, qui ne chargeait pas le plugin.
//
// Une règle qu'un seul des deux applique ne bloque rien et fait mentir l'autre
// commande. Ce test compare donc le RÉSULTAT RÉEL : les mêmes fichiers passés
// aux deux configurations doivent rendre exactement les mêmes signalements,
// règle, ligne, colonne et gravité comprises.
//
// Lancer depuis la racine : pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webRoot = resolve(repoRoot, 'apps', 'web');

/**
 * Un échantillon qui touche chaque forme du désaccord :
 * le fichier de l'issue, un composant qui désactive une règle Next en ligne,
 * un test qui se type avec l'idiome `importOriginal<typeof import(...)>`, et
 * une route d'API convertie en `import type`.
 */
const fichiers = [
  'apps/web/src/lib/actions.ts',
  'apps/web/src/components/AvatarPicker.tsx',
  'apps/web/src/lib/__tests__/conversation-actions.test.ts',
  'apps/web/src/app/api/oauth/[provider]/start/route.ts',
];

/** Un signalement réduit à ce qui doit coïncider des deux côtés. */
function signalements(resultats) {
  const out = [];
  for (const r of resultats) {
    const nom = r.filePath
      .slice(repoRoot.length + 1)
      .split('\\')
      .join('/');
    for (const m of r.messages) {
      out.push(
        `${nom}:${m.line}:${m.column} ${m.severity === 2 ? 'error' : 'warning'} ${m.ruleId}`,
      );
    }
  }
  return out.sort();
}

async function depuisLaRacine(chemins) {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: resolve(repoRoot, 'eslint.config.js'),
  });
  return signalements(await eslint.lintFiles(chemins.map((c) => resolve(repoRoot, c))));
}

async function depuisLeWeb(chemins) {
  const eslint = new ESLint({
    cwd: webRoot,
    overrideConfigFile: resolve(webRoot, 'eslint.config.mjs'),
  });
  return signalements(await eslint.lintFiles(chemins.map((c) => resolve(repoRoot, c))));
}

describe('the root and apps/web ESLint configurations agree', () => {
  it('reports exactly the same findings for the same web files', async () => {
    const [racine, web] = await Promise.all([depuisLaRacine(fichiers), depuisLeWeb(fichiers)]);
    // Comparer les listes, pas leur longueur : un test qui compte ne dit pas
    // lequel des deux côtés a parlé.
    expect(racine).toEqual(web);
  }, 180_000);

  it('resolves the shared TypeScript rules identically', async () => {
    const fichier = resolve(repoRoot, 'apps/web/src/lib/actions.ts');
    const racine = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: resolve(repoRoot, 'eslint.config.js'),
    });
    const web = new ESLint({
      cwd: webRoot,
      overrideConfigFile: resolve(webRoot, 'eslint.config.mjs'),
    });
    const [a, b] = await Promise.all([
      racine.calculateConfigForFile(fichier),
      web.calculateConfigForFile(fichier),
    ]);
    // Les règles du bloc partagé : c'est là qu'`import type` se décide.
    const partagees = [
      '@typescript-eslint/no-explicit-any',
      '@typescript-eslint/no-unused-vars',
      '@typescript-eslint/consistent-type-imports',
      'no-console',
    ];
    const extrait = (c) => Object.fromEntries(partagees.map((r) => [r, c.rules[r]]));
    expect(extrait(a)).toEqual(extrait(b));
    // Et elle est bien active, pas seulement identique des deux côtés.
    expect(a.rules['@typescript-eslint/consistent-type-imports'][0]).toBe(2);
  }, 120_000);
});
