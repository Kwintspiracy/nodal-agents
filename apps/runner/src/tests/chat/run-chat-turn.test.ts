// run-chat-turn.test.ts — delegated-task visibility, the EXACT incident shape
// (2026-07-12): a dashboard chat turn escalated "research Law & Order and
// send it to Mathilde" into a root job that delegated via create_task; the
// task's own child job really called telegram_send_message. The next chat
// turn ("Tu as envoyé à Mathilde ?") must see that fact in the history fed to
// the LLM — not just the root job's own prose result — or the agent denies
// something it (via delegation) actually did.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agents,
  agentJobs,
  agentTasks,
  codeProjects,
  conversations,
  chatMessages,
} from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';

// ─── Intercept createLlmClient (same pattern as execute.test.ts) ──────────────
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) {
        throw new Error('run-chat-turn.test: no active LLM client — call setActiveLlmClient first');
      }
      return active;
    },
  };
});

/** A fake client whose generateText resolves a fixed text reply (no run_task
 *  call) and records the `messages` array of every call it received, so the
 *  test can assert what history actually reached the model. */
function makeMockLlmClient(
  replyText: string,
  capturedCalls: ModelMessage[][],
): RunnerDeps['llmClient'] {
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => ({
      content: [{ type: 'text', text: replyText }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });

  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      capturedCalls.push((args.messages ?? []) as ModelMessage[]);
      return generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>;
    },
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

/** Flatten every string leaf reachable in a ModelMessage[] (string content,
 *  `text` parts, tool-call `instruction`, tool-result text `value`) into one
 *  blob, so a test can assert a fact is somewhere in what the model saw. */
function flattenText(messages: ModelMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') {
      parts.push(c);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      const part = p as Record<string, unknown>;
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      if (part.type === 'tool-call' && part.input && typeof part.input === 'object') {
        const instruction = (part.input as { instruction?: unknown }).instruction;
        if (typeof instruction === 'string') parts.push(instruction);
      }
      if (part.type === 'tool-result' && part.output && typeof part.output === 'object') {
        const value = (part.output as { value?: unknown }).value;
        if (typeof value === 'string') parts.push(value);
      }
    }
  }
  return parts.join('\n');
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let deps: RunnerDeps;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  // runChatTurn only reads deps.db — the rest is unused, so a minimal cast is enough.
  deps = { db } as unknown as RunnerDeps;
});

beforeEach(async () => {
  await db.delete(agentTasks);
  await db.delete(chatMessages);
  await db.delete(conversations);
  await db.delete(codeProjects);
  await db.delete(agentJobs).where(eq(agentJobs.agentId, seed.agentId));
});

describe('runChatTurn — delegated-task visibility', () => {
  it('the incident: a follow-up turn sees the delegated telegram_send_message the root job never mentioned in prose', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Mathilde research' })
      .returning();
    if (!conv) throw new Error('conversation insert failed');

    // The root job the FIRST turn escalated into — its compiled `result` is
    // just the delegated agent's prose, never naming telegram_send_message.
    const [rootJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        conversationId: conv.id,
        task: 'research Law & Order and send it to Mathilde',
        status: 'completed',
        result: '## Research Law & Order and send to Mathilde\nDone — summary delivered.',
      })
      .returning({ id: agentJobs.id });
    if (!rootJob) throw new Error('root job insert failed');

    // The delegated task-board child that ACTUALLY sent the Telegram message.
    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'task-board',
        task: 'send the research summary to Mathilde',
        status: 'completed',
        toolsUsed: ['web_search', 'telegram_send_message'],
      })
      .returning({ id: agentJobs.id });
    if (!childJob) throw new Error('child job insert failed');

    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      title: 'Research Law & Order and send to Mathilde',
      status: 'done',
      result: 'Sent a summary to Mathilde via Telegram.',
      rootJobId: rootJob.id,
      jobId: childJob.id,
    });

    // The FIRST turn's persisted exchange (user request + assistant ack tied
    // to the root job) — exactly what runChatTurn replays as history.
    await db.insert(chatMessages).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'user',
        content: 'research Law & Order and send it to Mathilde',
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'assistant',
        content: 'Sur ça — je lance la recherche.',
        jobId: rootJob.id,
      },
    ]);

    const capturedCalls: ModelMessage[][] = [];
    setActiveLlmClient(makeMockLlmClient('Oui, envoyé à Mathilde.', capturedCalls));

    const result = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'Tu as envoyé à Mathilde ?',
    });

    expect(result.ok).toBe(true);
    expect(capturedCalls.length).toBeGreaterThan(0);

    // The FIRST call is the one carrying full conversational history.
    const seenByModel = flattenText(capturedCalls[0]!);
    expect(seenByModel).toContain('telegram_send_message');
    expect(seenByModel).toContain(
      '[Task "Research Law & Order and send to Mathilde" completed: actions — web_search, ' +
        'telegram_send_message; result: Sent a summary to Mathilde via Telegram.]',
    );
  });

  it('le chat du tableau de bord voit AUSSI la délégation EN LIGNE (assign_*)', async () => {
    // Constat P2 de la revue Codex (27/08). Le registre des délégations en ligne
    // n'était branché que sur `loadThreadHistory` — donc Telegram, Slack,
    // Discord. Ici, non. Or c'est la surface où le propriétaire parle le plus à
    // ses agents : un compte rendu de délégation inventé y restait
    // indiscernable d'un vrai, exactement la panne que ce registre ferme.
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'App du soir' })
      .returning();
    if (!conv) throw new Error('conversation insert failed');

    const [rootJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        conversationId: conv.id,
        task: 'fais-moi une app',
        status: 'completed',
        result: 'App livrée et validée.',
      })
      .returning({ id: agentJobs.id });
    if (!rootJob) throw new Error('root job insert failed');

    // L'enfant de délégation EN LIGNE : lié par parent_job_id, JAMAIS par
    // agent_tasks — c'est précisément ce qui le rendait invisible.
    await db.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'construis l’app',
      status: 'completed',
      parentJobId: rootJob.id,
      toolsUsed: ['file_write', 'review_verdict'],
    });

    await db.insert(chatMessages).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'user',
        content: 'fais-moi une app',
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'assistant',
        content: 'App livrée et validée.',
        jobId: rootJob.id,
      },
    ]);

    const capturedCalls: ModelMessage[][] = [];
    setActiveLlmClient(makeMockLlmClient('Oui.', capturedCalls));

    const result = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'qui l’a relue ?',
    });

    expect(result.ok).toBe(true);
    const seenByModel = flattenText(capturedCalls[0]!);
    expect(seenByModel, 'la délégation en ligne reste invisible dans le chat').toContain(
      'Delegated to',
    );
    expect(seenByModel).toContain('file_write');
  });

  it('does NOT surface a delegated task that has not finished yet', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Still working' })
      .returning();
    if (!conv) throw new Error('conversation insert failed');

    const [rootJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        conversationId: conv.id,
        task: 'kick off the report',
        status: 'completed',
        result: 'Working on it.',
      })
      .returning({ id: agentJobs.id });
    if (!rootJob) throw new Error('root job insert failed');

    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      title: 'still running',
      status: 'in_progress',
      rootJobId: rootJob.id,
    });

    await db.insert(chatMessages).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'user',
        content: 'kick off the report',
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'assistant',
        content: 'On it.',
        jobId: rootJob.id,
      },
    ]);

    const capturedCalls: ModelMessage[][] = [];
    setActiveLlmClient(makeMockLlmClient('Toujours en cours.', capturedCalls));

    await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'Où en est le rapport ?',
    });

    const seenByModel = flattenText(capturedCalls[0]!);
    expect(seenByModel).not.toContain('[Task');
  });
});

// ─── P6 : le projet courant de la conversation ────────────────────────────────

/**
 * Un client dont le modèle APPELLE `run_task`, et qui retient le prompt système
 * réellement construit — c'est lui, pas une valeur de retour, qui prouve que le
 * bloc `## Conversation` est arrivé au modèle.
 */
function makeRunTaskLlmClient(
  instruction: string,
  capturedSystem: string[],
): RunnerDeps['llmClient'] {
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => ({
      content: [
        { type: 'text' as const, text: 'Je lance ça.' },
        {
          type: 'tool-call' as const,
          toolCallId: 'call-run-task-1',
          toolName: 'run_task',
          input: JSON.stringify({ instruction }),
        },
      ],
      finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });

  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      capturedSystem.push(String((args as { system?: unknown }).system ?? ''));
      return generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>;
    },
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

describe('runChatTurn — le projet courant de la conversation (P6)', () => {
  it('le job escaladé PORTE le project_id du fil, et le prompt dit le projet', async () => {
    const [projet] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: 'D:/APPS/le-fil-travaille-ici',
        projectKey: projectKey('D:/APPS/le-fil-travaille-ici'),
        displayName: 'Le fil travaille ici',
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!projet) throw new Error('insert projet');

    const [conv] = await db
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        title: 'Le fil ancré',
        currentProjectId: projet.id,
      })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('conversation insert failed');

    const capturedSystem: string[] = [];
    setActiveLlmClient(makeRunTaskLlmClient('ajoute la page de réglages', capturedSystem));

    const result = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'ajoute la page de réglages',
    });

    // 1. Le job créé porte le projet — relu en base, jamais déduit du retour.
    expect(result.ok).toBe(true);
    const spawnedJobId = (result as { spawnedJobId?: string }).spawnedJobId;
    expect(spawnedJobId).toBeTruthy();
    const [job] = await db
      .select({ projectId: agentJobs.projectId, conversationId: agentJobs.conversationId })
      .from(agentJobs)
      .where(eq(agentJobs.id, spawnedJobId!));
    expect(job?.projectId).toBe(projet.id);
    expect(job?.conversationId).toBe(conv.id);

    // 2. Le prompt réellement envoyé au modèle nomme le projet et son chemin.
    expect(capturedSystem[0]).toContain('## Conversation');
    expect(capturedSystem[0]).toContain('D:/APPS/le-fil-travaille-ici');
    expect(capturedSystem[0]).toContain('Le fil travaille ici');
  });

  it('sans projet courant, le job escaladé n’en porte aucun et le prompt le dit', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Fil sans ancrage' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('conversation insert failed');

    const capturedSystem: string[] = [];
    setActiveLlmClient(makeRunTaskLlmClient('fais un truc', capturedSystem));

    const result = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'fais un truc',
    });

    const spawnedJobId = (result as { spawnedJobId?: string }).spawnedJobId;
    const [job] = await db
      .select({ projectId: agentJobs.projectId })
      .from(agentJobs)
      .where(eq(agentJobs.id, spawnedJobId!));
    expect(job?.projectId).toBeNull();
    expect(capturedSystem[0]).toContain('- Current project: none yet.');
    // Premier message du fil : le modèle doit le savoir.
    expect(capturedSystem[0]).toContain('This is the first turn of this conversation');
  });
});

describe("runChatTurn — le tour appartient à l'agent DU fil", () => {
  it("un agentId qui n'est pas celui de la conversation est refusé, et RIEN n'est écrit", async () => {
    // Le cas réel : le ROOT change pour B, l'utilisateur répond dans l'ancien
    // fil de A. Sans cette garde, le message de B s'écrivait chez A et B
    // tournait avec l'historique de A (revue Codex, passe 29).
    // Le nouveau ROOT est un agent COMPLET (clé LLM comprise) : sans cela, la
    // garde « pas de clé » se déclencherait avant, et le test ne prouverait
    // rien de la correspondance d'agent.
    const [agentDuFil] = await db
      .select({ llmKeyId: agents.llmKeyId })
      .from(agents)
      .where(eq(agents.id, seed.agentId));
    const [autreAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Le nouveau ROOT',
        slug: `nouveau-root-${Date.now()}`,
        personality: 'Pas celui du fil.',
        active: true,
        llmKeyId: agentDuFil?.llmKeyId ?? null,
      })
      .returning({ id: agents.id });
    if (!autreAgent) throw new Error('agent insert failed');

    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: "Le fil d'avant" })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('conversation insert failed');

    const capturedCalls: ModelMessage[][] = [];
    setActiveLlmClient(makeMockLlmClient('ne devrait jamais être appelé', capturedCalls));

    const result = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: autreAgent.id,
      conversationId: conv.id,
      message: 'coucou',
    });

    expect(result).toEqual({ ok: false, error: 'conversation_agent_mismatch' });
    // AUCUN message écrit : la garde passe avant l'insert du tour utilisateur.
    const messages = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv.id));
    expect(messages).toEqual([]);
    // Et le modèle n'a jamais été sollicité.
    expect(capturedCalls).toEqual([]);
  });

  it("l'agent DU fil, lui, écrit son tour", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Le bon fil' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('conversation insert failed');

    const capturedCalls: ModelMessage[][] = [];
    setActiveLlmClient(makeMockLlmClient('bien reçu', capturedCalls));

    const result = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'coucou',
    });

    expect(result.ok).toBe(true);
    const messages = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv.id))
      .orderBy(chatMessages.createdAt);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toBe('coucou');
  });
});
