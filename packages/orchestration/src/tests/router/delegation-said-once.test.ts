// router/delegation-said-once.test.ts — what a delegating job reads about its
// team, said once (lot 2, PR C2).
//
// The roster (`## Your team`) is where a teammate is DESCRIBED: its purpose,
// skills, connectors, folders, shell, the owner's instructions. Each
// `assign_*` tool is only the HANDLE that reaches it. Before this, every
// `assign_*` description recopied part of the roster, and the delegation scope
// rule was repeated in every delegation tool: on a root with ten teammates,
// ~11k characters of eager schemas per turn, half of them said twice.
//
// Reconstructed here on an owner-root-shaped team (ten teammates, one of them
// an orchestrator, skills, connectors, an MCP server, instructions), never on
// the real base.

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentAssignments,
  agentSkillAssignments,
  agentSkills,
  connectors,
  agentConnectorAssignments,
  mcpServers,
  agentMcpServers,
  users,
  entities,
} from '@nodal-agents/db';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { ALWAYS_ON_TOOLS } from '@nodal-agents/tools';
import { buildSystemPrompt } from '../../system-prompt';
import type { JobContext } from '../../system-prompt';
import { generateDelegationTools } from '../../delegation-tools';
import { DELEGATION_SCOPE_RULE } from '../../router/delegation-scope';
import { DEFAULT_LIMITS } from '../../chain-counters';
import type { Agent, AgentId, EntityId } from '../../types';

let db: TestDb;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
});

interface Mate {
  id: string;
  name: string;
  personality: string;
  skills: string[];
  connector: string | null;
  instructions: string | null;
}

/**
 * A root orchestrator and ten teammates, the shape of an owner's root, plus an
 * orchestrator of the same workspace with no team of its own.
 */
async function seedOwnerRoot(): Promise<{ root: Agent; lone: Agent; mates: Mate[] }> {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `said-once-${tag}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'W', slug: `said-once-${tag}` })
    .returning();
  const entityId = entity!.id;
  const [rootRow] = await db
    .insert(agents)
    .values({
      entityId,
      name: 'Root',
      slug: `root-${tag}`,
      personality: 'You are the owner’s main agent.',
      role: 'orchestrator',
    })
    .returning();

  const connectorSlugs = ['tavily', 'gmail', 'notion'];
  const connectorIds = new Map<string, string>();
  for (const slug of connectorSlugs) {
    const [c] = await db.insert(connectors).values({ entityId, name: slug, slug }).returning();
    connectorIds.set(slug, c!.id);
  }
  const [mcp] = await db
    .insert(mcpServers)
    .values({
      entityId,
      name: 'Print shop',
      slug: `print-shop-${tag}`,
      transport: 'http',
      url: 'https://example.invalid/mcp',
      authScheme: 'header',
      authParamName: 'x-api-key',
      availableTools: [{ name: 'request_print', description: 'Order a print' }],
      active: true,
    })
    .returning();

  const mates: Mate[] = [];
  for (let i = 0; i < 10; i++) {
    const name = `Mate${i} ${tag}`;
    const personality =
      `You are ${name}, a specialist of domain number ${i} for this workspace. ` +
      `You research, write and check everything that belongs to domain ${i}, and you ` +
      `report sources with every claim. You never guess a figure; you look it up.\n\n` +
      `## Style\nShort answers.`;
    const [row] = await db
      .insert(agents)
      .values({
        entityId,
        name,
        slug: `mate-${i}-${tag}`,
        personality,
        role: i === 0 ? 'orchestrator' : 'agent',
      })
      .returning();
    const instructions = i % 3 === 0 ? `Always hand ${name} the full brief, domain ${i}.` : null;
    await db
      .insert(agentAssignments)
      .values({ orchestratorId: rootRow!.id, subAgentId: row!.id, entityId, instructions });
    const skills: string[] = [];
    for (let s = 0; s < 2; s++) {
      const skillName = `Skill ${i}.${s} ${tag}`;
      const [skill] = await db
        .insert(agentSkills)
        .values({
          entityId,
          name: skillName,
          slug: `skill-${i}-${s}-${tag}`,
          description: `Does the part ${s} of domain ${i}, end to end.`,
          content: 'Do it.',
        })
        .returning();
      await db
        .insert(agentSkillAssignments)
        .values({ entityId, agentId: row!.id, skillId: skill!.id });
      skills.push(skillName);
    }
    const connector = connectorSlugs[i % connectorSlugs.length]!;
    await db
      .insert(agentConnectorAssignments)
      .values({ entityId, agentId: row!.id, connectorId: connectorIds.get(connector)! });
    if (i === 1) {
      await db
        .insert(agentMcpServers)
        .values({ entityId, agentId: row!.id, mcpServerId: mcp!.id, enabledTools: null });
    }
    mates.push({ id: row!.id, name, personality, skills, connector, instructions });
  }

  const [loneRow] = await db
    .insert(agents)
    .values({
      entityId,
      name: 'Lone',
      slug: `lone-${tag}`,
      personality: 'You coordinate.',
      role: 'orchestrator',
    })
    .returning();

  const asAgent = (row: typeof rootRow): Agent => ({
    id: row!.id as AgentId,
    name: row!.name,
    slug: row!.slug,
    role: 'orchestrator',
    personality: row!.personality,
    entityId: entityId as EntityId,
    model: 'claude-sonnet-4-6-20260217',
    active: true,
    orchestratorMode: null,
    memoryTokenBudget: 0,
  });
  return { root: asAgent(rootRow), lone: asAgent(loneRow), mates };
}

type Def = { name: string; description: string; inputSchema: z.ZodType; loading?: string };

/** The delegation tools the runner gives this job: the function execute.ts §6 calls. */
async function delegationToolsOf(agent: Agent, depth: number): Promise<Def[]> {
  return (await generateDelegationTools(agent.id, db, {
    isOrchestrator: agent.role === 'orchestrator',
    delegationDepth: depth,
  })) as unknown as Def[];
}

/** A teammate's entry in `## Your team`: its first line and the indented ones under it. */
function rosterEntry(prompt: string, name: string): string {
  const start = prompt.indexOf(`- **${name}**`);
  if (start === -1) return '';
  const [head, ...rest] = prompt.slice(start).split('\n');
  const body: string[] = [];
  for (const line of rest) {
    if (!line.startsWith('  ')) break;
    body.push(line);
  }
  return [head, ...body].join('\n');
}

/** One tool as the model receives it: the AI SDK's own conversion of the zod schema. */
function sentChars(t: Def): number {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.inputSchema, { target: 'draft-7', io: 'input' }),
  }).length;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('A delegating job reads each fact of its team once @cap:organiser-equipe/moteur', () => {
  it('the delegation scope rule is said exactly once where the job can delegate, never where it cannot', async () => {
    const { root, lone } = await seedOwnerRoot();
    const cases: Array<{
      label: string;
      ctx: JobContext;
      depth: number;
      expected: number;
      agent?: Agent;
    }> = [
      {
        label: 'root on a channel',
        ctx: { origin: 'telegram', telegramChatId: '1' },
        depth: 0,
        expected: 1,
      },
      {
        label: 'root, cron routine',
        ctx: { origin: 'cron', routineState: [] },
        depth: 0,
        expected: 1,
      },
      {
        label: 'delegated sub-orchestrator, hops left',
        ctx: { origin: 'internal', isDelegated: true, delegationDepth: 1 },
        depth: 1,
        expected: 1,
      },
      {
        label: 'at the maximum delegation depth',
        ctx: {
          origin: 'internal',
          isDelegated: true,
          delegationDepth: DEFAULT_LIMITS.maxDelegationDepth,
        },
        depth: DEFAULT_LIMITS.maxDelegationDepth,
        expected: 0,
      },
      {
        // An orchestrator with no active teammate: no route reaches anyone,
        // so no delegation tool and no delegation manual.
        label: 'orchestrator without a team',
        ctx: { origin: 'telegram', telegramChatId: '1' },
        depth: 0,
        expected: 0,
        agent: lone,
      },
    ];
    const seen: Record<string, number> = {};
    const want: Record<string, number> = {};
    const tools: Record<string, string[]> = {};
    for (const c of cases) {
      const agent = c.agent ?? root;
      const defs = await delegationToolsOf(agent, c.depth);
      tools[c.label] = defs.map((t) => t.name);
      const prompt = await buildSystemPrompt(agent, db, {
        ...c.ctx,
        availableToolNames: [...new Set([...ALWAYS_ON_TOOLS, ...defs.map((t) => t.name)])].sort(),
      });
      seen[c.label] =
        occurrences(prompt, DELEGATION_SCOPE_RULE) +
        defs.reduce((n, t) => n + occurrences(t.description, DELEGATION_SCOPE_RULE), 0);
      want[c.label] = c.expected;
    }
    // The chat surface has no delegation tool: the job it starts reads the rule.
    const chat = await buildSystemPrompt(root, db, { origin: 'web', surface: 'chat' });
    seen['dashboard chat'] = occurrences(chat, DELEGATION_SCOPE_RULE);
    want['dashboard chat'] = 0;
    expect(seen).toEqual(want);
    // Where the rule is absent, so are the tools it governs.
    expect(tools['at the maximum delegation depth']).toEqual([]);
    expect(tools['orchestrator without a team']).toEqual([]);
    expect(tools['root on a channel']).toContain('create_task');
  });

  it('an assign_* tool names its teammate from the base; what the roster describes is said there only', async () => {
    const { root, mates } = await seedOwnerRoot();
    const tools = await delegationToolsOf(root, 0);
    const prompt = await buildSystemPrompt(root, db, {
      origin: 'telegram',
      telegramChatId: '1',
      availableToolNames: [...new Set([...ALWAYS_ON_TOOLS, ...tools.map((t) => t.name)])].sort(),
    });
    const assign = tools.filter((t) => t.name.startsWith('assign_'));
    expect(assign).toHaveLength(mates.length);

    const repeated: Record<string, string[]> = {};
    const unnamed: string[] = [];
    const lost: string[] = [];
    for (const mate of mates) {
      const tool = assign.find((t) => t.description.includes(mate.name));
      if (!tool) {
        unnamed.push(mate.name);
        continue;
      }
      // Each fact of the teammate's own roster entry, in the words it uses.
      const facts = [
        mate.personality.slice(0, 60),
        ...mate.skills,
        ...(mate.connector ? [mate.connector] : []),
        ...(mate.instructions ? [mate.instructions] : []),
      ];
      const entry = rosterEntry(prompt, mate.name);
      for (const fact of facts) {
        if (!entry.includes(fact)) lost.push(`${mate.name}: ${fact}`);
        if (tool.description.includes(fact)) (repeated[tool.name] ??= []).push(fact);
      }
    }
    expect({ unnamed, lost, repeated }).toEqual({ unnamed: [], lost: [], repeated: {} });
  });

  // Measure of the lot: what a root with ten teammates sends on every turn for
  // its assign_* tools (all eager). On this team: 11,171 characters before,
  // 4,510 after. What is left is each tool's parameter schema (331 characters),
  // which every assign_* carries, and the teammate's name.
  it('an assign_* costs its parameter schema and its teammate’s name, nothing that grows with the roster', async () => {
    const { root, mates } = await seedOwnerRoot();
    const assign = (await delegationToolsOf(root, 0)).filter((t) => t.name.startsWith('assign_'));
    expect(assign.every((t) => t.loading === 'eager')).toBe(true);
    const beyondName: Record<string, number> = {};
    for (const t of assign) {
      const name = mates.find((m) => t.description.includes(m.name))?.name ?? '';
      beyondName[t.name] = t.description.length - name.length;
    }
    expect(Object.values(beyondName).filter((n) => n > 40)).toEqual([]);
    expect(assign.reduce((n, t) => n + sentChars(t), 0)).toBeLessThanOrEqual(4_600);
  });
});
