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
import {
  eq,
  agents,
  agentSkills,
  agentSkillAssignments,
  agentMcpServers,
  entities,
  mcpServers,
} from '@nodal-agents/db';
import {
  createLazyMcpTools,
  slugToPrefix,
  type McpToolDescriptor,
} from '@nodal-agents/adapter-mcp';
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
/** Un vrai serveur MCP attaché au root, avec son cache d'outils v2. */
const MCP_SERVER_SLUG = 'notion-preview';
const MCP_CACHE = [
  {
    name: 'search',
    description: 'Search the workspace',
    inputSchema: { type: 'object', properties: {} },
  },
];
/** Le nom que le job porte pour cet outil : `<prefix>__<outil>`. */
const MCP_TOOL = `${slugToPrefix(MCP_SERVER_SLUG)}__search`;

/** Les slugs annoncés par le bloc `## Skills` SEUL, jusqu'au titre suivant. */
function announced(prompt: string): string[] {
  const start = prompt.indexOf('\n## Skills');
  if (start < 0) return [];
  const end = prompt.indexOf('\n## ', start + 1);
  const block = prompt.slice(start, end < 0 ? undefined : end);
  return ALL.filter((s) => block.includes(`- \`skill_view('${s}')\``));
}

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
  await testDb
    .update(entities)
    .set({ rootAgentId: seed.agentId })
    .where(eq(entities.id, seed.entityId));
  const [server] = await testDb
    .insert(mcpServers)
    .values({
      entityId: seed.entityId,
      name: 'Notion preview',
      slug: MCP_SERVER_SLUG,
      transport: 'stdio',
      command: 'never-spawned',
      availableTools: MCP_CACHE,
    })
    .returning();
  await testDb
    .insert(agentMcpServers)
    .values({ entityId: seed.entityId, agentId: seed.agentId, mcpServerId: server!.id });
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

describe('aperçu du prompt du root (Réglages → Root context) @cap:configurer-agent/ecran', () => {
  it('annonce la skill dont le job du root tient les outils, pas celle qu’aucun job ne tient', async () => {
    const { getRootSystemPromptAction } = await import('../actions.ts');
    const res = await getRootSystemPromptAction();
    expect(res.ok, res.ok ? '' : res.message).toBe(true);
    if (!res.ok) return;
    expect(
      announced(res.data),
      'le job du root tient run_command : sa skill est annoncée',
    ).toContain(SHELL_SLUG);
    expect(res.data, 'aucun job ne tient cet outil').not.toContain(GHOST_SLUG);
  });

  it('annonce exactement les skills que le JOB du root annonce', async () => {
    // Revue de #658, passes 1 et 2 : l'aperçu se compare au rendu du vrai
    // chemin du job, pas à une liste écrite à la main. La liste du job est
    // calculée comme execute.ts §6 la calcule, par les mêmes fonctions :
    // les builtins par la règle unique (`resolveBuiltinToolNames` →
    // `agentBuiltinToolNames`, #636), les outils MCP par `createLazyMcpTools`
    // sur le cache du serveur réellement attaché, filtrés par ses
    // `enabled_tools`. Puis `buildSystemPrompt`, comme au §7.
    const { getRootSystemPromptAction } = await import('../actions.ts');
    const res = await getRootSystemPromptAction();
    expect(res.ok, res.ok ? '' : res.message).toBe(true);
    if (!res.ok) return;

    const [row] = await testDb.select().from(agents).where(eq(agents.id, seed.agentId));
    const builtins = (await resolveBuiltinToolNames(testDb, seed.agentId)).names;
    const attached = await testDb
      .select({
        slug: mcpServers.slug,
        availableTools: mcpServers.availableTools,
        enabledTools: agentMcpServers.enabledTools,
      })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
      .where(eq(agentMcpServers.agentId, seed.agentId));
    const mcpToolNames = attached.flatMap((ms) => {
      const toolset = createLazyMcpTools(
        { transport: 'stdio', slug: ms.slug, command: 'never-spawned', args: [], env: {} },
        ms.availableTools as McpToolDescriptor[],
      );
      const enabled = ms.enabledTools as string[] | null;
      const prefixLen = slugToPrefix(ms.slug).length + 2;
      return toolset.tools
        .filter((t) => enabled === null || enabled.includes(t.name.slice(prefixLen)))
        .map((t) => t.name);
    });
    expect(mcpToolNames, 'le job tient bien l’outil MCP').toContain(MCP_TOOL);

    const job = await buildSystemPrompt(row as unknown as Agent, testDb, {
      origin: 'api',
      availableToolNames: [...builtins, ...mcpToolNames],
    });
    expect(announced(job)).toEqual([SHELL_SLUG, PROSE_SLUG]);
    expect(announced(res.data)).toEqual(announced(job));
  });
});
