// eslint.shared.mjs — les règles TypeScript du dépôt, en UN seul endroit.
//
// Issue #249 : la configuration de la racine et celle d'`apps/web` (celle que
// la CI lance) se contredisaient. Sept annotations `import()` d'`actions.ts`
// étaient rouges à la racine et vertes en CI. Une règle qu'une seule des deux
// applique est une règle que personne ne voit : elle ne bloque rien, et elle
// fait mentir la commande que quelqu'un lance à la main.
//
// Les deux configurations importent ce bloc. Elles ne peuvent donc plus
// diverger par oubli : il n'y a plus deux copies à tenir d'accord.
// `scripts/tests/eslint-configs-accord.test.mjs` le vérifie en comparant les
// règles que chacune RÉSOUT pour les mêmes fichiers d'`apps/web`.

/** Les règles TypeScript communes, telles qu'elles s'appliquent partout. */
export const reglesTypeScript = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/consistent-type-imports': 'error',
  'no-console': ['warn', { allow: ['warn', 'error'] }],
};

/** Les fichiers que ces règles visent — la même liste des deux côtés. */
export const fichiersTypeScript = ['**/*.{ts,tsx,mts,cts}'];

/** Les fichiers de test, où une seule de ces règles s'assouplit (ci-dessous). */
export const fichiersDeTest = [
  '**/*.test.{ts,tsx,mts,cts}',
  '**/__tests__/**/*.{ts,tsx,mts,cts}',
  '**/tests/**/*.{ts,tsx,mts,cts}',
];

/** Le bloc de configuration prêt à poser dans un `defineConfig`. */
export const blocTypeScript = {
  files: fichiersTypeScript,
  rules: reglesTypeScript,
};

/**
 * Dans un test, `import()` reste une annotation de type légitime.
 *
 * `consistent-type-imports` interdit par défaut les annotations `import()`.
 * La moitié utile de la règle — un import de valeur qui ne sert qu'au typage
 * doit s'écrire `import type` — vaut partout. Cette moitié-ci, non : c'est la
 * façon dont Vitest se type, `importOriginal<typeof import('@nodal-agents/auth')>()`,
 * et elle n'a pas d'équivalent en `import type` qui n'ajoute pas un import de
 * module en tête de chaque fichier de mock. Sur les 68 cas qu'`apps/web`
 * portait au 20/09/2026, 55 étaient cet idiome.
 *
 * Hors tests, l'interdiction reste entière : les annotations `import()` du
 * code de production ont toutes été converties en `import type`.
 */
export const blocTestsTypeScript = {
  files: fichiersDeTest,
  rules: {
    '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
  },
};
