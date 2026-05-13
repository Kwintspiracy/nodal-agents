import { defineConfig } from 'tsup';

// Bundle the CLI into a single ESM file with all @nodal-agents/* workspace
// deps inlined. npm-installable packages (commander, chalk, ora, prompts,
// execa, open, embedded-postgres) stay external — the pack's package.json
// declares them as runtime dependencies.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  splitting: false,
  shims: false,
  // tsup default treats workspace deps as external (via package.json's
  // `dependencies`). noExternal forces them back into the bundle.
  noExternal: [/^@nodal-agents\//],
  // Keep the bundle pure ESM (matches package.json type: module).
  target: 'node22',
  platform: 'node',
  // The CLI is a single short file — minification saves ~10 KB at the cost
  // of readable stack traces. Not worth it.
  minify: false,
  sourcemap: false,
  // Workspace package source uses extension-less relative imports
  // (Bundler resolution). Tell esbuild (which tsup wraps) to resolve TS
  // files even when `./foo` is written without `.ts`.
  esbuildOptions(options) {
    options.resolveExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
  },
  // First line must be the shebang so npm-installed binary is executable.
  // The shebang in src/index.ts is preserved by tsup automatically.
});
