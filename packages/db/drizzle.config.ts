import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Use glob to include all schema files directly — avoids drizzle-kit bundler
  // resolving .js extensions that map to .ts files in the barrel index.ts.
  schema: [
    './src/schema/users.ts',
    './src/schema/entities.ts',
    './src/schema/agents.ts',
    './src/schema/jobs.ts',
    './src/schema/tasks.ts',
    './src/schema/credentials.ts',
    './src/schema/connectors.ts',
    './src/schema/tool_calls.ts',
    './src/schema/approvals.ts',
    './src/schema/memory.ts',
    './src/schema/webhooks.ts',
    './src/schema/skills.ts',
    './src/schema/schedules.ts',
    './src/schema/llm_keys.ts',
    './src/schema/runs.ts',
    './src/schema/mcp.ts',
    './src/schema/misc.ts',
    './src/schema/auth.ts',
  ],
  out: './migrations',
  // Connection string for drizzle-kit push/generate against a real DB.
  // Override with DATABASE_URL env var.
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/nodalai',
  },
  // Keep migration files verbose for reviewability
  verbose: true,
  strict: false,
});
