// ConversationFeedView.test.tsx — le fil rendu en HTML depuis un feed qui
// contient chaque sorte de bloc : chaque carte se dessine depuis sa charge
// utile (jamais depuis le nom de l'outil), une action mineure se replie, une
// ligne sans charge se montre brute en le disant.
//
// Rendu statique côté serveur (renderToStaticMarkup) : pas de navigateur, pas
// de bibliothèque de test de composants dans ce dépôt — on lit le HTML.

import { describe, it, expect } from 'vitest';
import { PROVIDER_REJECTED, PROVIDER_REJECTED_PREFIX } from '@nodal-agents/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationFeedView, { delegationVerdictLine } from '../ConversationFeedView.tsx';
import { compactTurns } from '@/lib/conversation-feed.ts';
import { lineCountsOfCall } from '@/lib/coding-changes.ts';
import type { ConversationFeed, FeedChildJob, Step } from '@/lib/conversation-feed.ts';

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
      agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
      model: 'claude-opus-5',
      // Construite à partir de composants LOCAUX : l'en-tête affiche l'heure
      // dans le fuseau du lecteur, et une date UTC rendrait le test dépendant
      // du fuseau de la machine de CI.
      at: new Date(2026, 8, 17, 14, 2),
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

/** Le fil réduit à la SEULE carte d'envoi, de quoi la cliquer sans bruit. */
const envoi: ConversationFeed = {
  items: [
    {
      kind: 'turn',
      index: 1,
      turn: 1,
      turnSource: 'audit',
      agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
      model: null,
      at: null,
      usage: null,
      blocks: [
        {
          kind: 'card',
          step: tool({
            toolName: 'telegram_send_message',
            card: 'sent',
            input: { text: 'La revue est prête.' },
            presented: { card: 'sent', channel: 'telegram', kind: 'message', target: '42' },
          }),
        },
      ],
    },
  ],
  totals: feed.totals,
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

  it('la ligne d’appel du modèle est le DERNIER bloc du tour', () => {
    // Le tour ne date pas son appel de modèle : il va donc après tout ce que
    // le tour a fait, jamais au-dessus. Le nom du modèle paraît deux fois —
    // dans l'en-tête en Mono/11, dans la ligne d'appel en Mono/12 — et c'est
    // la SECONDE qu'on situe ici.
    const ligneModele = html.indexOf('text-mono-12 text-feed-model');
    const raisonnement = html.indexOf('text-feed-reasoning');
    const outil = html.lastIndexOf('text-feed-tool');
    expect(ligneModele).toBeGreaterThan(-1);
    expect(raisonnement).toBeGreaterThan(-1);
    expect(outil).toBeGreaterThan(-1);
    expect(ligneModele).toBeGreaterThan(raisonnement);
    expect(ligneModele).toBeGreaterThan(outil);
    // Et l'en-tête du tour, lui, précède tout le reste.
    expect(html.indexOf('text-mono-11 text-feed-model')).toBeLessThan(raisonnement);
  });

  it('l’en-tête du tour porte l’avatar, le nom, le modèle, puis l’heure à droite', () => {
    // #135, composant `TurnHeader` : l'avatar carré de l'agent ouvre la ligne
    // (ses initiales, comme partout ailleurs dans l'application)…
    expect(html).toContain('>AL<');
    expect(html).toMatch(/rounded-\[8px\][^"]*"[^>]*>AL</);
    // …et l'heure de DÉBUT du tour la ferme, poussée à droite.
    const heure = new Date(2026, 8, 17, 14, 2).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(heure).toBe('14:02');
    expect(html).toMatch(/ml-auto text-mono-11 text-ink-4">14:02</);
    // Elle précède la prose : c'est bien l'en-tête, pas un pied de tour.
    expect(html.indexOf('>14:02<')).toBeLessThan(html.indexOf('Je reprends le '));
  });

  it('un tour SANS heure n’en dessine aucune — rien d’inventé', () => {
    const sansHeure = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'turn',
              index: 1,
              turn: 1,
              turnSource: 'audit',
              agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
              model: 'claude-opus-5',
              at: null,
              usage: null,
              blocks: [{ kind: 'prose', text: 'Rien à dater ici.' }],
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    // L'en-tête est bien là — avatar et nom — mais sans sa case de droite.
    expect(sansHeure).toContain('>AL<');
    expect(sansHeure).toContain('>Alfred<');
    expect(sansHeure).not.toContain('ml-auto text-mono-11 text-ink-4');
    expect(sansHeure).not.toMatch(/>\d{2}:\d{2}</);
  });

  it('l’agent parle en 13 px dans SA couleur ; la bulle de la demande ne bouge pas', () => {
    // #135 — la voix de l'agent est le FOND du fil : en 15 px elle écrasait
    // les blocs qui l'entourent, tous en 13 ou moins. Elle a aussi sa couleur,
    // `feed/prose`, la dixième du nuancier du fil.
    expect(html).toMatch(/max-w-\[68ch\] text-body-13 text-feed-prose">Je reprends le /);
    // La demande de l'utilisateur, elle, garde sa taille ET l'encre pleine.
    expect(html).toMatch(/max-w-\[68ch\] text-body-15 text-ink">Prépare la revue</);
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
      agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
      model: 'claude-opus-5',
      at: new Date(2026, 8, 17, 14, 9),
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

  it('la carte d’envoi tient sur UNE ligne : le message n’est pas dans le DOM replié', () => {
    // #135 — le dernier grand cadre du fil devient un bloc comme les autres.
    // Replié n'est pas caché : la ligne dit déjà le canal, la sorte et le
    // destinataire. Le message, lui, attend le clic.
    expect(html).toContain('Sent to telegram');
    expect(html).toContain('to 42');
    expect(html).not.toContain('La revue est prête.');
    // Et la ligne est bien dépliable, pas un cadre muet.
    expect(html).toMatch(/aria-expanded="false"[^>]*>(?:(?!<\/button>)[\s\S])*Sent to telegram/);
  });

  it('un clic sur la carte d’envoi OUVRE le message', async () => {
    // Le dépliage est un état du navigateur : jsdom, pas du HTML statique.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationFeedView feed={envoi} />);
    });
    expect(container.textContent).not.toContain('La revue est prête.');
    const tete = container.querySelector('button');
    if (!tete) throw new Error('la carte d’envoi n’a pas de tête cliquable');
    await act(async () => {
      tete.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('La revue est prête.');
    expect(tete.getAttribute('aria-expanded')).toBe('true');
    root.unmount();
    container.remove();
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
          agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
          model: null,
          at: null,
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
              agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
              model: null,
              at: null,
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

  // #135 — la tête d'une délégation se lit comme une phrase : QUI a délégué, à
  // QUI, pour QUOI. Tout replié, la chaîne entière reste lisible.
  it('la tête d’une délégation dit « Intendant delegated to Le Relecteur », la consigne, l’état et les chiffres', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'child',
              from: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
              job: {
                id: 'job-2',
                agentName: 'Le Relecteur',
                agentSlug: 'relecteur',
                agentAvatarUrl: null,
                status: 'completed',
                task: 'Audite le correctif de session',
                result: ['## Verdict', '', 'Le correctif tient, une note mineure.'].join('\n'),
                error: null,
                failureHint: null,
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
    // Les deux noms, et entre eux les mots du tableau — en minuscules, dans la
    // couleur de la délégation. Remettre `text-ok` (l'ancienne étiquette verte)
    // fait rougir la ligne suivante.
    expect(html2).toContain('Intendant');
    expect(html2).toContain('Le Relecteur');
    expect(html2).toMatch(/text-feed-delegation[^>]*>delegated to</);
    expect(html2).not.toContain('DELEGATED TO');
    expect(html2).not.toContain('Delegated to Le Relecteur');
    // La tête porte la CONSIGNE (le résultat, lui, est dans le corps).
    expect(html2).toContain('Audite le correctif de session');
    // L'état : la pastille à mots du tableau, et le point de couleur qui dit
    // d'un coup d'œil que ça a atterri.
    expect(html2).toContain('>Done<');
    // Le POINT lui-même (8 px), pas la teinte de la pastille (`bg-ok-bg`) :
    // c'est lui que le parcours Playwright lit en `span.bg-ok`.
    expect(html2).toMatch(/h-2 w-2 shrink-0 rounded-full bg-ok"/);
    expect(html2).toContain('1 min 12 · 40,200 tokens · $0.14');
    // Replié : le corps n'est pas dans le HTML initial — ni le résultat du
    // délégué, ni le lien vers son run.
    expect(html2).not.toContain('Le correctif tient');
    expect(html2).not.toContain('Open run');
    // Pleine largeur : plus de gouttière qui rentrerait la délégation par
    // rapport aux blocs d'outil du tour juste au-dessus (#135).
    expect(html2).not.toContain('pl-[46px]');
    expect(html2).not.toContain('ml-[46px]');
  });

  // #135 — « Les délégations ne sont jamais imbriquées ». Le fil les remonte
  // (`buildConversationFeed`) ; l'écran refuse en plus d'en dessiner une dans
  // une autre, pour qu'un fil assemblé à la main ne rouvre pas la porte.
  it('une délégation n’en contient jamais une autre, même DÉPLIÉE', async () => {
    const grandChild = {
      id: 'job-3',
      agentName: 'Relecteur Bis',
      agentSlug: 'relecteur-bis',
      agentAvatarUrl: null,
      status: 'completed',
      task: 'relis',
      result: 'ça tient',
      error: null,
      failureHint: null,
      createdAt: null,
      completedAt: null,
    };
    const avecPetitEnfant: ConversationFeed = {
      items: [
        {
          kind: 'child',
          from: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
          job: {
            id: 'job-2',
            agentName: 'Le Relecteur',
            agentSlug: 'relecteur',
            agentAvatarUrl: null,
            status: 'completed',
            task: 'fais relire',
            result: 'revue faite',
            error: null,
            failureHint: null,
            createdAt: null,
            completedAt: null,
            feed: {
              items: [
                {
                  kind: 'child',
                  from: { name: 'Le Relecteur', slug: 'relecteur', avatarUrl: null },
                  job: grandChild,
                },
              ],
              totals: feed.totals,
            },
          },
        },
      ],
      totals: feed.totals,
    };
    // DÉPLIÉE : replié, le corps n'est pas dans le DOM, et le test ne prouverait
    // rien. C'est ouvert qu'une imbrication se verrait.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationFeedView feed={avecPetitEnfant} />);
    });
    const tete = container.querySelector('button');
    if (!tete) throw new Error('la délégation n’a pas de tête cliquable');
    await act(async () => {
      tete.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(tete.getAttribute('aria-expanded')).toBe('true');
    // Le corps est bien ouvert…
    expect(container.textContent).toContain('fais relire');
    // …et il ne porte aucune autre délégation : un seul bloc, pas de bloc dans
    // un bloc.
    expect(container.querySelectorAll('[data-delegation]')).toHaveLength(1);
    expect(container.textContent).not.toContain('Relecteur Bis');
    root.unmount();
    container.remove();
  });

  // Un chiffre qu'on ne connaît pas ne se dessine pas : ni « $0 », ni
  // « 0 tokens » (principe du tableau).
  it('une délégation qui court n’invente ni durée, ni jetons, ni coût', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'child',
              from: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
              job: {
                id: 'job-2',
                agentName: 'Le Relecteur',
                agentSlug: 'relecteur',
                agentAvatarUrl: null,
                status: 'running',
                task: 'Audite le correctif',
                result: null,
                error: null,
                failureHint: null,
                createdAt: new Date('2026-09-07T10:00:00Z'),
                completedAt: null,
              },
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    expect(html2).toContain('>Running<');
    expect(html2).not.toContain('$0');
    expect(html2).not.toContain('0 tokens');
    // Rien n'est encore arrivé : pas de point vert ni rouge.
    expect(html2).not.toMatch(/rounded-full bg-ok"/);
    expect(html2).not.toMatch(/rounded-full bg-err"/);
  });

  // #135 — un agent qui a téléversé une image se reconnaît à SON image, pas à
  // ses initiales. Le fil porte l'URL depuis `agents.avatar_url`, de bout en
  // bout : l'en-tête du tour, et les deux côtés d'une délégation.
  it('un agent qui a un avatar montre son image ; sans avatar, ses initiales', () => {
    const avecImage = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'turn',
              index: 1,
              turn: 1,
              turnSource: 'audit',
              agent: { name: 'Intendant', slug: 'intendant', avatarUrl: '/uploads/intendant.png' },
              model: null,
              at: null,
              usage: null,
              blocks: [{ kind: 'prose', text: 'Voilà.' }],
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    // next/image réécrit la source ; l'URL d'origine y reste, encodée.
    expect(avecImage).toContain('<img');
    expect(avecImage).toContain(encodeURIComponent('/uploads/intendant.png'));
    // L'image REMPLACE les initiales, elle ne s'ajoute pas à côté.
    expect(avecImage).not.toContain('>IN<');

    const sansImage = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'turn',
              index: 1,
              turn: 1,
              turnSource: 'audit',
              agent: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
              model: null,
              at: null,
              usage: null,
              blocks: [{ kind: 'prose', text: 'Voilà.' }],
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    expect(sansImage).not.toContain('<img');
    expect(sansImage).toContain('IN');
  });

  it('la tête d’une délégation montre les DEUX images : le délégant et le délégué', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'child',
              from: { name: 'Intendant', slug: 'intendant', avatarUrl: '/uploads/intendant.png' },
              job: {
                id: 'job-2',
                agentName: 'Le Relecteur',
                agentSlug: 'relecteur',
                agentAvatarUrl: '/uploads/relecteur.png',
                status: 'completed',
                task: 'relis',
                result: 'fait',
                error: null,
                failureHint: null,
                createdAt: null,
                completedAt: null,
              },
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    expect(html2).toContain(encodeURIComponent('/uploads/intendant.png'));
    expect(html2).toContain(encodeURIComponent('/uploads/relecteur.png'));
  });

  // #135 — la remontée des délégations ne doit RIEN emporter d'autre. Un tour
  // qui a livré garde sa carte d'envoi, à sa place, même quand le travail a
  // délégué : c'est ce que le propriétaire a cru perdre le 17/09.
  it('un tour qui a envoyé garde sa carte d’envoi, même avec des délégations remontées', () => {
    const enfant = (id: string, name: string) => ({
      id,
      agentName: name,
      agentSlug: name.toLowerCase(),
      agentAvatarUrl: null,
      status: 'completed',
      task: `tâche de ${name}`,
      result: 'fait',
      error: null,
      failureHint: null,
      createdAt: null,
      completedAt: null,
    });
    const feedAvecEnvoiEtEnfants: ConversationFeed = {
      items: [
        {
          kind: 'turn',
          index: 1,
          turn: 2,
          turnSource: 'audit',
          agent: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
          model: null,
          at: null,
          usage: null,
          blocks: [
            {
              kind: 'card',
              step: tool({
                toolName: 'dashboard_publish',
                card: 'sent',
                input: { text: 'La revue est prête.' },
                presented: { card: 'sent', channel: 'dashboard', kind: 'message', target: 'x' },
              }),
            },
          ],
        },
        {
          kind: 'child',
          from: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
          job: {
            ...enfant('job-2', 'Chef d’atelier'),
            feed: { items: [], totals: feed.totals },
          },
        },
        {
          kind: 'child',
          from: { name: 'Chef d’atelier', slug: 'chef-d-atelier', avatarUrl: null },
          job: enfant('job-3', 'Codeur Bis'),
        },
      ],
      totals: feed.totals,
    };
    const html2 = renderToStaticMarkup(<ConversationFeedView feed={feedAvecEnvoiEtEnfants} />);
    expect(html2).toContain('Sent to dashboard');
    // Et à sa place : AVANT les délégations, dans le tour qui a livré.
    expect(html2.indexOf('Sent to dashboard')).toBeLessThan(html2.indexOf('data-delegation'));
    expect(html2.match(/data-delegation/g)?.length ?? 0).toBe(2);
  });

  // Revue PR #141 — un délégué qui vient de démarrer a DÉJÀ des totaux, à zéro.
  // « 0 tokens » n'est pas une mesure, c'est l'absence de mesure.
  it('une délégation dont le délégué n’a encore rien consommé n’écrit pas « 0 tokens »', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={{
          items: [
            {
              kind: 'child',
              from: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
              job: {
                id: 'job-2',
                agentName: 'Le Relecteur',
                agentSlug: 'relecteur',
                agentAvatarUrl: null,
                status: 'running',
                task: 'relis le correctif',
                result: null,
                error: null,
                failureHint: null,
                createdAt: new Date('2026-09-07T10:00:00Z'),
                completedAt: null,
                // Le fil est ASSEMBLÉ : les totaux existent, tous à zéro.
                feed: {
                  items: [],
                  totals: {
                    ...feed.totals,
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedTokens: 0,
                    cacheCreationTokens: 0,
                    costUsd: null,
                  },
                },
              },
            },
          ],
          totals: feed.totals,
        }}
      />,
    );
    expect(html2).not.toContain('tokens');
    expect(html2).not.toContain('$0');
  });

  // Revue PR #141 — le pied tient sur une ligne, donc le verdict y tient sur
  // une ligne. Le reste du verdict n'est pas perdu pour autant : le corps
  // montre le résultat en ENTIER, juste au-dessus.
  it('un verdict de plusieurs lignes garde tout son texte dans le corps', async () => {
    const verdict = [
      '**Verdict global : APPROVE** — aucun constat bloquant ; 5 mineurs.',
      '',
      'Le détail qui suit la première ligne compte autant : GARDE-MOI.',
    ].join('\n');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ConversationFeedView
          feed={{
            items: [
              {
                kind: 'child',
                from: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
                job: {
                  id: 'job-2',
                  agentName: 'Le Relecteur',
                  agentSlug: 'relecteur',
                  agentAvatarUrl: null,
                  status: 'completed',
                  task: 'relis',
                  result: verdict,
                  error: null,
                  failureHint: null,
                  createdAt: null,
                  completedAt: null,
                },
              },
            ],
            totals: feed.totals,
          }}
        />,
      );
    });
    const tete = container.querySelector('button');
    if (!tete) throw new Error('la délégation n’a pas de tête cliquable');
    await act(async () => {
      tete.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Le pied dit le verdict, en une ligne, dans sa couleur. « Verdict global »
    // est une forme RÉELLE des résultats de revue, pas une invention du test.
    const pied = [...container.querySelectorAll('.text-feed-delegation')]
      .map((n) => n.textContent ?? '')
      .find((t) => t.includes('APPROVE'));
    expect(pied).toBe('APPROVE — aucun constat bloquant ; 5 mineurs.');
    // Et la suite du verdict est là, entière, dans le corps.
    expect(container.textContent).toContain('GARDE-MOI');
    root.unmount();
    container.remove();
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

// ─── Le travail sous sa ligne de résumé (#135, #132) ─────────────────────────
//
// Ce qui se prouve ici n'est pas la ligne (elle a son fichier) mais le FIL :
// un item `run` se dessine bien comme une ligne repliée, ses blocs ne sont pas
// dans la page tant qu'on n'a pas cliqué, et la densité de la personne décide
// de l'état de départ — pas une constante.

const runFeed = (): ConversationFeed => ({
  items: [
    {
      kind: 'turn',
      index: 1,
      turn: 1,
      turnSource: 'audit',
      agent: { name: 'Agent One', slug: 'agent-one', avatarUrl: null },
      model: 'a-model',
      at: null,
      blocks: [{ kind: 'prose', text: 'The report is written.' }],
      usage: null,
    },
    {
      kind: 'run',
      jobId: 'job-run',
      agent: { name: 'Agent One', slug: 'agent-one', avatarUrl: null },
      model: 'a-model',
      at: null,
      summary: { tools: 3, delegations: 1, modelCalls: 2, durationMs: 12_000, costUsd: 0.04 },
      items: [
        {
          kind: 'turn',
          index: 1,
          turn: 1,
          turnSource: 'audit',
          agent: { name: 'Agent One', slug: 'agent-one', avatarUrl: null },
          model: 'a-model',
          at: null,
          blocks: [
            { kind: 'steps', steps: [tool({ toolName: 'grep_le_dossier', input: { q: 'x' } })] },
          ],
          usage: null,
        },
      ],
    },
  ],
  totals: {
    turns: 1,
    toolCalls: 3,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.04,
    llmDurationMs: 0,
    models: [],
  },
});

describe('ConversationFeedView — le travail replié @cap:suivre-execution/ecran', () => {
  it('la réponse se lit sans déplier ; le travail du run n’est PAS dans la page', () => {
    const html = renderToStaticMarkup(<ConversationFeedView feed={runFeed()} />);
    expect(html).toContain('The report is written.');
    expect(html).toContain('3 tools · 1 delegation · 2 model calls');
    expect(html).toContain('Show the work');
    expect(html).not.toContain('grep_le_dossier');
  });

  it('un clic sur la ligne met le travail dans la page', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationFeedView feed={runFeed()} />);
    });
    expect(container.textContent).not.toContain('grep_le_dossier');
    const row = container.querySelector<HTMLButtonElement>('[data-testid="run-summary-job-run"]');
    if (!row) throw new Error('le fil n’a pas dessiné de ligne de résumé');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('grep_le_dossier');
  });

  it('la densité « unfolded » ouvre le travail dès le premier rendu', () => {
    const html = renderToStaticMarkup(<ConversationFeedView feed={runFeed()} density="unfolded" />);
    expect(html).toContain('grep_le_dossier');
    expect(html).toContain('Hide the work');
  });

  it('la densité « folded » le referme — le réglage décide, pas le composant', () => {
    const html = renderToStaticMarkup(<ConversationFeedView feed={runFeed()} density="folded" />);
    expect(html).not.toContain('grep_le_dossier');
  });
});

// ─── #174 — le verdict ENREGISTRÉ gagne sur la prose ─────────────────────────
//
// Le fil devinait le verdict d'une revue en lisant la première ligne du
// résultat du délégué. Depuis #170 l'outil `review_verdict` l'écrit typé,
// validé par son schéma : c'est lui qui doit s'afficher, et la prose n'est plus
// qu'un repli pour les délégués qui n'ont rien enregistré.
//
// Mutation vérifiée : `delegationVerdictLine` ramené à `delegationVerdict(job.result)`
// → « le verdict enregistré gagne » et « il porte ses constats » rougissent.

/** Une délégation, réduite à ce qui décide de la ligne de verdict. */
const delegation = (job: Partial<FeedChildJob>): ConversationFeed => ({
  items: [
    {
      kind: 'child',
      from: { name: 'Intendant', slug: 'intendant', avatarUrl: null },
      job: {
        id: 'job-verdict',
        agentName: 'Le Relecteur',
        agentSlug: 'relecteur',
        agentAvatarUrl: null,
        status: 'completed',
        task: 'Relis la PR',
        result: null,
        error: null,
        failureHint: null,
        createdAt: new Date('2026-09-18T10:00:00Z'),
        completedAt: new Date('2026-09-18T10:02:00Z'),
        ...job,
      },
    },
  ],
  totals: feed.totals,
});

describe('la ligne de verdict d’une délégation @cap:verifier-un-livrable/ecran', () => {
  it('écrit le verdict ENREGISTRÉ, pas la prose qui dit le contraire', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={delegation({
          // La prose ment — et c'est exactement le cas qui a fait l'issue.
          result: 'Verdict global : rien à signaler, tout est propre.',
          reviewVerdict: {
            verdict: 'request_changes',
            summary: 'Deux gardes manquent.',
            findings: [],
            counts: { blocker: 2, major: 0, minor: 1 },
          },
        })}
      />,
    );
    expect(html2).toContain('Changes requested');
    expect(html2).not.toContain('rien à signaler, tout est propre');
  });

  it('porte ses CONSTATS, et tait les gravités absentes', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={delegation({
          result: null,
          reviewVerdict: {
            verdict: 'request_changes',
            summary: '',
            findings: [],
            counts: { blocker: 2, major: 0, minor: 1 },
          },
        })}
      />,
    );
    expect(html2).toContain('2 blockers, 1 minor');
    // « 0 major » demanderait d'être lu pour apprendre qu'il n'y a rien.
    expect(html2).not.toContain('0 major');
  });

  it('écrit « Approved » tout court quand la revue n’a rien trouvé', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={delegation({
          result: null,
          reviewVerdict: {
            verdict: 'approve',
            summary: 'Rien à redire.',
            findings: [],
            counts: { blocker: 0, major: 0, minor: 0 },
          },
        })}
      />,
    );
    expect(html2).toContain('Approved');
    expect(html2).not.toMatch(/Approved[^<]*·/);
  });

  it('montre le RÉSUMÉ enregistré dans le corps, une fois la délégation ouverte', async () => {
    // DÉPLIÉE : replié, le corps n'est pas dans le DOM et le test ne prouverait
    // rien. La tête porte la conclusion, le corps porte ce qui la justifie.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ConversationFeedView
          feed={delegation({
            result: null,
            reviewVerdict: {
              verdict: 'request_changes',
              summary: 'Deux gardes manquent sur la reprise.',
              findings: [],
              counts: { blocker: 2, major: 0, minor: 0 },
            },
          })}
        />,
      );
    });
    // La conclusion se lit AVANT d'ouvrir.
    expect(container.textContent).toContain('Changes requested · 2 blockers');
    expect(container.textContent).not.toContain('Deux gardes manquent');

    const tete = container.querySelector('button');
    if (!tete) throw new Error('la délégation n’a pas de tête cliquable');
    await act(async () => {
      tete.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Deux gardes manquent sur la reprise.');
    root.unmount();
    container.remove();
  });

  it('retombe sur la PROSE quand rien n’a été enregistré', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={delegation({
          result: 'Verdict final — la reprise tient, une note mineure.',
          reviewVerdict: null,
        })}
      />,
    );
    expect(html2).toContain('la reprise tient, une note mineure.');
    expect(html2).not.toContain('Changes requested');
    expect(html2).not.toContain('Approved');
  });

  it('retombe sur la prose aussi quand le champ est ABSENT — un fil d’avant #170', () => {
    const html2 = renderToStaticMarkup(
      <ConversationFeedView feed={delegation({ result: 'Verdict : approuvé.' })} />,
    );
    expect(html2).toContain('approuvé.');
  });

  it('ne dessine AUCUNE ligne quand il n’y a ni verdict ni prose de verdict', () => {
    // « Verdict émis. Je clos la tâche. » — une vraie ligne de la base — n'est
    // pas un verdict : inventer en ferait dire au délégué ce qu'il n'a pas dit.
    const html2 = renderToStaticMarkup(
      <ConversationFeedView
        feed={delegation({ result: 'Verdict émis. Je clos la tâche.', reviewVerdict: null })}
      />,
    );
    expect(html2).not.toContain('text-feed-delegation">Verdict émis');
  });
});

describe('delegationVerdictLine, la règle seule @cap:verifier-un-livrable/moteur', () => {
  it('préfère l’enregistré, quoi que dise le résultat', () => {
    expect(
      delegationVerdictLine({
        result: 'Verdict : approuvé',
        reviewVerdict: {
          verdict: 'request_changes',
          summary: '',
          findings: [],
          counts: { blocker: 1, major: 0, minor: 0 },
        },
      }),
    ).toBe('Changes requested · 1 blocker');
  });

  it('accorde le pluriel des constats', () => {
    expect(
      delegationVerdictLine({
        result: null,
        reviewVerdict: {
          verdict: 'request_changes',
          summary: '',
          findings: [],
          counts: { blocker: 1, major: 2, minor: 3 },
        },
      }),
    ).toBe('Changes requested · 1 blocker, 2 majors, 3 minors');
  });

  it('garde la règle de prose À LA LETTRE en repli', () => {
    // Les formes relevées en base le 17/09, celles que #141 a ouvertes.
    expect(delegationVerdictLine({ result: 'Verdict global : ça passe' })).toBe('ça passe');
    expect(delegationVerdictLine({ result: 'Verdict final — ça passe' })).toBe('ça passe');
    // Le trait d'union n'est PAS un séparateur, et une phrase quelconque non plus.
    expect(delegationVerdictLine({ result: 'Verdict - ça passe' })).toBeNull();
    expect(delegationVerdictLine({ result: 'Verdict émis. Je clos la tâche.' })).toBeNull();
    expect(delegationVerdictLine({ result: null })).toBeNull();
  });

  it('ne lit PAS le verdict posé sur la ligne suivante — constat, pas promesse', () => {
    // `plainText` ne rend que la PREMIÈRE ligne lisible d'un markdown : la
    // branche « le mot seul, le verdict en dessous » de `delegationVerdict` ne
    // peut donc jamais se déclencher. Le test l'écrit tel quel plutôt que de
    // laisser croire le contraire ; le corriger changerait ce que le fil
    // affiche pour toute une famille de résultats, ce qui n'est pas le sujet
    // de #174 (voir le commentaire de `delegationVerdict`).
    expect(delegationVerdictLine({ result: 'Verdict\nça passe' })).toBeNull();
    expect(delegationVerdictLine({ result: '## Verdict\n\nça passe' })).toBeNull();
  });
});

// ─── Le geste sous un échec (#184) ───────────────────────────────────────────
//
// Le harnais NOMME le geste en champ typé et se tait ; la phrase est celle de
// l'écran. Ce qui se prouve ici : elle paraît quand un geste est nommé, et
// l'écran reste muet sinon — jamais un conseil posé sur un échec ordinaire.

const feedEnEchec = (hint: 'switch_model' | null, text = PROVIDER_REJECTED): ConversationFeed => ({
  items: [
    {
      kind: 'request',
      text: 'Résume la veille',
      origin: { channel: 'dashboard', scheduleName: null, chatId: null },
      at: null,
    },
    { kind: 'failure', text, hint },
  ],
  totals: { toolCalls: 0, costUsd: null, durationMs: 0 } as never,
});

describe('ConversationFeedView — le geste qu’un échec appelle @cap:suivre-execution/ecran', () => {
  it('un geste nommé se dit en une phrase, sous l’échec', () => {
    const html = renderToStaticMarkup(<ConversationFeedView feed={feedEnEchec('switch_model')} />);
    expect(html).toContain('Failed');
    expect(html).toContain('Try another model for this agent');
  });

  it('aucun geste, aucune phrase — l’échec reste seul', () => {
    const html = renderToStaticMarkup(
      <ConversationFeedView feed={feedEnEchec(null, 'delivery_spam_guard')} />,
    );
    expect(html).toContain('delivery_spam_guard');
    expect(html).not.toContain('Try another model');
  });

  it('l’échec d’un DÉLÉGUÉ porte le même geste, dans le bloc de la délégation', async () => {
    const refus = `${PROVIDER_REJECTED_PREFIX}openrouter/google/gemini-3.7-flash (http 400, turn 3)`;
    const feedAvecEnfant: ConversationFeed = {
      items: [
        {
          kind: 'child',
          job: {
            id: 'child-1',
            agentName: 'Analyste',
            agentSlug: 'analyste',
            agentAvatarUrl: null,
            status: 'failed',
            task: 'compare les deux rapports',
            result: null,
            error: refus,
            // Le mot du runner, LU sur la ligne du délégué (#193) — il n'est
            // plus déduit du code d'erreur, qui reste là pour le diagnostic.
            failureHint: 'switch_model',
            createdAt: null,
            completedAt: null,
          },
          from: { name: 'Veilleur', slug: 'veilleur', avatarUrl: null },
        },
      ],
      totals: { toolCalls: 0, costUsd: null, durationMs: 0 } as never,
    };
    // Le corps d'une délégation n'est dans le DOM que DÉPLIÉ : il faut donc un
    // vrai rendu et un vrai clic, pas un rendu statique.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationFeedView feed={feedAvecEnfant} />);
    });
    expect(container.textContent).not.toContain('Try another model');

    const tete = container.querySelector<HTMLButtonElement>('[data-delegation] button');
    if (!tete) throw new Error('la délégation n’a pas dessiné sa tête');
    await act(async () => {
      tete.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain(refus);
    expect(container.textContent).toContain('Try another model for this agent');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('un délégué SANS geste écrit reste muet, même si son code dit le refus (#193)', async () => {
    // La garde de la bascule, côté écran. Tant que le bloc DÉDUISAIT le geste
    // du code d'erreur, ce cas affichait la phrase. Il ne doit plus : le seul
    // auteur du geste est le runner, et ici il n'en a écrit aucun.
    const refus = `${PROVIDER_REJECTED_PREFIX}openrouter/google/gemini-3.7-flash (http 400, turn 3)`;
    const feedAvecEnfant: ConversationFeed = {
      items: [
        {
          kind: 'child',
          job: {
            id: 'child-2',
            agentName: 'Analyste',
            agentSlug: 'analyste',
            agentAvatarUrl: null,
            status: 'failed',
            task: 'compare les deux rapports',
            result: null,
            error: refus,
            failureHint: null,
            createdAt: null,
            completedAt: null,
          },
          from: { name: 'Veilleur', slug: 'veilleur', avatarUrl: null },
        },
      ],
      totals: { toolCalls: 0, costUsd: null, durationMs: 0 } as never,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationFeedView feed={feedAvecEnfant} />);
    });
    const tete = container.querySelector<HTMLButtonElement>('[data-delegation] button');
    if (!tete) throw new Error('la délégation n’a pas dessiné sa tête');
    await act(async () => {
      tete.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Déplié, le code est là — donc le bloc est bien ouvert, et le silence
    // qu'on mesure est celui du geste, pas celui d'un corps resté fermé.
    expect(container.textContent).toContain(refus);
    expect(container.textContent).not.toContain('Try another model');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
