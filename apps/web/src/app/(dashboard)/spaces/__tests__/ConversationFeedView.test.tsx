// ConversationFeedView.test.tsx — le fil rendu en HTML depuis un feed qui
// contient chaque sorte de bloc : chaque carte se dessine depuis sa charge
// utile (jamais depuis le nom de l'outil), une action mineure se replie, une
// ligne sans charge se montre brute en le disant.
//
// Rendu statique côté serveur (renderToStaticMarkup) : pas de navigateur, pas
// de bibliothèque de test de composants dans ce dépôt — on lit le HTML.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationFeedView from '../ConversationFeedView.tsx';
import { compactTurns } from '@/lib/conversation-feed.ts';
import { lineCountsOfCall } from '@/lib/coding-changes.ts';
import type { ConversationFeed, Step } from '@/lib/conversation-feed.ts';

const tool = (over: Partial<Extract<Step, { kind: 'tool' }>>): Extract<Step, { kind: 'tool' }> => ({
  kind: 'tool',
  toolName: 'x',
  toolCallId: 'c',
  jobId: 'job-1',
  card: null,
  presented: null,
  input: {},
  outputText: null,
  outcome: 'success',
  durationMs: 10,
  lineCounts: {},
  question: null,
  ...over,
});

const feed: ConversationFeed = {
  items: [
    {
      kind: 'history',
      exchanges: [
        { role: 'user', text: 'Quoi de neuf hier ?' },
        { role: 'agent', text: 'Deux nouveautés hier.' },
      ],
    },
    {
      kind: 'request',
      text: 'Prépare la revue',
      origin: { channel: 'cron', scheduleName: 'Revue mensuelle', chatId: null },
      at: null,
    },
    {
      kind: 'turn',
      index: 1,
      turn: 1,
      turnSource: 'audit',
      agent: { name: 'Alfred', slug: 'alfred' },
      model: 'claude-opus-5',
      usage: {
        inputTokens: 12000,
        outputTokens: 480,
        cachedTokens: 9000,
        cacheCreationTokens: 0,
        costUsd: 0.048,
        durationMs: 9400,
        calls: 1,
      },
      blocks: [
        { kind: 'prose', text: 'Je reprends le **format** du mois dernier.' },
        {
          kind: 'steps',
          steps: [
            { kind: 'reasoning', text: 'la mémoire devrait avoir le format' },
            tool({
              toolName: 'query_memory',
              card: 'table',
              presented: {
                card: 'table',
                tables: [
                  {
                    columns: ['fact'],
                    header: 'columns',
                    rows: [],
                    total: 0,
                    truncated: false,
                    clipped: false,
                  },
                ],
              },
            }),
            tool({
              toolName: 'mcp_x__fetch',
              card: 'generic',
              presented: { card: 'generic' },
              outputText: 'brut',
            }),
          ],
        },
        {
          kind: 'card',
          step: tool({
            toolName: 'xlsx_read',
            card: 'table',
            presented: {
              card: 'table',
              tables: [
                {
                  name: 'Synthèse',
                  columns: [],
                  header: 'unknown',
                  rows: [
                    ['Poste', 'Juillet', 'Août'],
                    ['Infrastructure', 12400, 14100],
                  ],
                  total: 2,
                  truncated: false,
                  clipped: false,
                },
              ],
            },
          }),
        },
        {
          kind: 'card',
          step: tool({
            toolName: 'telegram_send_message',
            card: 'sent',
            input: { text: 'La revue est prête.' },
            presented: { card: 'sent', channel: 'telegram', kind: 'message', target: '42' },
          }),
        },
        {
          kind: 'card',
          step: tool({
            toolName: 'run_command',
            card: 'terminal',
            presented: {
              card: 'terminal',
              command: 'pnpm test',
              exitCode: 1,
              timedOut: false,
              stdoutTail: '1 failed',
              stdoutTruncated: true,
              stderrTail: '',
              stderrTruncated: false,
            },
          }),
        },
        {
          kind: 'card',
          step: tool({
            toolName: 'legacy_tool',
            card: 'files',
            presented: null,
            input: { path: 'a.md' },
            outputText: '{"ok":true}',
          }),
        },
      ],
    },
    { kind: 'note', text: 'Tu es sur Telegram. Livre ta réponse.', origin: 'runner' },
    { kind: 'note', text: 'Older turns are not shown (2 shown).', origin: 'thread' },
    { kind: 'answer', text: 'La revue d’août est prête et envoyée.' },
  ],
  totals: {
    turns: 1,
    toolCalls: 5,
    inputTokens: 12000,
    outputTokens: 480,
    cachedTokens: 9000,
    cacheCreationTokens: 0,
    costUsd: 0.048,
    llmDurationMs: 9400,
    models: ['claude-opus-5'],
  },
};

describe('ConversationFeedView', () => {
  const html = renderToStaticMarkup(<ConversationFeedView feed={feed} />);

  it('la demande dit d’où elle vient ; les jetons sont dans la ligne d’appel du modèle', () => {
    expect(html).toContain('Prépare la revue');
    expect(html).toContain('via automation “Revue mensuelle”');
    expect(html).toContain('Alfred');
    // #135 — la ligne du nom ne porte QUE le modèle, dans sa couleur.
    expect(html).toContain('>claude-opus-5<');
    expect(html).toMatch(/text-feed-model[^"]*"[^>]*>claude-opus-5</);
    // Les nombres du tour ne sont ni dans l'en-tête ni dans la ligne de
    // raisonnement : ils ont leur bloc, avec le modèle qui les a produits.
    expect(html).not.toContain('claude-opus-5 · 12,480 tokens');
    expect(html).not.toContain('1 step · 9.4 s');
    expect(html).toContain('1 step<');
    expect(html).toContain('12,000 in · 480 out · 9,000 cached');
    expect(html).toContain('9.4 s · $0.05');
  });

  it('le markdown de la prose est RENDU : plus d’astérisques à l’écran', () => {
    expect(html).toContain('<strong class="font-semibold text-ink">format</strong>');
    expect(html).not.toContain('**format**');
  });

  it('la réponse finale est un tour de l’agent, jamais une plaque « Answer »', () => {
    expect(html).toContain('La revue d’août est prête et envoyée.');
    expect(html).not.toContain('>Answer<');
    // Une seule fois : la prose du dernier tour ne la répète pas.
    expect(html.split('La revue d’août est prête et envoyée.')).toHaveLength(2);
  });

  it('un rappel du runner se nomme ; un aveu du fil parle en son nom', () => {
    expect(html).toContain('Nodal reminded the agent · Tu es sur Telegram.');
    expect(html).toContain('Older turns are not shown (2 shown).');
    expect(html).not.toContain('Nodal reminded the agent · Older turns');
  });

  it('un tour sans prose ni carte fusionne dans le précédent', () => {
    const muet = {
      kind: 'turn' as const,
      index: 2,
      turn: 2,
      turnSource: 'audit' as const,
      agent: { name: 'Alfred', slug: 'alfred' },
      model: 'claude-opus-5',
      usage: null,
      blocks: [{ kind: 'steps' as const, steps: [tool({ toolName: 'file_read' })] }],
    };
    const compact = compactTurns([feed.items[2]!, muet]);
    const rendu = renderToStaticMarkup(
      <ConversationFeedView feed={{ items: compact, totals: feed.totals }} />,
    );
    // Un seul « Alfred » : un seul tour à l'écran.
    expect(rendu.split('>Alfred<')).toHaveLength(2);
    // L'appel du tour fusionné est là, visible, avec son nom court.
    expect(rendu).toContain('file_read');
    // Et plus jamais l'aveu d'un tour vide.
    expect(rendu).not.toContain('No visible action this turn');
  });

  it('le raisonnement est replié ; CHAQUE appel d’outil est visible et nommé', () => {
    // Replié par défaut : le texte du raisonnement n'est pas dans le HTML.
    expect(html).toContain('Reasoning');
    expect(html).not.toContain('la mémoire devrait avoir le format');
    // Plus de groupe « N tool calls » : les deux appels mineurs du tour se
    // lisent chacun sur sa ligne, avec leur nom court et leur résultat.
    expect(html).not.toContain('tool calls');
    expect(html).toContain('query_memory');
    expect(html).toContain('>fetch<'); // mcp_x__fetch, sans son préfixe de serveur
    // #135 — REPLIÉ veut dire replié : le nom reste, le résumé du résultat
    // attend le clic. Un fil de vingt appels tient donc sur vingt lignes.
    expect(html).not.toContain('1 table · 0 rows');
    expect(html).not.toContain('brut');
    expect(html.split('aria-expanded="false"').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('la carte table dessine les cellules et dit que l’en-tête est inconnu', () => {
    expect(html).toContain('Synthèse');
    expect(html).toContain('Infrastructure');
    expect(html).toContain('14100');
    expect(html).toContain('first row may or may not be a header');
  });

  it('la carte d’envoi dit le canal, le destinataire et le message parti', () => {
    expect(html).toContain('Sent to telegram');
    expect(html).toContain('to 42');
    expect(html).toContain('La revue est prête.');
  });

  it('la carte terminal montre la commande, le code de sortie et la coupe', () => {
    expect(html).toContain('pnpm test');
    expect(html).toContain('exit 1');
    expect(html).toContain('earlier output not kept');
  });

  it('une carte de résultat sans charge utile prend la MÊME ligne repliée', () => {
    // #135 — plus de grand cadre ouvert sur son JSON : un appel dont la carte
    // ne se lit pas est un appel comme les autres, une ligne, dépliable.
    expect(html).toContain('legacy_tool');
    expect(html).toContain('(a.md)');
    // L'aveu « brut » et le JSON vivent dans le corps, pas à l'écran.
    expect(html).not.toContain('files · raw');
    expect(html).not.toContain('&quot;path&quot;: &quot;a.md&quot;');
  });

  it("l'historique de la conversation est là, replié, et dit combien de messages il porte", () => {
    expect(html).toContain('Earlier in this conversation');
    expect(html).toContain('2 messages');
    // Replié : le texte des anciens échanges n'est pas dans le HTML initial…
    expect(html).not.toContain('Deux nouveautés hier.');
    // …et il précède la demande.
    expect(html.indexOf('Earlier in this conversation')).toBeLessThan(
      html.indexOf('Prépare la revue'),
    );
  });

  it('la carte des fichiers est une REVUE DE DIFF quand l’agent a écrit, une liste quand il a lu', () => {
    const filesFeed = (action: 'created' | 'listed'): ConversationFeed => ({
      items: [
        {
          kind: 'turn',
          index: 1,
          turn: 1,
          turnSource: 'audit',
          agent: { name: 'Alfred', slug: 'alfred' },
          model: null,
          usage: null,
          blocks: [
            {
              kind: 'card',
              step: tool({
                toolName: 'file_write',
                card: 'files',
                presented: {
                  card: 'files',
                  total: 1,
                  truncated: false,
                  files: [{ path: 'src/auth/session.ts', action, detail: '2 hunks' }],
                },
              }),
            },
          ],
        },
      ],
      totals: feed.totals,
    });
    const written = renderToStaticMarkup(<ConversationFeedView feed={filesFeed('created')} />);
    expect(written).toContain('diff review');
    expect(written).toContain('1 file');
    expect(written).toContain('src/auth/session.ts');
    expect(written).toContain('2 hunks');
    // Sans écriture textuelle lue dans l'entrée, AUCUN compteur : jamais un
    // « +0 » qui laisserait croire à une écriture vide.
    expect(written).not.toContain('+0');
    // Et le mot « created » ne revient plus sur la ligne : c'est la pastille.
    expect(written).not.toContain('>created<');

    const read = renderToStaticMarkup(<ConversationFeedView feed={filesFeed('listed')} />);
    expect(read).toContain('>files<');
    expect(read).not.toContain('diff review');
  });

  it('la carte des fichiers porte les compteurs de lignes, par fichier et en total', () => {
    // L'entrée de l'appel est ce qui porte les lignes — la même lecture que la
    // page Code (`lineCountsOfCall`), donc les mêmes nombres sur les deux
    // écrans. Le classeur, écrit par un outil sans texte, n'a pas de
    // compteurs : sa ligne n'en montre aucun.
    const input = {
      changes: [
        { path: 'src/auth/session.ts', kind: 'update', diff: ['a', 'b'].join('\n') },
        { path: 'src/auth/token-service.ts', kind: 'add', diff: ['a', 'b', 'c'].join('\n') },
      ],
      path: 'src/auth/session.ts',
    };
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'turn',
              index: 1,
              turn: 1,
              turnSource: 'audit',
              agent: { name: 'Alfred', slug: 'alfred' },
              model: null,
              usage: null,
              blocks: [
                {
                  kind: 'card',
                  step: tool({
                    toolName: 'cli:file_change',
                    card: 'files',
                    input,
                    lineCounts: lineCountsOfCall('cli:file_change', input, null),
                    presented: {
                      card: 'files',
                      total: 3,
                      truncated: false,
                      files: [
                        { path: 'src/auth/session.ts', action: 'modified' },
                        { path: 'src/auth/token-service.ts', action: 'created' },
                        { path: 'reports/bilan.xlsx', action: 'created' },
                      ],
                    },
                  }),
                },
              ],
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    // Par fichier : deux lignes pour l'un, trois pour l'autre.
    expect(html2).toContain('+2');
    expect(html2).toContain('+3');
    // En tête : la somme des fichiers de la carte.
    expect(html2).toContain('+5');
    // Le classeur n'a pas de compteurs, et rien ne les invente pour lui.
    expect(html2).toContain('reports/bilan.xlsx');
    expect(html2).not.toContain('+0');
    expect(html2).not.toContain('−0');
  });

  it('une délégation porte le nom du délégué, ce qu’il a rendu, et son coût', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'child',
              job: {
                id: 'job-2',
                agentName: 'Le Relecteur',
                agentSlug: 'relecteur',
                status: 'completed',
                task: 'Audite le correctif de session',
                result: ['## Verdict', '', 'Le correctif tient, une note mineure.'].join('\n'),
                error: null,
                createdAt: new Date('2026-09-07T10:00:00Z'),
                completedAt: new Date('2026-09-07T10:01:12Z'),
                feed: {
                  items: [],
                  totals: { ...feed.totals, inputTokens: 40000, outputTokens: 200, costUsd: 0.14 },
                },
              },
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    expect(html2).toContain('Delegated to Le Relecteur');
    // Le TITRE est la première ligne plate du résultat, pas la consigne, et le
    // markdown n'y laisse pas ses dièses.
    expect(html2).toContain('Verdict');
    expect(html2).not.toContain('## Verdict');
    expect(html2).toContain('1 min 12 · 40,200 tokens · $0.14');
    // Terminé : pastille verte, et plus de pastille d'état à mots.
    expect(html2).toContain('bg-ok');
    expect(html2).not.toContain('>Done<');
    // Replié : la consigne du délégué n'est pas dans le HTML initial.
    expect(html2).not.toContain('Audite le correctif de session');
  });

  it('la réponse ferme le fil, après l’envoi', () => {
    expect(html.lastIndexOf('La revue d’août est prête et envoyée.')).toBeGreaterThan(
      html.indexOf('Sent to telegram'),
    );
  });
});

// ─── « Créer, c'est prouver », point 2 — la consigne passée au travail se déplie ──

describe('ConversationFeedView — le handoff', () => {
  // La ligne « Handed to the work » était tronquée à une ligne. Or elle
  // portait 1 649 caractères, et c'est là qu'on voyait qu'Alfred avait inventé
  // des exigences que personne ne lui avait données. L'écran cachait la preuve.
  const consigne = `Build a CSS/HTML base skill. Requirements: 1. ${'x'.repeat(1600)} END-OF-HANDOFF`;
  const feedAvecHandoff: ConversationFeed = {
    items: [
      {
        kind: 'request',
        text: 'Crée un skill CSS',
        origin: { channel: 'dashboard', scheduleName: null, chatId: null },
        at: null,
      },
      { kind: 'handoff', text: consigne },
    ],
    totals: { toolCalls: 0, costUsd: null, durationMs: 0 } as never,
  };

  it('replié : un bouton de dépliage, et la consigne ENTIÈRE est dans la page (le clip est visuel)', () => {
    const html = renderToStaticMarkup(<ConversationFeedView feed={feedAvecHandoff} />);
    expect(html).toContain('Handed to the work');
    expect(html).toContain('aria-expanded="false"');
    // Plus de troncature par attribut `title` : le texte est dans le flux.
    expect(html).toContain('END-OF-HANDOFF');
  });

  it('une consigne VIDE ne se déplie pas — pas de séparateur seul, pas de bouton pour rien', () => {
    // Revue Codex de la PR #66, constat C9. Le séparateur `·` ne dépendait que
    // de l'état replié : un tour dont le message d'utilisateur ne porte aucun
    // bloc de texte (une image seule) produit `text: ''`, et l'écran offrait de
    // déplier du vide derrière un point.
    const vide: ConversationFeed = {
      ...feedAvecHandoff,
      items: [feedAvecHandoff.items[0]!, { kind: 'handoff', text: '   \n' }],
    };
    const html = renderToStaticMarkup(<ConversationFeedView feed={vide} />);
    expect(html).not.toContain('Handed to the work');
    expect(html).not.toContain('aria-expanded');
  });
});
