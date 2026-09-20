// feed-dots-server-boundary.test.tsx — les pastilles du fil gardent leur
// couleur quand les modules client sont vus COMME LE SERVEUR LES VOIT (#240).
//
// Pourquoi ce fichier existe. `ConversationFeedView` est rendu côté serveur, et
// il lisait `DOT[outcome]` et `FILE_DOT[f.action]` dans deux modules portant
// `'use client'`. Les tests du fil rendaient pourtant `bg-ok` en vert
// (`ConversationFeedView.test.tsx:578`) : ils importent les vrais modules, donc
// les vraies valeurs. Un écran vert devant un moteur débranché — le serveur, en
// production, ne voyait pas ces tables.
//
// Ce qu'il reproduit. Le chargeur de Next remplace un module `'use client'`, vu
// du graphe serveur, par UNE RÉFÉRENCE PAR EXPORT :
// `next/dist/build/webpack/loaders/next-flight-loader/index.js`, branche
// `assumedSourceType === 'module'`, qui écrit
// `export const DOT = registerClientReference(function () { throw … }, clé,
// "DOT")`. Le premier cas ci-dessous fait tourner ce VRAI
// `registerClientReference` dans un node lancé avec la condition
// `react-server` (la seule façon de charger le paquet), et constate ce qu'il
// rend. Les suivants rendent le fil avec les deux constantes remplacées par une
// référence de même forme.
//
// Ce qu'il ne reproduit PAS, et pourquoi. Seules les CONSTANTES sont remplacées,
// pas les composants exportés par les mêmes modules. Un serveur qui rend un
// composant client est dans son droit — c'est le seul usage autorisé — et
// `renderToStaticMarkup` ne sait de toute façon pas rendre une référence : ce
// n'est pas le rendu qui était en cause, c'est la LECTURE.

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationFeed, Step } from '@/lib/conversation-feed.ts';

const ICI = dirname(fileURLToPath(import.meta.url));
/** `apps/web` : c'est de là que `next` se résout. */
const APP_WEB = join(ICI, '..', '..', '..', '..', '..');

/**
 * Ce que le serveur reçoit à la place d'un export de module client. Réplique de
 * `registerClientReferenceImpl` — trois propriétés posées sur une fonction qui
 * jette. Le premier cas du fichier la confronte au vrai.
 */
function referenceClient(id: string, exportName: string): Readonly<Record<string, string>> {
  const jette = function (): never {
    throw new Error(
      `Attempted to call ${exportName}() from the server but ${exportName} is on the client.`,
    );
  };
  return Object.defineProperties(jette, {
    $$typeof: { value: Symbol.for('react.client.reference') },
    $$id: { value: `${id}#${exportName}` },
    $$async: { value: false },
  }) as unknown as Readonly<Record<string, string>>;
}

// Les deux modules client, vus du serveur : leurs COMPOSANTS restent les vrais
// (le serveur sait les rendre), leurs CONSTANTES deviennent des références.
vi.mock('../ToolBlock.tsx', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../ToolBlock.tsx')),
  DOT: referenceClient('ToolBlock.tsx', 'DOT'),
}));
vi.mock('../FileDiff.tsx', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../FileDiff.tsx')),
  FILE_DOT: referenceClient('FileDiff.tsx', 'FILE_DOT'),
}));

const { default: ConversationFeedView } = await import('../ConversationFeedView.tsx');

const outil = (
  over: Partial<Extract<Step, { kind: 'tool' }>>,
): Extract<Step, { kind: 'tool' }> => ({
  kind: 'tool',
  toolName: 'x',
  toolCallId: 'call-1',
  jobId: '11111111-1111-4111-8111-111111111111',
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

const filAvec = (step: Extract<Step, { kind: 'tool' }>): ConversationFeed =>
  ({
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
        blocks: [{ kind: 'card', step }],
      },
    ],
    totals: { turns: 1, toolCalls: 1, costUsd: null, durationMs: 10 },
  }) as unknown as ConversationFeed;

describe('la frontière serveur / client, telle que React la fait', () => {
  it('une constante d’un module client, lue par le serveur, rend `undefined` — sans jeter', () => {
    const script = [
      "const { registerClientReference } = require('next/dist/compiled/react-server-dom-webpack/server.edge.js');",
      "const ref = registerClientReference(function () { throw new Error('appel'); }, 'ToolBlock.tsx', 'DOT');",
      'process.stdout.write(JSON.stringify({',
      "  type: typeof ref, lu: ref['success'] === undefined ? 'undefined' : String(ref['success']),",
      "  repli: ref['success'] ?? 'bg-ink-4', tag: String(ref['$$typeof']), id: ref['$$id'],",
      '}));',
    ].join('\n');
    const sortie = execFileSync(process.execPath, ['--conditions=react-server', '-e', script], {
      cwd: APP_WEB,
      encoding: 'utf8',
    });
    const vrai = JSON.parse(sortie) as Record<string, string>;

    // Le fait qui tranche #240 : la lecture ne jette pas, elle rend `undefined`.
    // Un `?? 'bg-ink-4'` derrière, et la pastille devient grise en silence.
    expect(vrai.lu).toBe('undefined');
    expect(vrai.repli).toBe('bg-ink-4');
    expect(vrai.type).toBe('function');
    expect(vrai.tag).toBe('Symbol(react.client.reference)');
    expect(vrai.id).toBe('ToolBlock.tsx#DOT');

    // Et la réplique de ce fichier rend les mêmes faits que le vrai React.
    const replique = referenceClient('ToolBlock.tsx', 'DOT') as unknown as Record<string, unknown>;
    expect(typeof replique).toBe(vrai.type);
    expect(replique.success).toBeUndefined();
    expect(String(replique.$$typeof)).toBe(vrai.tag);
    expect(replique.$$id).toBe(vrai.id);
  });
});

describe('le fil vu du serveur @cap:suivre-execution/ecran', () => {
  it('la pastille d’une carte d’envoi garde la couleur de son issue', () => {
    const html = renderToStaticMarkup(
      <ConversationFeedView
        feed={filAvec(
          outil({
            toolName: 'telegram_send_message',
            card: 'sent',
            input: { text: 'La revue est prête.' },
            presented: {
              card: 'sent',
              channel: 'telegram',
              kind: 'message',
              target: '42',
            } as never,
          }),
        )}
      />,
    );
    expect(html, 'un envoi réussi porte une pastille VERTE, pas le repli gris').toMatch(
      /h-2 w-2 shrink-0 rounded-full bg-ok"/,
    );
  });

  it('un échec d’envoi garde sa pastille rouge', () => {
    const html = renderToStaticMarkup(
      <ConversationFeedView
        feed={filAvec(
          outil({
            toolName: 'telegram_send_message',
            card: 'sent',
            outcome: 'error',
            presented: {
              card: 'sent',
              channel: 'telegram',
              kind: 'message',
              target: '42',
            } as never,
          }),
        )}
      />,
    );
    expect(html).toMatch(/h-2 w-2 shrink-0 rounded-full bg-err"/);
  });

  it('la pastille d’un fichier CRÉÉ sans identifiant d’appel reste verte', () => {
    // Pourquoi cette carte-là. `FILE_DOT` n'est lu par le fil que sur la ligne
    // SANS chevron ; un fichier écrit passe sinon par `FileDiff`, qui est un
    // module client et lit sa table côté client. Deux chemins y mènent : un
    // fichier `listed`, et n'importe quel fichier d'un appel sans
    // `toolCallId` — les lignes d'audit anciennes n'en ont pas. Le second est
    // le seul qui se VOIE : `FILE_DOT.listed` vaut `bg-ink-4`, exactement le
    // repli, donc la lecture cassée d'un fichier lu rendait la bonne couleur
    // par coïncidence. C'est ce hasard qui a gardé le défaut invisible.
    const html = renderToStaticMarkup(
      <ConversationFeedView
        feed={filAvec(
          outil({
            toolName: 'file_write',
            card: 'files',
            toolCallId: null,
            presented: {
              card: 'files',
              files: [
                { path: 'src/neuf.ts', action: 'created' },
                { path: 'README.md', action: 'listed' },
              ],
              total: 2,
              truncated: false,
            } as never,
          }),
        )}
      />,
    );
    expect(html, 'un fichier créé porte une pastille VERTE').toMatch(
      /h-1\.5 w-1\.5 shrink-0 rounded-full bg-ok"/,
    );
    expect(html, 'un fichier seulement lu reste gris').toMatch(
      /h-1\.5 w-1\.5 shrink-0 rounded-full bg-ink-4"/,
    );
  });
});
