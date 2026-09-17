// conversation-feed.test.ts — le fil se construit depuis la VRAIE forme des
// lignes : le transcript d'un job cron relevé en base dev le 06/09/2026
// (user string → assistant tool-calls → tool results → assistant reasoning +
// return_result → nudge `[système]` → telegram_send_message → return_result),
// ses tool_calls avec carte et charge utile (P1), ses llm_calls par tour.

import { describe, it, expect } from 'vitest';
import {
  buildConversationFeed,
  compactTurns,
  STANDALONE_CARDS,
  type FeedItem,
  type FeedJob,
  type FeedToolCallRow,
  type FeedLlmCallRow,
  type Step,
  type TurnUsage,
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

  it('replie les tours MUETS et additionne leurs jetons (P2bis)', () => {
    // Quatre tours du runner, deux tours à l'écran : les tours 2 et 4
    // n'appellent que `return_result` — ils ne disent rien et ne montrent rien.
    const turns = feed.items.filter((i) => i.kind === 'turn');
    expect(turns.map((t) => t.kind === 'turn' && t.index)).toEqual([1, 3]);
    const t1 = turns[0];
    expect(t1?.kind === 'turn' && t1.model).toBe('z-ai/glm-5.3');
    // Le tour 2 n'a AUCUNE ligne d'audit (`return_result` n'en écrit pas) : il
    // est déduit, donc sans métrique (passe 18). Fusionner n'invente rien —
    // les jetons restés sont ceux du tour 1, et les totaux du job les portent
    // tous. L'addition champ à champ est prouvée sur `compactTurns` plus bas.
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

  it('chaque tour porte l’heure de sa PREMIÈRE ligne d’audit ; sans ligne, aucune heure', () => {
    // #135 — l'en-tête montre quand le tour a commencé. La seule date lue est
    // celle des lignes d'audit d'outil : le tour 1 en a deux (…48.248 puis
    // …48.259) et prend la plus ancienne, pas la dernière.
    const turns = feed.items.filter((i) => i.kind === 'turn');
    expect(turns[0]?.kind === 'turn' && turns[0].at).toEqual(at('2026-09-05T15:01:48.248Z'));
    expect(turns[1]?.kind === 'turn' && turns[1].at).toEqual(at('2026-09-05T15:02:15.943Z'));
    // Un tour qui n'a appelé aucun outil n'a rien à dater : `null`, jamais la
    // date du job — elle daterait tous les tours de la même heure.
    const seul = buildConversationFeed(
      {
        ...job,
        task: 'x',
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: [{ type: 'text', text: 'Je regarde.' }] },
        ],
      },
      [],
      [],
    );
    const t = seul.items.find((i) => i.kind === 'turn');
    expect(t?.kind === 'turn' && t.at).toBeNull();
  });

  it('tour 1 : les actions mineures des tours 1 et 2 tiennent en UN groupe, dispatchées sur la CARTE persistée', () => {
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
      // Repliées depuis le tour 2, dans l'ordre.
      'reasoning',
      ['return_result', null, 'unknown', null],
    ]);
    const qm = block.steps[1];
    expect(qm?.kind === 'tool' && qm.presented).toEqual(tablePayload);
    expect(qm?.kind === 'tool' && qm.input).toEqual({ query: 'changelog' });
    expect(block.steps[2]).toEqual({
      kind: 'reasoning',
      text: 'Nothing new since 0.8.8 — announce nothing.',
    });
    const rr = block.steps[3];
    expect(rr?.kind === 'tool' && rr.presented).toBeNull();
  });

  it('tour 3 : la prose d’abord, l’envoi Telegram en CARTE, puis le tour 4 muet replié', () => {
    const t3 = feed.items.find((i) => i.kind === 'turn' && i.index === 3);
    expect(t3?.kind === 'turn' && t3.blocks.map((b) => b.kind)).toEqual(['prose', 'card', 'steps']);
    const card = t3?.kind === 'turn' ? t3.blocks[1] : undefined;
    expect(card?.kind === 'card' && card.step.card).toBe('sent');
    expect(card?.kind === 'card' && card.step.presented).toEqual(sentPayload);
    expect(card?.kind === 'card' && card.step.input).toEqual({ text: 'Rien de neuf.' });
    expect(card?.kind === 'card' && card.step.durationMs).toBe(24359);
  });

  it('se ferme sur la PAROLE de l’agent (pas sur `job.result`), et les totaux viennent des appels LLM', () => {
    // L'agent a parlé (« Rien de neuf dans le changelog aujourd’hui. ») avant
    // le tour muet d'envoi : sa prose est la réponse ; le `job.result`
    // machine (« No new entries. ») ne s'y ajoute pas (règle de structure,
    // passe 52).
    const last = feed.items.at(-1);
    expect(last?.kind).toBe('turn');
    expect(feed.items.some((i) => i.kind === 'answer')).toBe(false);
    expect(
      last?.kind === 'turn' &&
        last.blocks.some(
          (b) => b.kind === 'prose' && b.text === 'Rien de neuf dans le changelog aujourd’hui.',
        ),
    ).toBe(true);
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

describe('la réponse finale ne se dit pas deux fois (P2bis) — une règle de structure, pas de texte', () => {
  const oneTurn = (prose: string, result: string): FeedJob => ({
    ...job,
    task: 'x',
    result,
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'text', text: prose }] },
    ],
  });

  it('quand le dernier tour a PARLÉ, sa prose est la réponse : aucun item answer', () => {
    const feed = buildConversationFeed(oneTurn('Tout est prêt.', 'Tout est prêt.'), [], []);
    expect(feed.items.some((i) => i.kind === 'answer')).toBe(false);
  });

  it('même quand `job.result` dit AUTRE chose ou l’écrit autrement : la parole de l’agent prime', () => {
    // Quatre comparaisons de texte (passes 49 à 52) ont chacune laissé passer
    // un cas ; la dernière parce que « **Tout est prêt.** » et « Tout est
    // prêt. » diffèrent à l'octet et sont identiques à l'écran. Plus aucune
    // comparaison : ce que l'agent a écrit EST sa réponse.
    for (const [prose, result] of [
      ['Je regarde.', 'Tout est prêt.'],
      ['Voici le bilan :\n**Tout est prêt.**', 'Tout est prêt.'],
      ['Résultat : PAS OK.', 'OK.'],
      ['La vérification est OK. Je poursuis l’analyse.', 'OK.'],
    ] as const) {
      const feed = buildConversationFeed(oneTurn(prose, result), [], []);
      expect(
        feed.items.some((i) => i.kind === 'answer'),
        prose,
      ).toBe(false);
    }
  });

  it('la prose dite AVANT un rappel du runner et un tour muet d’envoi ne se répète pas', () => {
    // Le cas de la capture du 07/09 : l'agent écrit sa réponse, le runner lui
    // rappelle de l'envoyer, un tour muet appelle telegram_send_message puis
    // return_result — et la même phrase paraissait une seconde fois en bas.
    const feed = buildConversationFeed(
      {
        ...job,
        task: 'x',
        result: "C'est fait ✅ L'app est prête.",
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: [{ type: 'text', text: "C'est fait ✅ L'app est prête." }],
          },
          { role: 'user', content: '[système] Tu es sur Telegram. Envoie ta réponse.' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'send-1',
                toolName: 'telegram_send_message',
                input: {},
              },
              { type: 'tool-call', toolCallId: 'ret-1', toolName: 'return_result', input: {} },
            ],
          },
        ],
      },
      [],
      [],
    );
    expect(feed.items.some((i) => i.kind === 'answer')).toBe(false);
    const proses = feed.items.flatMap((i) =>
      i.kind === 'turn' ? i.blocks.filter((b) => b.kind === 'prose') : [],
    );
    expect(proses).toHaveLength(1);
  });

  it('quand l’agent a fini SANS un mot, `job.result` est la réponse et se montre', () => {
    const feed = buildConversationFeed(
      {
        ...job,
        task: 'x',
        result: 'Tout est prêt.',
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'ret-1', toolName: 'return_result', input: {} },
            ],
          },
        ],
      },
      [],
      [],
    );
    expect(feed.items.at(-1)).toEqual({ kind: 'answer', text: 'Tout est prêt.' });
  });

  it('un job terminé sans résultat ne produit pas d’item answer', () => {
    const feed = buildConversationFeed(oneTurn('Je regarde.', ''), [], []);
    expect(feed.items.some((i) => i.kind === 'answer')).toBe(false);
  });

  it('un tour muet qui a ENVOYÉ (carte sent) a répondu : la carte montre le texte, pas d’item answer (passe 53)', () => {
    // Un cron « tout en outils » : dashboard_publish puis return_result, aucune
    // prose. La carte « Sent to dashboard » porte déjà « Tout est prêt. ». La
    // charge est celle du VRAI présentateur de dashboard_publish
    // (`sentCard({ channel: 'dashboard', kind: 'dashboard' })`) — une passe de
    // revue a trouvé ce test vert avec un `kind: 'message'` que l'outil ne
    // produit jamais.
    const feed = buildConversationFeed(
      {
        ...job,
        task: 'x',
        result: 'Tout est prêt.',
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'pub-1',
                toolName: 'dashboard_publish',
                input: { text: 'Tout est prêt.' },
              },
              { type: 'tool-call', toolCallId: 'ret-1', toolName: 'return_result', input: {} },
            ],
          },
        ],
      },
      [
        {
          toolCallId: 'pub-1',
          toolName: 'dashboard_publish',
          card: 'sent',
          presented: { card: 'sent', channel: 'dashboard', kind: 'dashboard' },
          durationMs: 3,
          turn: 1,
          toolInput: { text: 'Tout est prêt.' },
          toolOutput: '{"ok":true}',
          createdAt: at('2026-09-07T10:00:00Z'),
        },
      ],
      [],
    );
    expect(feed.items.some((i) => i.kind === 'answer')).toBe(false);
    const cards = feed.items.flatMap((i) =>
      i.kind === 'turn' ? i.blocks.filter((b) => b.kind === 'card') : [],
    );
    expect(cards.map((c) => (c.kind === 'card' ? c.step.card : null))).toEqual(['sent']);
  });

  it('un tour muet qui a envoyé un FICHIER n’a pas dit sa phrase : `job.result` se montre', () => {
    const feed = buildConversationFeed(
      {
        ...job,
        task: 'x',
        result: 'Le rapport est en pièce jointe.',
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'file-1',
                toolName: 'send_file',
                input: { path: 'rapport.pdf' },
              },
            ],
          },
        ],
      },
      [
        {
          toolCallId: 'file-1',
          toolName: 'send_file',
          card: 'sent',
          presented: { card: 'sent', channel: 'telegram', kind: 'file', filename: 'rapport.pdf' },
          durationMs: 3,
          turn: 1,
          toolInput: { path: 'rapport.pdf' },
          toolOutput: '{"ok":true}',
          createdAt: at('2026-09-07T10:00:00Z'),
        },
      ],
      [],
    );
    expect(feed.items.at(-1)).toEqual({ kind: 'answer', text: 'Le rapport est en pièce jointe.' });
  });
});

describe('compactTurns — les tours muets se replient (P2bis)', () => {
  const step = (name: string): Step => ({
    kind: 'tool',
    toolName: name,
    toolCallId: name,
    jobId: 'j',
    lineCounts: {},
    card: null,
    presented: null,
    input: {},
    outputText: null,
    outcome: 'success',
    durationMs: 1,
    question: null,
  });

  const usage = (input: number, cost: number | null): TurnUsage => ({
    inputTokens: input,
    outputTokens: 1,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: cost,
    durationMs: 10,
    calls: 1,
  });

  const turn = (over: Partial<Extract<FeedItem, { kind: 'turn' }>>): FeedItem => ({
    kind: 'turn',
    index: 1,
    turn: 1,
    turnSource: 'audit',
    agent: { name: 'Alfred', slug: 'alfred' },
    model: 'm',
    at: null,
    blocks: [],
    usage: null,
    ...over,
  });

  it('fusionne les étapes, additionne les jetons, et ne laisse qu’un tour', () => {
    const out = compactTurns([
      turn({ index: 1, blocks: [{ kind: 'steps', steps: [step('a')] }], usage: usage(10, 0.1) }),
      turn({ index: 2, blocks: [{ kind: 'steps', steps: [step('b')] }], usage: usage(20, 0.2) }),
    ]);
    expect(out).toHaveLength(1);
    const merged = out[0];
    if (merged?.kind !== 'turn') throw new Error('tour attendu');
    expect(merged.index).toBe(1);
    expect(merged.blocks).toHaveLength(1);
    expect(
      merged.blocks[0]?.kind === 'steps' &&
        merged.blocks[0].steps.map((s) => (s.kind === 'tool' ? s.toolName : s.kind)),
    ).toEqual(['a', 'b']);
    expect(merged.usage?.inputTokens).toBe(30);
    expect(merged.usage?.costUsd).toBeCloseTo(0.3, 6);
    expect(merged.usage?.calls).toBe(2);
  });

  it('un tour DÉDUIT qui absorbe un tour AUDITÉ prend son identité avec ses jetons (passe 49)', () => {
    const out = compactTurns([
      turn({ turn: 1, turnSource: 'inferred', model: null, usage: null, blocks: [] }),
      turn({
        turn: 2,
        turnSource: 'audit',
        model: 'm2',
        usage: usage(2000, 0.01),
        blocks: [{ kind: 'steps', steps: [step('return_result')] }],
      }),
    ]);
    expect(out).toHaveLength(1);
    const only = out[0];
    if (only?.kind !== 'turn') throw new Error('tour attendu');
    // Les 2 000 jetons sont ceux du tour 2, audité : c'est lui que le fil
    // désigne maintenant — pas un tour 1 « déduit » qui porterait des métriques.
    expect(only.turn).toBe(2);
    expect(only.turnSource).toBe('audit');
    expect(only.usage?.inputTokens).toBe(2000);
    expect(only.model).toBe('m2');
  });

  it('deux tours AUDITÉS fusionnés gardent l’identité du premier', () => {
    const out = compactTurns([
      turn({ turn: 3, turnSource: 'audit', usage: usage(10, null), blocks: [] }),
      turn({
        turn: 4,
        turnSource: 'audit',
        usage: usage(20, null),
        blocks: [{ kind: 'steps', steps: [step('x')] }],
      }),
    ]);
    const only = out[0];
    if (only?.kind !== 'turn') throw new Error('tour attendu');
    expect(only.turn).toBe(3);
    expect(only.usage?.inputTokens).toBe(30);
  });

  it('un coût inconnu reste inconnu, et un coût connu survit à un inconnu', () => {
    const both = compactTurns([
      turn({ blocks: [{ kind: 'steps', steps: [step('a')] }], usage: usage(10, null) }),
      turn({ blocks: [{ kind: 'steps', steps: [step('b')] }], usage: usage(20, null) }),
    ]);
    expect(both[0]?.kind === 'turn' && both[0].usage?.costUsd).toBeNull();
    const mixed = compactTurns([
      turn({ blocks: [{ kind: 'steps', steps: [step('a')] }], usage: usage(10, null) }),
      turn({ blocks: [{ kind: 'steps', steps: [step('b')] }], usage: usage(20, 0.5) }),
    ]);
    expect(mixed[0]?.kind === 'turn' && mixed[0].usage?.costUsd).toBe(0.5);
  });

  it('un tour qui PARLE ne fusionne pas', () => {
    const out = compactTurns([
      turn({ index: 1, blocks: [{ kind: 'steps', steps: [step('a')] }] }),
      turn({ index: 2, blocks: [{ kind: 'prose', text: 'voilà' }] }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('un tour qui MONTRE une carte ne fusionne pas', () => {
    const out = compactTurns([
      turn({ index: 1, blocks: [{ kind: 'steps', steps: [step('a')] }] }),
      turn({ index: 2, blocks: [{ kind: 'card', step: step('b') as never }] }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('deux agents différents ne fusionnent jamais', () => {
    const out = compactTurns([
      turn({ index: 1, blocks: [{ kind: 'steps', steps: [step('a')] }] }),
      turn({
        index: 2,
        agent: { name: 'Lead', slug: 'lead' },
        blocks: [{ kind: 'steps', steps: [step('b')] }],
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('une note entre les deux empêche la fusion', () => {
    const out = compactTurns([
      turn({ index: 1, blocks: [{ kind: 'steps', steps: [step('a')] }] }),
      { kind: 'note', text: 'rappel', origin: 'runner' },
      turn({ index: 2, blocks: [{ kind: 'steps', steps: [step('b')] }] }),
    ]);
    expect(out.map((i) => i.kind)).toEqual(['turn', 'note', 'turn']);
  });

  it('un tour à ZÉRO bloc se replie sans rien ajouter', () => {
    const out = compactTurns([
      turn({ index: 1, blocks: [{ kind: 'steps', steps: [step('a')] }] }),
      turn({ index: 2, blocks: [] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind === 'turn' && out[0].blocks).toHaveLength(1);
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

  it('une écriture qui n’a pas ABOUTI (en attente d’approbation, bloquée, en erreur) n’a aucun compteur de lignes', () => {
    // Vu en vrai le 07/09 : un `file_edit` en attente d'approbation comptait
    // déjà « +2 −1 » dans le récapitulatif, sur un fichier intact.
    const edit = {
      type: 'tool-call',
      toolName: 'file_edit',
      input: { path: 'notes/bonjour.html', old_string: 'a', new_string: 'b\nc' },
    };
    const j: FeedJob = {
      ...job,
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: [
            { ...edit, toolCallId: 'c1' },
            { ...edit, toolCallId: 'c2' },
            { ...edit, toolCallId: 'c3' },
            { ...edit, toolCallId: 'c4' },
            // c5 : dans le transcript, mais SANS ligne d'audit (l'insertion a
            // échoué, executeTool l'avale) — on ne sait pas si elle a tourné.
            { ...edit, toolCallId: 'c5' },
          ],
        },
      ],
    };
    const row = (toolCallId: string, toolOutput: string | null): FeedToolCallRow => ({
      toolCallId,
      toolName: 'file_edit',
      card: 'files',
      presented: null,
      durationMs: 1,
      turn: 1,
      toolInput: {},
      toolOutput,
      createdAt: null,
    });
    const feed = buildConversationFeed(
      j,
      [
        row('c1', '{"outcome":"awaiting_approval"}'),
        row('c2', '{"outcome":"blocked"}'),
        row('c3', '{"outcome":"error","error":"boom"}'),
        row('c4', '{"ok":true,"path":"notes/bonjour.html"}'),
      ],
      [],
    );
    const turn = feed.items[1];
    const steps =
      turn?.kind === 'turn'
        ? turn.blocks.flatMap((b) =>
            b.kind === 'steps' ? b.steps : b.kind === 'card' ? [b.step] : [],
          )
        : [];
    const counts = steps.map((s) => (s.kind === 'tool' ? [s.outcome, s.lineCounts] : null));
    expect(counts).toEqual([
      ['awaiting_approval', {}],
      ['blocked', {}],
      ['error', {}],
      ['success', { 'notes/bonjour.html': { added: 2, removed: 1 } }],
      ['unknown', {}],
    ]);
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
    expect(feed.items.at(-2)).toEqual({
      kind: 'child',
      job: child,
      from: { name: 'Veilleur', slug: 'veilleur' },
    });
    expect(feed.items.at(-1)).toEqual({ kind: 'failure', text: 'delivery_spam_guard' });
  });

  // #135 — « Les délégations ne sont jamais imbriquées » (tableau de Quentin).
  // Une délégation cachée DANS une autre disparaît dès que le parent est
  // replié : on ne voit plus qui a fait travailler qui.
  it('une délégation qui délègue à son tour devient un bloc FRÈRE, jamais imbriqué', () => {
    const grandChild = {
      id: 'grandchild-1',
      agentName: 'Reviewer C',
      agentSlug: 'reviewer-c',
      status: 'completed',
      task: 'relis le correctif',
      result: 'ça tient',
      error: null,
      createdAt: null,
      completedAt: null,
    };
    // Le fil de l'enfant est assemblé par la MÊME fonction (job-feed.ts appelle
    // `buildConversationFeed` un niveau plus bas) : on le construit ici de la
    // même façon, jamais à la main, sinon le test prouverait une forme que le
    // code de production ne produit pas.
    const childFeed = buildConversationFeed(
      {
        ...job,
        id: 'child-1',
        agentName: 'Le Relecteur',
        agentSlug: 'relecteur',
        messages: [],
        result: 'revue faite',
        children: [grandChild],
      },
      [],
      [],
    );
    const child = {
      id: 'child-1',
      agentName: 'Le Relecteur',
      agentSlug: 'relecteur',
      status: 'completed',
      task: 'fais relire',
      result: 'revue faite',
      error: null,
      createdAt: null,
      completedAt: null,
      feed: childFeed,
    };
    const feed = buildConversationFeed({ ...job, messages: [], children: [child] }, [], []);

    const children = feed.items.filter((i) => i.kind === 'child');
    expect(children.map((c) => c.job.id)).toEqual(['child-1', 'grandchild-1']);
    // Chacun dit QUI a délégué : le job pour l'enfant, l'enfant pour le
    // petit-enfant.
    expect(children[0]?.from).toEqual({ name: 'Veilleur', slug: 'veilleur' });
    expect(children[1]?.from).toEqual({ name: 'Le Relecteur', slug: 'relecteur' });
    // Le frère suit IMMÉDIATEMENT son parent, dans l'ordre où ça s'est passé.
    const at = feed.items.findIndex((i) => i.kind === 'child' && i.job.id === 'child-1');
    expect(feed.items[at + 1]).toBe(children[1]);
    // Et le fil de l'enfant ne porte PLUS sa délégation : elle a été remontée,
    // pas recopiée.
    const lifted = children[0]?.job.feed?.items.filter((i) => i.kind === 'child') ?? [];
    expect(lifted).toEqual([]);
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
    // Pas d'item `answer` : la réponse du job EST la dernière prose du tour
    // (« Rien depuis hier. »), et le fil ne la dit pas deux fois (P2bis).
    expect(feed.items.map((i) => i.kind)).toEqual(['history', 'request', 'turn', 'turn']);
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
