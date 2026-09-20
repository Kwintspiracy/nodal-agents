import tseslint from 'typescript-eslint';
import { blocTypeScript, blocTestsTypeScript } from './eslint.shared.mjs';
import webConfig from './apps/web/eslint.config.mjs';

// `apps/web` a sa propre configuration — celle que la CI lance. La racine la
// REPREND telle quelle, replacée sous `apps/web/` par `basePath`, au lieu d'en
// tenir une deuxième version (issue #249) : sans cela, `npx eslint` depuis la
// racine ignorait le plugin Next, et chaque `eslint-disable` d'une règle Next
// écrit dans `apps/web` lui rendait « Definition for rule not found ».
const webSousLaRacine = [
  // `rootDir` n'est pas une règle : c'est l'endroit où le plugin Next cherche
  // l'application. Depuis `apps/web` il le déduit du dossier courant ; depuis
  // la racine il faut le lui dire, sans quoi il annonce à chaque appel qu'il ne
  // trouve pas de dossier `pages`. Même configuration, contexte différent.
  { basePath: 'apps/web', settings: { next: { rootDir: 'apps/web' } } },
  ...webConfig.map((bloc) => ({ ...bloc, basePath: 'apps/web' })),
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  ...tseslint.configs.recommended,
  // Le bloc vit dans `eslint.shared.mjs` : `apps/web` l'importe aussi, pour
  // que la racine et la CI ne puissent plus dire deux choses (issue #249).
  blocTypeScript,
  blocTestsTypeScript,
  ...webSousLaRacine,
  {
    // The CLI speaks to the user through stdout — console.log IS its output here,
    // not a stray debug line. Allow all console methods in apps/cli.
    files: ['apps/cli/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-console': 'off',
    },
  },
);
