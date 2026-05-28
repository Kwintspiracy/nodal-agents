// build.mjs — esbuild bundle for the runner.
//
// Produces dist/server.js as a single ESM file with all workspace deps
// (@nodal-agents/*) inlined. Every npm package listed in EXTERNALS stays
// external — the final pack's package.json declares them as runtime
// dependencies so `npm install` resolves them in the consumer's
// node_modules.
//
// Why explicit list instead of `packages: 'external'`: that flag also
// externalises @nodal-agents/* (they live in node_modules/ as symlinks),
// which defeats the inline goal. Listing externals explicitly keeps the
// rule trivially correct and makes the eventual pack/package.json deps
// list stay in sync.

import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Every npm dep we want resolved via `npm install` instead of inlined.
// Mirrored in the final pack/package.json runtime deps. Update both
// together when adding/removing deps that the runner imports transitively.
const EXTERNALS = [
  // Hono server stack
  'hono',
  '@hono/node-server',
  // Validation + utils
  'zod',
  'cron-parser',
  // DB
  'pg',
  'postgres',
  'drizzle-orm',
  // Auth
  'better-auth',
  // LLM (Vercel AI SDK + providers)
  'ai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/groq',
  '@ai-sdk/mistral',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/provider',
  'ollama-ai-provider-v2',
  // Adapters — connectors
  'googleapis',
  '@notionhq/client',
  '@mendable/firecrawl-js',
  '@tavily/core',
  'apify-client',
  // File ingestion
  'pdf-parse',
  'mammoth',
  'exceljs',
];

// esbuild's external matches the literal import string. Deep imports
// (e.g. `drizzle-orm/postgres-js`, `better-auth/adapters/drizzle`,
// `@notionhq/client/build/src/api-endpoints.js`) need wildcards.
const externalsWithWildcards = EXTERNALS.flatMap((pkg) => [pkg, `${pkg}/*`]);

await build({
  entryPoints: [resolve(__dirname, 'src/server.ts')],
  outfile: resolve(outDir, 'server.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: externalsWithWildcards,
  // node22 ESM doesn't have __dirname/__filename/require by default.
  // Some transitive workspace code (drizzle migrators, embedded-postgres
  // dynamic imports) calls them — define globals via the banner so the
  // bundle is portable.
  banner: {
    js: [
      "import { createRequire as __nodalCreateRequire } from 'node:module';",
      "import { fileURLToPath as __nodalFileURLToPath } from 'node:url';",
      "import { dirname as __nodalDirname } from 'node:path';",
      'const require = __nodalCreateRequire(import.meta.url);',
      'const __filename = __nodalFileURLToPath(import.meta.url);',
      'const __dirname = __nodalDirname(__filename);',
    ].join('\n'),
  },
  minify: false,
  sourcemap: false,
  resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  logLevel: 'info',
});

console.log('✔ Runner bundle written to', resolve(outDir, 'server.js'));
