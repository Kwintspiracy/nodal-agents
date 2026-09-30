// root-system-prompt-preview.test.ts — l'aperçu du prompt du root (Réglages →
// Root context) montre les skills que le JOB du root annoncerait.
//
// L'index des skills ne nomme plus une skill dont le job n'a pas les outils
// (lot 2, voie H). L'aperçu appelait `buildSystemPrompt` sans liste d'outils :
// il retombait sur les seuls outils toujours actifs, et aurait caché au
// propriétaire `command-execution` ou `spreadsheet-editing`, que le vrai job
// annonce. Il lit désormais la liste par la règle unique du runner
// (`resolveBuiltinToolNames`, #636).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agents, agentSkills, agentSkillAssignments, entities } from '@nodal-agents/db';
import { buildSystemPrompt, resolveBuiltinToolNames } from '@nodal-agents/orchestration';
import type { Agent } from '@nodal-agents/orchestration';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

const SHELL_SLUG = `preview-shell-${Date.now()}`;
const GHOST_SLUG = `preview-ghost-${Date.now()}`;
const MCP_SLUG = `preview-mcp-${Date.now()}`;
const PROSE_SLUG = `preview-prose-${Date.now()}`;
const ALL = [SHELL_SLUG, GHOST_SLUG, MCP_SLUG, PROSE_SLUG];
/** Un outil MCP, comme en porte la liste complète d'un job. */
const MCP_TOOL = 'notion__search';

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
  await testDb
    .update(entities)
    .set({ rootAgentId: seed.agentId })
    .where(eq(entities.id, seed.entityId));
  for (const [slug, requiredBuiltins] of [
    [SHELL_SLUG, ['run_command']],
    [GHOST_SLUG, ['no_such_builtin_in_this_build']],
    [MCP_SLUG, [MCP_TOOL]],
    [PROSE_SLUG, []],
  ] as const) {
    const [skill] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        name: slug,
        slug,
        description: `does ${slug}`,
        content: `Use ${slug}.`,
        requiredBuiltins: [...requiredBuiltins],
      })
      .returning();
    await testDb
      .insert(agentSkillAssignments)
      .values({ entityId: seed.entityId, agentId: seed.agentId, skillId: skill!.id });
  }
});

describe('aperçu du prompt du root @cap:assigner-skill/ecran', () => {
  it('annonce la skill dont le job du root tient les outils, pas celle qu’aucun job ne tient', async () => {
    const { getRootSystemPromptAction } = await import('../actions.ts');
    const res = await getRootSystemPromptAction();
    expect(res.ok, res.ok ? '' : res.message).toBe(true);
    if (!res.ok) return;
    expect(res.data, 'le job du root tient run_command : sa skill est annoncée').toContain(
      `skill_view('${SHELL_SLUG}')`,
    );
    expect(res.data, 'aucun job ne tient cet outil').not.toContain(GHOST_SLUG);
  });

  it('annonce exactement les skills que le JOB du root annonce', async () => {
    // Revue de #658, passe 1 : l'aperçu et le job doivent lire la même
    // règle. Le job est rendu ici comme le runner le construit : ses
    // builtins, plus un outil MCP de sa liste complète.
    const { getRootSystemPromptAction } = await import('../actions.ts');
    const res = await getRootSystemPromptAction();
    expect(res.ok, res.ok ? '' : res.message).toBe(true);
    if (!res.ok) return;
    const [row] = await testDb.select().from(agents).where(eq(agents.id, seed.agentId));
    const builtins = (await resolveBuiltinToolNames(testDb, seed.agentId)).names;
    const job = await buildSystemPrompt(row as unknown as Agent, testDb, {
      origin: 'api',
      availableToolNames: [...builtins, MCP_TOOL],
    });
    const announced = (prompt: string): string[] =>
      ALL.filter((s) => prompt.includes(`skill_view('${s}')`));
    expect(announced(job)).toEqual([SHELL_SLUG, PROSE_SLUG]);
    expect(announced(res.data)).toEqual(announced(job));
  });
});
