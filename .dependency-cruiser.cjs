/**
 * dependency-cruiser config — enforces NodalAI architecture rules.
 * See README.md for the full rationale.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are forbidden.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphaned modules (not imported anywhere) usually indicate dead code.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(eslint|babel|jest|vitest|playwright|tailwind|postcss|next|turbo)\\.config\\.[^/]+$',
          // Next.js App Router conventions: page.tsx, layout.tsx, route.ts, etc. are routed by filesystem, not imports.
          '(^|/)app/.+/(page|layout|loading|error|not-found|template|default)\\.tsx?$',
          '(^|/)app/.+/route\\.ts$',
          '(^|/)app/(page|layout|loading|error|not-found|template|default|globals)\\.(tsx?|css)$',
          '(^|/)proxy\\.ts$',
          '(^|/)next-env\\.d\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'apps-cant-import-other-apps',
      severity: 'error',
      comment: 'apps/* must not depend on other apps/* (communicate via DB or HTTP API only).',
      from: { path: '^apps/([^/]+)/' },
      to: {
        path: '^apps/',
        // Same app is fine — only block crossing into a *different* app dir.
        pathNot: '^apps/$1/',
      },
    },
    {
      name: 'packages-cant-import-apps',
      severity: 'error',
      comment: 'packages/* must not depend on apps/* (apps consume packages, not the other way).',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'only-db-imports-pg',
      severity: 'error',
      comment: 'Only packages/db may import postgres clients directly.',
      from: { pathNot: '^packages/db/' },
      to: { path: 'node_modules/(pg|postgres|drizzle-orm)(/|$)' },
    },
    {
      name: 'adapters-only-import-tools-shared',
      severity: 'error',
      comment:
        'packages/adapters/* may only import from packages/tools, packages/shared, and other adapters via shared.',
      from: { path: '^packages/adapters/' },
      to: {
        path: '^packages/(?!tools|shared|adapters)',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)\\.next/' },
    tsConfig: { fileName: 'tsconfig.json' },
    // Follow import type { ... } statements — otherwise type-only modules appear as orphans
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { theme: { graph: { rankdir: 'LR' } } },
    },
  },
};
