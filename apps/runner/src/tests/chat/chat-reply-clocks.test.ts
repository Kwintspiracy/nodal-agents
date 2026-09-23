// chat-reply-clocks.test.ts — la réponse du chat passe par l'appel des jobs (#458).
//
// Avant, le tour de chat appelait `streamText` à nu : ni horloge, ni trace. Une
// réponse de quatre minutes ne laissait aucune ligne `llm_calls`, et un flux
// muet n'était jamais coupé. Ce qui se prouve ici, sur le VRAI tour, le VRAI
// client (`createLlmClient`, avec son observateur) et la vraie base ; seul le
// modèle au bout du fil est simulé :
//   1. une réponse diffusée laisse sa ligne `llm_calls`, avec l'usage du fournisseur ;
//   2. un flux coupé après avoir écrit garde ce texte comme réponse, pose le
//      FAIT de la coupure (`cut_reason`), ne relance rien, et le tour suivant
//      dit au modèle que sa réponse avait été coupée.
//
// Les horloges elles-mêmes (premier mot, entre deux mots, filet d'une heure)
// sont prouvées dans `packages/llm` (`turn-clocks.test.ts`) : elles rendent la
// même `LLMTimeoutError` qu'une coupure de flux, et le tour de chat ne
// distingue pas les raisons — il les enregistre.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, chatMessages, conversations, llmCalls } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';
import { cutReplyNote } from '../../chat/turn-stop.ts';

const { mockModel } = vi.hoisted(() => ({
  /** Le modèle simulé que le VRAI client construit (voir le mock d'OpenRouter). */
  mockModel: { current: null as unknown },
}));

// Le client est le VRAI, observateur compris : seul le fournisseur est simulé.
vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (
      _config: Parameters<typeof actual.createLlmClient>[0],
      opts: Parameters<typeof actual.createLlmClient>[1],
    ) =>
      actual.createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-5.2', apiKey: 'k' }, opts),
  };
});

vi.mock('../../../../../packages/llm/src/providers/openrouter', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, buildOpenRouterModel: () => mockModel.current };
});

const USAGE = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** Un fragment du flux du fournisseur (le type vit dans `@ai-sdk/provider`, hors des dépendances du runner). */
type StreamPart = Record<string, unknown>;

/** Un modèle qui diffuse `parts`, et répond d'un bloc (relance d'escalade) sans rien demander. */
function modelStreaming(parts: StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.2',
    doStream: async () => ({ stream: simulateReadableStream({ chunks: parts }) as never }),
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: '' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: USAGE(3, 1),
      warnings: [],
    }),
  });
}

const text = (id: string, ...deltas: string[]): StreamPart[] => [
  { type: 'text-start', id },
  ...deltas.map((delta) => ({ type: 'text-delta', id, delta })),
];

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let deps: RunnerDeps;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db } as unknown as RunnerDeps;
});

beforeEach(async () => {
  await db.delete(llmCalls);
  await db.delete(chatMessages);
  await db.delete(conversations);
});

async function newConversation(): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Clocks' })
    .returning({ id: conversations.id });
  return conv!.id;
}

function playTurn(conversationId: string, shown: string[] = []) {
  return runChatTurn({
    deps,
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationId,
    message: 'Explique la machine à vapeur',
    onTextDelta: (d) => shown.push(d),
  });
}

/** L'observateur écrit sans être attendu : on relit jusqu'à voir la ligne. */
async function rowsOf(conversationId: string, atLeast: number) {
  const until = Date.now() + 2_000;
  while (true) {
    const rows = await db
      .select({
        source: llmCalls.source,
        inputTokens: llmCalls.inputTokens,
        outputTokens: llmCalls.outputTokens,
      })
      .from(llmCalls)
      .where(eq(llmCalls.conversationId, conversationId));
    if (rows.length >= atLeast || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('la réponse du chat sous les horloges des jobs (#458) @cap:parler-a-un-agent/moteur', () => {
  it('une réponse diffusée laisse sa ligne llm_calls, avec l’usage du fournisseur', async () => {
    const model = modelStreaming([
      { type: 'stream-start', warnings: [] },
      ...text('t', 'La vapeur ', 'pousse le piston.'),
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE(42, 7) },
    ]);
    mockModel.current = model;
    const conv = await newConversation();
    const shown: string[] = [];

    const result = await playTurn(conv, shown);

    expect(result).toMatchObject({
      ok: true,
      reply: 'La vapeur pousse le piston.',
      streamed: true,
    });
    expect(shown).toEqual(['La vapeur ', 'pousse le piston.']);
    // La réponse passe par le flux du modèle, pas par un appel d'un bloc.
    expect(model.doStreamCalls).toHaveLength(1);
    // La réponse (42/7) ET la relance d'escalade (3/1) : deux appels, deux lignes.
    const rows = await rowsOf(conv, 2);
    expect(rows).toContainEqual({ source: 'chat', inputTokens: 42, outputTokens: 7 });
  });

  it('un flux coupé après avoir écrit : le texte reste la réponse, la coupure est un fait', async () => {
    const model = modelStreaming([
      { type: 'stream-start', warnings: [] },
      ...text('t', 'Le cylindre ', 'reçoit la vapeur'),
      { type: 'error', error: new Error('connection reset by peer') },
    ]);
    mockModel.current = model;
    const conv = await newConversation();
    const shown: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await playTurn(conv, shown).finally(() => warn.mockRestore());

    expect(result).toEqual({
      ok: true,
      reply: 'Le cylindre reçoit la vapeur',
      streamed: true,
      cutReason: 'stream_error',
    });
    // Rien n'est rejoué : ni relance sans outils, ni relance d'escalade.
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(0);
    const rows = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        cutReason: chatMessages.cutReason,
        stopped: chatMessages.stopped,
      })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv));
    expect(rows.filter((r) => r.role === 'assistant')).toEqual([
      {
        role: 'assistant',
        content: 'Le cylindre reçoit la vapeur',
        cutReason: 'stream_error',
        stopped: false,
      },
    ]);

    // Le tour suivant : le modèle lit que sa réponse avait été coupée.
    const next = modelStreaming([
      { type: 'stream-start', warnings: [] },
      ...text('t', 'Je reprends.'),
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE(5, 2) },
    ]);
    mockModel.current = next;
    await playTurn(conv);
    const prompt = JSON.stringify(next.doStreamCalls[0]!.prompt);
    expect(prompt).toContain(JSON.stringify(cutReplyNote()).slice(1, -1));
  });
});
