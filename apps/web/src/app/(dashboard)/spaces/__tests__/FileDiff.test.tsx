// FileDiff.test.tsx — la carte « N fichiers » devient cliquable (P11).
//
// Rendu dans jsdom et CLIQUÉ. Ce qui compte n'est pas qu'un bouton existe :
// c'est que le clic demande le diff du BON fichier, que rien ne soit demandé
// avant ce clic, et que chaque état sans diff se dise en toutes lettres plutôt
// que de laisser un panneau vide passer pour « aucun changement ».

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import FileDiff, { DiffBody, gitDiffLines } from '../FileDiff.tsx';
import ConversationFeedView from '../ConversationFeedView.tsx';
import type { ConversationFeed, Step } from '@/lib/conversation-feed.ts';

const getFileDiffAction = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    data: {
      kind: 'diff' as const,
      text: 'diff --git a/code.txt b/code.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n',
      truncated: false,
      path: 'code.txt',
      from: 'sha1',
      to: 'working_tree',
    },
  })),
);

vi.mock('@/lib/file-diff-actions.ts', () => ({ getFileDiffAction }));

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  getFileDiffAction.mockClear();
});

// ─── Le fil : quels fichiers ont un bouton ───────────────────────────────────

const toolStep = (
  over: Partial<Extract<Step, { kind: 'tool' }>>,
): Extract<Step, { kind: 'tool' }> => ({
  kind: 'tool',
  toolName: 'file_write',
  toolCallId: 'call-1',
  jobId: '11111111-1111-4111-8111-111111111111',
  card: 'files',
  presented: null,
  input: {},
  outputText: null,
  outcome: 'success',
  durationMs: 12,
  question: null,
  ...over,
});

const feedWith = (files: Array<{ path: string; action: string }>): ConversationFeed => ({
  items: [
    {
      kind: 'turn',
      index: 1,
      turn: 1,
      turnSource: 'audit',
      agent: { name: 'Alfred', slug: 'alfred' },
      model: 'mock',
      usage: null,
      blocks: [
        {
          kind: 'card',
          step: toolStep({
            presented: {
              card: 'files',
              files: files as never,
              total: files.length,
              truncated: false,
            } as never,
          }),
        },
      ],
    },
  ],
  totals: { toolCalls: 1, costUsd: null, durationMs: 12 } as never,
});

describe('FilesCard — qui se déplie', () => {
  it('un fichier ÉCRIT porte un bouton de dépliage, un fichier LU n’en a pas', () => {
    const html = renderToStaticMarkup(
      <ConversationFeedView
        feed={feedWith([
          { path: 'src/code.ts', action: 'written' },
          { path: 'README.md', action: 'listed' },
        ])}
      />,
    );
    const boutons = html.match(/aria-expanded="false"/g) ?? [];
    expect(boutons, 'un seul fichier est dépliable : celui qui a été écrit').toHaveLength(1);
    expect(html).toContain('src/code.ts');
    expect(html).toContain('README.md');
  });

  it('sans identifiant d’appel, aucun bouton — il n’y a rien à demander', () => {
    const feed = feedWith([{ path: 'src/code.ts', action: 'written' }]);
    const block = feed.items[0] as { blocks: Array<{ step: { toolCallId: string | null } }> };
    block.blocks[0]!.step.toolCallId = null;
    const html = renderToStaticMarkup(<ConversationFeedView feed={feed} />);
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('src/code.ts');
  });
});

// ─── Le panneau ──────────────────────────────────────────────────────────────

describe('FileDiff — le chargement est PARESSEUX', () => {
  it('ne demande rien au rendu, demande le bon fichier au clic', async () => {
    await render(
      <FileDiff
        jobId="11111111-1111-4111-8111-111111111111"
        toolCallId="call-9"
        path="src/code.ts"
        action="written"
      />,
    );
    expect(getFileDiffAction.mock.calls, 'un diff a été demandé sans clic').toEqual([]);

    const bouton = container.querySelector('button');
    expect(bouton?.getAttribute('aria-expanded')).toBe('false');
    await click(bouton!);

    expect(getFileDiffAction.mock.calls).toEqual([
      [
        {
          jobId: '11111111-1111-4111-8111-111111111111',
          toolCallId: 'call-9',
          path: 'src/code.ts',
        },
      ],
    ]);
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    // Le texte rendu vient du diff, ligne par ligne.
    expect(container.textContent).toContain('-beta');
    expect(container.textContent).toContain('+BETA');
    expect(container.querySelector('[data-diff="+"]')?.className).toContain('text-ok');
    expect(container.querySelector('[data-diff="-"]')?.className).toContain('text-err');
  });

  it('rouvrir ne redemande pas le diff', async () => {
    await render(
      <FileDiff
        jobId="11111111-1111-4111-8111-111111111111"
        toolCallId="c"
        path="a"
        action="written"
      />,
    );
    const bouton = container.querySelector('button')!;
    await click(bouton);
    await click(bouton);
    await click(bouton);
    expect(getFileDiffAction.mock.calls).toHaveLength(1);
  });
});

describe('gitDiffLines', () => {
  it('retire les en-têtes et garde les bornes de morceau', () => {
    const lines = gitDiffLines(
      'diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-un\n+deux\n contexte\n',
    );
    expect(lines).toEqual([
      { kind: '@', text: '@@ -1 +1 @@' },
      { kind: '-', text: 'un' },
      { kind: '+', text: 'deux' },
      { kind: ' ', text: 'contexte' },
      { kind: ' ', text: '' },
    ]);
  });
});

describe('DiffBody — chaque état se DIT', () => {
  it('un fragment se diffuse sans git', () => {
    const html = renderToStaticMarkup(
      <DiffBody
        view={{ kind: 'fragment', oldString: 'un\ndeux', newString: 'un\nDEUX', path: 'a.md' }}
      />,
    );
    expect(html).toContain('-deux');
    expect(html).toContain('+DEUX');
  });

  it('un diff borné annonce sa coupe', () => {
    const html = renderToStaticMarkup(
      <DiffBody
        view={{
          kind: 'diff',
          text: '@@ -1 +1 @@\n+x\n',
          truncated: true,
          path: 'a',
          from: 's',
          to: 'working_tree',
        }}
      />,
    );
    expect(html).toContain('truncated');
  });

  it('les états sans diff portent chacun leur phrase', () => {
    const phrase = (view: Parameters<typeof DiffBody>[0]['view']): string =>
      renderToStaticMarkup(<DiffBody view={view} />);

    expect(phrase({ kind: 'unchanged', path: 'a' })).toContain('No change');
    expect(phrase({ kind: 'binary', path: 'a' })).toContain('Binary file');
    expect(phrase({ kind: 'unavailable', reason: 'no_checkpoint' })).toContain(
      'written before snapshots were kept',
    );
    expect(phrase({ kind: 'unavailable', reason: 'not_in_snapshot' })).toContain(
      'ignored by the folder',
    );
    expect(phrase({ kind: 'unavailable', reason: 'workspace_unreachable' })).toContain(
      'folder no longer reachable',
    );
    expect(phrase({ kind: 'unavailable', reason: 'path_unresolved' })).toContain(
      'could not be located',
    );
  });
});
