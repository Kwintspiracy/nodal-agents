// conversation-feed.test.ts — le fil se construit depuis la VRAIE forme des
// lignes : le transcript d'un job cron relevé en base dev le 06/09/2026
// (user string → assistant tool-calls → tool results → assistant reasoning +
// return_result → nudge `[système]` → telegram_send_message → return_result),
// ses tool_calls avec carte et charge utile (P1), ses llm_calls par tour.

import { describe, it, expect } from 'vitest';
import {
  buildConversationFeed,
  STANDALONE_CARDS,
  type FeedJob,
  type FeedToolCallRow,
  type FeedLlmCallRow,
} from '../conversation-feed.ts';

const at = (s: string) => new Date(s);

const messages: unknown[] = [
  {
    role: 'user',
    content: 'Goal: detect new CHANGELOG entries for Nodal-Agents and announce them.',
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call_fetch',
        toolName: 'mcp_fetch__fetch_markdown',
        input: { url: 'https://example.test/CHANGELOG.md' },
      },
      {
        type: 'tool-call',
        toolCallId: 'call_qm',
        toolName: 'query_memory',
        input: { query: 'changelog' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_fetch',
        toolName: 'mcp_fetch__fetch_markdown',
        output: { type: 'text', value: '# Changelog…' },
      },
      {
        type: 'tool-result',
        toolCallId: 'call_qm',
        toolName: 'query_memory',
        output: { type: 'json', value: [] },
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'Nothing new since 0.8.8 — announce nothing.' },
      {
        type: 'tool-call',
        toolCallId: 'call_rr1',
        toolName: 'return_result',
        input: { result: 'No new entries.' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_rr1',
        toolName: 'return_result',
        output: { type: 'json', value: { result: 'No new entries.' } },
      },
    ],
  },
  {
    role: 'user',
    content:
      "[système] Tu es sur Telegram. Tu n'as pas encore livré ta réponse à l'utilisateur. Appelle `telegram_send_message`.",
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Rien de neuf dans le changelog aujourd’hui.' },
      {
        type: 'tool-call',
        toolCallId: 'call_tg',
        toolName: 'telegram_send_message',
        input: { text: 'Rien de neuf.' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_tg',
        toolName: 'telegram_send_message',
        output: { type: 'json', value: { messageId: '42' } },
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call_rr2',
        toolName: 'return_result',
        input: { result: 'No new entries.' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_rr2',
        toolName: 'return_result',
        output: { type: 'json', value: { result: 'No new entries.' } },
      },
    ],
  },
];

const job: FeedJob = {
  id: 'dd478381-19b2-47e8-80f0-9568b967eee4',
  task: 'Goal: detect new CHANGELOG entries for Nodal-Agents and announce them.',
  channel: 'cron',
  chatId: '123',
  status: 'completed',
  result: 'No new entries.',
  error: null,
  agentName: 'Veilleur',
  agentSlug: 'veilleur',
  createdAt: at('2026-09-05T15:01:38.788Z'),
  completedAt: at('2026-09-05T15:02:18.000Z'),
  messages,
  scheduleName: 'Changelog · toutes les 9 h',
  children: [],
};

const sentPayload = { card: 'sent', channel: 'telegram', kind: 'message', target: '123' };
const tablePayload = {
  card: 'table',
  tables: [
    {
      columns: ['fact', 'category'],
      header: 'columns',
      clipped: false,
      rows: [],
      total: 0,
      truncated: false,
    },
  ],
};

const toolCalls: FeedToolCallRow[] = [
  {
    toolCallId: 'call_fetch',
    toolName: 'mcp_fetch__fetch_markdown',
    card: 'generic',
    presented: { card: 'generic' },
    durationMs: 5319,
    turn: 1,
    toolInput: { url: 'https://example.test/CHANGELOG.md' },
    toolOutput: '"# Changelog…"',
    createdAt: at('2026-09-05T15:01:48.248Z'),
  },
  {
    toolCallId: 'call_qm',
    toolName: 'query_memory',
    card: 'table',
    presented: tablePayload,
    durationMs: 7,
    turn: 1,
    toolInput: { query: 'changelog' },
    toolOutput: '[]',
    createdAt: at('2026-09-05T15:01:48.259Z'),
  },
  {
    toolCallId: 'call_tg',
    toolName: 'telegram_send_message',
    card: 'sent',
    presented: sentPayload,
    durationMs: 24359,
    turn: 3,
    toolInput: { text: 'Rien de neuf.' },
    toolOutput: '{"messageId":"42"}',
    createdAt: at('2026-09-05T15:02:15.943Z'),
  },
];

const llmCalls: FeedLlmCallRow[] = [
  {
    turn: 1,
    source: 'job',
    modelEffective: 'z-ai/glm-5.3',
    provider: 'openrouter',
    inputTokens: 33988,
    outputTokens: 73,
    cachedTokens: 0,
    cacheCreationTokens: null,
    costUsd: 0.0479044,
    durationMs: 3782,
  },
  {
    turn: 2,
    source: 'job',
    modelEffective: 'z-ai/glm-5.3',
    provider: 'openrouter',
    inputTokens: 35849,
    outputTokens: 29,
    cachedTokens: 34048,
    cacheCreationTokens: null,
    costUsd: 0.01150148,
    durationMs: 1369,
  },
  {
    turn: 3,
    source: 'job',
    modelEffective: 'z-ai/glm-5.3',
    provider: 'openrouter',
    inputTokens: 35996,
    outputTokens: 64,
    cachedTokens: 35840,
    cacheCreationTokens: null,
    costUsd: 0.0098184,
    durationMs: 1946,
  },
  {
    turn: 4,
    source: 'job',
    modelEffective: 'z-ai/glm-5.3',
    provider: 'openrouter',
    inputTokens: 36071,
    outputTokens: 12,
    cachedTokens: 36032,
    cacheCreationTokens: null,
    costUsd: 0.00947572,
    durationMs: 1706,
  },
];

describe('buildConversationFeed — un job cron réel', () => {
  const feed = buildConversationFeed(job, toolCalls, llmCalls);

  it('ouvre sur la demande, avec son origine (canal + automatisation)', () => {
    expect(feed.items[0]).toEqual({
      kind: 'request',
      text: job.task,
      origin: { channel: 'cron', scheduleName: 'Changelog · toutes les 9 h', chatId: '123' },
      at: job.createdAt,
    });
  });

  it('un message user APRÈS la demande est un rappel du runner, pas l’utilisateur', () => {
    const notes = feed.items.filter((i) => i.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind === 'note' && notes[0].text).toMatch(/^Tu es sur Telegram/);
    expect(notes[0]?.kind === 'note' && notes[0].text).not.toContain('[système]');
  });

  it('numérote les tours et leur joint le modèle et les jetons du tour', () => {
    const turns = feed.items.filter((i) => i.kind === 'turn');
    expect(turns.map((t) => t.kind === 'turn' && t.index)).toEqual([1, 2, 3, 4]);
    const t1 = turns[0];
    expect(t1?.kind === 'turn' && t1.model).toBe('z-ai/glm-5.3');
    expect(t1?.kind === 'turn' && t1.usage).toEqual({
      inputTokens: 33988,
      outputTokens: 73,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.0479044,
      durationMs: 3782,
      calls: 1,
    });
    expect(t1?.kind === 'turn' && t1.agent).toEqual({ name: 'Veilleur', slug: 'veilleur' });
  });

  it('tour 1 : deux actions mineures (brut, table) repliées en UN groupe, dispatchées sur la CARTE persistée', () => {
    const t1 = feed.items.find((i) => i.kind === 'turn' && i.index === 1);
    expect(t1?.kind === 'turn' && t1.blocks).toHaveLength(1);
    const block = t1?.kind === 'turn' ? t1.blocks[0] : undefined;
    expect(block?.kind).toBe('steps');
    if (block?.kind !== 'steps') return;
    expect(
      block.steps.map((s) =>
        s.kind === 'tool' ? [s.toolName, s.card, s.outcome, s.durationMs] : s.kind,
      ),
    ).toEqual([
      ['mcp_fetch__fetch_markdown', 'generic', 'success', 5319],
      ['query_memory', 'table', 'success', 7],
    ]);
    const qm = block.steps[1];
    expect(qm?.kind === 'tool' && qm.presented).toEqual(tablePayload);
    expect(qm?.kind === 'tool' && qm.input).toEqual({ query: 'changelog' });
  });

  it('tour 2 : le raisonnement est une étape, avant l’appel sans ligne d’audit (carte null, jamais devinée)', () => {
    const t2 = feed.items.find((i) => i.kind === 'turn' && i.index === 2);
    const block = t2?.kind === 'turn' ? t2.blocks[0] : undefined;
    expect(block?.kind).toBe('steps');
    if (block?.kind !== 'steps') return;
    expect(block.steps[0]).toEqual({
      kind: 'reasoning',
      text: 'Nothing new since 0.8.8 — announce nothing.',
    });
    const rr = block.steps[1];
    expect(rr?.kind === 'tool' && rr.toolName).toBe('return_result');
    expect(rr?.kind === 'tool' && rr.card).toBeNull();
    expect(rr?.kind === 'tool' && rr.presented).toBeNull();
    expect(rr?.kind === 'tool' && rr.outcome).toBe('unknown');
  });

  it('tour 3 : la prose d’abord, puis l’envoi Telegram en CARTE seule, avec sa charge utile', () => {
    const t3 = feed.items.find((i) => i.kind === 'turn' && i.index === 3);
    expect(t3?.kind === 'turn' && t3.blocks.map((b) => b.kind)).toEqual(['prose', 'card']);
    const card = t3?.kind === 'turn' ? t3.blocks[1] : undefined;
    expect(card?.kind === 'card' && card.step.card).toBe('sent');
    expect(card?.kind === 'card' && card.step.presented).toEqual(sentPayload);
    expect(card?.kind === 'card' && card.step.input).toEqual({ text: 'Rien de neuf.' });
    expect(card?.kind === 'card' && card.step.durationMs).toBe(24359);
  });

  it('se ferme sur la réponse finale du job, et les totaux viennent des appels LLM', () => {
    expect(feed.items.at(-1)).toEqual({ kind: 'answer', text: 'No new entries.' });
    expect(feed.totals).toEqual({
      turns: 4,
      toolCalls: 5,
      inputTokens: 33988 + 35849 + 35996 + 36071,
      outputTokens: 73 + 29 + 64 + 12,
      cachedTokens: 34048 + 35840 + 36032,
      cacheCreationTokens: 0,
      costUsd: 0.0479044 + 0.01150148 + 0.0098184 + 0.00947572,
      llmDurationMs: 3782 + 1369 + 1946 + 1706,
      models: ['z-ai/glm-5.3'],
    });
  });
});

describe('buildConversationFeed — lignes anciennes, échecs, enfants', () => {
  it('une ligne antérieure à 0092 (carte null) reste une étape sans carte ; une charge hors forme devient null', () => {
    const j: FeedJob = {
      ...job,
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'file_write', input: { path: 'a' } },
          ],
        },
      ],
      status: 'processing',
      result: null,
    };
    const rows: FeedToolCallRow[] = [
      {
        toolCallId: 'c1',
        toolName: 'file_write',
        card: null,
        presented: { card: 'files' /* sans files */ },
        durationMs: 3,
        turn: 1,
        toolInput: {},
        toolOutput: '{"ok":true}',
        createdAt: null,
      },
    ];
    const feed = buildConversationFeed(j, rows, []);
    const turn = feed.items[1];
    const block = turn?.kind === 'turn' ? turn.blocks[0] : undefined;
    expect(block?.kind).toBe('steps'); // pas de carte connue → pas de carte seule
    const step = block?.kind === 'steps' ? block.steps[0] : undefined;
    expect(step?.kind === 'tool' && step.card).toBeNull();
    expect(step?.kind === 'tool' && step.presented).toBeNull();
    expect(feed.items.some((i) => i.kind === 'answer')).toBe(false); // pas terminé, pas de réponse
    expect(feed.totals.costUsd).toBeNull(); // aucun appel LLM connu : null, pas 0
  });

  it('un appel qui a ÉCHOUÉ ne se montre pas en carte, même sur une carte de résultat', () => {
    const j: FeedJob = {
      ...job,
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'run_command',
              input: { command: 'ls' },
            },
          ],
        },
      ],
    };
    const rows: FeedToolCallRow[] = [
      {
        toolCallId: 'c1',
        toolName: 'run_command',
        card: 'terminal',
        presented: null,
        durationMs: 1,
        turn: 1,
        toolInput: {},
        toolOutput: '{"outcome":"error","error":"blocked"}',
        createdAt: null,
      },
    ];
    const feed = buildConversationFeed(j, rows, []);
    const turn = feed.items[1];
    const block = turn?.kind === 'turn' ? turn.blocks[0] : undefined;
    expect(block?.kind).toBe('steps');
    const step = block?.kind === 'steps' ? block.steps[0] : undefined;
    expect(step?.kind === 'tool' && step.outcome).toBe('error');
    expect(STANDALONE_CARDS.has('terminal')).toBe(true); // la carte l'aurait montré, l'échec l'a retenu
  });

  it('une ligne sans tool_call_id (avant l’étape D) se joint par nom, dans l’ordre', () => {
    const j: FeedJob = {
      ...job,
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'a', toolName: 'file_read', input: { path: '1' } },
            { type: 'tool-call', toolCallId: 'b', toolName: 'file_read', input: { path: '2' } },
          ],
        },
      ],
    };
    const rows: FeedToolCallRow[] = [
      {
        toolCallId: null,
        toolName: 'file_read',
        card: 'read',
        presented: null,
        durationMs: 11,
        turn: 1,
        toolInput: { path: '1' },
        toolOutput: '{"ok":true}',
        createdAt: null,
      },
      {
        toolCallId: null,
        toolName: 'file_read',
        card: 'read',
        presented: null,
        durationMs: 22,
        turn: 1,
        toolInput: { path: '2' },
        toolOutput: '{"ok":true}',
        createdAt: null,
      },
    ];
    const feed = buildConversationFeed(j, rows, []);
    const block = feed.items[1]?.kind === 'turn' ? feed.items[1].blocks[0] : undefined;
    const durations =
      block?.kind === 'steps'
        ? block.steps.map((s) => (s.kind === 'tool' ? s.durationMs : null))
        : [];
    expect(durations).toEqual([11, 22]);
  });

  it('les enfants (travail délégué) et l’échec du job ferment le fil', () => {
    const child = {
      id: 'child-1',
      agentName: 'Analyste',
      agentSlug: 'analyste',
      status: 'completed',
      task: 'compare',
      result: 'ok',
      error: null,
      createdAt: null,
      completedAt: null,
    };
    const j: FeedJob = {
      ...job,
      status: 'failed',
      result: null,
      error: 'delivery_spam_guard',
      children: [child],
    };
    const feed = buildConversationFeed(j, [], []);
    expect(feed.items.at(-2)).toEqual({ kind: 'child', job: child });
    expect(feed.items.at(-1)).toEqual({ kind: 'failure', text: 'delivery_spam_guard' });
  });
});

describe('buildConversationFeed — historique préfixé et alignement des tours (passe 17)', () => {
  const TASK = 'Quoi de neuf ?';

  it("l'historique d'une conversation Telegram est un item à part ; la demande est le DERNIER message égal à la tâche", () => {
    // thread-history.ts préfixe les échanges précédents en messages ordinaires,
    // avec des appels d'outil synthétiques `history-tool-N` et un résultat
    // `messageId: 'history'`. La demande précédente était la MÊME phrase.
    const j: FeedJob = {
      ...job,
      channel: 'telegram',
      task: TASK,
      result: 'Rien depuis hier.',
      messages: [
        { role: 'user', content: TASK },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'history-tool-1',
              toolName: 'telegram_send_message',
              input: { text: 'Deux nouveautés hier.' },
            },
            { type: 'text', text: '[ledger] 1 action' },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'history-tool-1',
              toolName: 'telegram_send_message',
              output: { type: 'json', value: { messageId: 'history' } },
            },
          ],
        },
        { role: 'user', content: 'Merci' },
        { role: 'assistant', content: 'De rien.' },
        // ── la demande de CE job ──
        { role: 'user', content: TASK },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'web_search',
              input: { query: 'nodal' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'web_search',
              output: { type: 'json', value: { results: [] } },
            },
          ],
        },
        { role: 'assistant', content: 'Rien depuis hier.' },
      ],
    };
    const rows: FeedToolCallRow[] = [
      {
        toolCallId: 'c1',
        toolName: 'web_search',
        card: 'search',
        presented: null,
        durationMs: 900,
        turn: 1,
        toolInput: {},
        toolOutput: '{"results":[]}',
        createdAt: null,
      },
    ];
    const llm: FeedLlmCallRow[] = [
      {
        turn: 1,
        source: 'job',
        modelEffective: 'm',
        provider: 'p',
        inputTokens: 10,
        outputTokens: 1,
        cachedTokens: 0,
        cacheCreationTokens: null,
        costUsd: null,
        durationMs: 5,
      },
      {
        turn: 2,
        source: 'job',
        modelEffective: 'm',
        provider: 'p',
        inputTokens: 20,
        outputTokens: 2,
        cachedTokens: 0,
        cacheCreationTokens: null,
        costUsd: null,
        durationMs: 6,
      },
    ];
    const feed = buildConversationFeed(j, rows, llm);
    expect(feed.items.map((i) => i.kind)).toEqual(['history', 'request', 'turn', 'turn', 'answer']);
    expect(feed.items[0]).toEqual({
      kind: 'history',
      exchanges: [
        { role: 'user', text: TASK },
        { role: 'agent', text: '[ledger] 1 action' },
        { role: 'user', text: 'Merci' },
        { role: 'agent', text: 'De rien.' },
      ],
    });
    // Aucun « Nodal reminded the agent » pour de vrais messages de l'utilisateur.
    expect(feed.items.some((i) => i.kind === 'note')).toBe(false);
    // Les tours sont ceux de CE job : 2, pas 4 ; et l'historique n'a pas compté d'appels.
    expect(feed.totals.turns).toBe(2);
    expect(feed.totals.toolCalls).toBe(1);
    const t1 = feed.items[2];
    expect(t1?.kind === 'turn' && [t1.index, t1.turn, t1.turnSource]).toEqual([1, 1, 'audit']);
    expect(t1?.kind === 'turn' && t1.usage?.inputTokens).toBe(10);
  });

  it("le tour d'un message vient de la ligne d'audit : une tentative rejetée sans message de l'agent décale le compteur, pas le fil", () => {
    // Runner : tour 1 = appel c1 ; tour 2 = tentative rejetée (outil indisponible)
    // → seulement un `[système]` ; tour 3 = appel c2 ; tour 4 = réponse texte.
    const j: FeedJob = {
      ...job,
      messages: [
        { role: 'user', content: job.task },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'file_read', input: { path: 'a' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'file_read',
              output: { type: 'json', value: { ok: true } },
            },
          ],
        },
        { role: 'user', content: "[système] L'outil `foo` n'existe pas." },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c2', toolName: 'file_read', input: { path: 'b' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c2',
              toolName: 'file_read',
              output: { type: 'json', value: { ok: true } },
            },
          ],
        },
        { role: 'assistant', content: 'Voilà.' },
      ],
    };
    const rows: FeedToolCallRow[] = [
      {
        toolCallId: 'c1',
        toolName: 'file_read',
        card: 'read',
        presented: null,
        durationMs: 1,
        turn: 1,
        toolInput: {},
        toolOutput: '{"ok":true}',
        createdAt: null,
      },
      {
        toolCallId: 'c2',
        toolName: 'file_read',
        card: 'read',
        presented: null,
        durationMs: 1,
        turn: 3,
        toolInput: {},
        toolOutput: '{"ok":true}',
        createdAt: null,
      },
    ];
    const llm = (turn: number, input: number): FeedLlmCallRow => ({
      turn,
      source: 'job',
      modelEffective: `m${turn}`,
      provider: 'p',
      inputTokens: input,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: null,
      costUsd: null,
      durationMs: 1,
    });
    const feed = buildConversationFeed(j, rows, [
      llm(1, 100),
      llm(2, 200),
      llm(3, 300),
      llm(4, 400),
    ]);
    const turns = feed.items.filter((i) => i.kind === 'turn');
    expect(
      turns.map(
        (t) => t.kind === 'turn' && [t.index, t.turn, t.turnSource, t.model, t.usage?.inputTokens],
      ),
    ).toEqual([
      [1, 1, 'audit', 'm1', 100],
      [2, 3, 'audit', 'm3', 300], // pas m2 : le tour 2 n'a produit aucun message
      [3, 4, 'inferred', null, undefined], // texte seul : déduit, donc SANS métriques (elles pourraient être celles de la tentative rejetée)
    ]);
    expect(feed.items.filter((i) => i.kind === 'note')).toHaveLength(1);
  });
});
