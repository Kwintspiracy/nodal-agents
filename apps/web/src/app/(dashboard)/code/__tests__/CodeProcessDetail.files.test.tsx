// CodeProcessDetail.files.test.tsx — la section « Files » de la page d'un run,
// redessinée aux codes du fil (planche #135).
//
// Rendu dans un vrai DOM (jsdom) et lu comme on le lit à l'écran : le titre et
// son compte, le chemin de chaque fichier, ses compteurs, et le contenu de la
// plaque — la ligne remplacée ET la ligne écrite. Le côte à côte d'avant
// coupait toute ligne réelle au bord de sa demi-colonne ; ce qui compte ici
// est donc le TEXTE rendu, pas la présence d'un bouton.
//
// La borne est vérifiée sur un vrai dépassement : quatre-vingts lignes
// paraissent, le reste se dit en une phrase. Un diff sans fin est le seul
// moyen sûr de figer cet écran.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodingProcessDetail } from '@/lib/actions.ts';
import CodeProcessDetail from '../[id]/CodeProcessDetail.tsx';
import {
  PLATE_LINE_LIMIT,
  budgetedLines,
  buildPlateRows,
  hiddenNote,
} from '../[id]/FileChangeBlock.tsx';

const getCodingProcessDetailAction = vi.hoisted(() =>
  vi.fn(async () => ({ ok: false as const, code: 'unused', message: 'unused' })),
);
const listApprovalsAction = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, data: [] as never[] })),
);

vi.mock('@/lib/actions.ts', () => ({
  getCodingProcessDetailAction,
  listApprovalsAction,
  // Importées par ApprovalActions, que ce module charge.
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

const JOB_ID = '11111111-1111-4111-8111-111111111111';

/** Un fichier écrit en trop long : de quoi dépasser la borne de la plaque. */
const LONG_LINES = Array.from({ length: PLATE_LINE_LIMIT + 20 }, (_, i) => `line ${i + 1}`);

const detail = (): CodingProcessDetail => ({
  header: {
    id: JOB_ID,
    kind: 'job',
    agentId: null,
    agentName: 'Test agent',
    origin: 'api',
    status: 'completed',
    stage: 'done',
    task: 'Redessiner la section des fichiers',
    costUsd: 0.12,
    providers: ['claude'],
    filesChanged: 2,
    activityAt: '2026-09-18T10:00:00.000Z',
    projectPath: null,
    projectName: null,
    sessionType: 'coding',
    durationMs: 4200,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
  },
  activity: [],
  verdicts: [],
  changes: [
    {
      filePath: 'apps/web/src/app/page.tsx',
      addedLines: 1,
      removedLines: 1,
      edits: [
        {
          filePath: 'apps/web/src/app/page.tsx',
          kind: 'edit',
          oldText: 'const answer = 41;',
          newText: 'const answer = 42;',
        },
      ],
    },
    {
      filePath: 'apps/web/src/lib/long.ts',
      addedLines: LONG_LINES.length,
      removedLines: 0,
      edits: [
        {
          filePath: 'apps/web/src/lib/long.ts',
          kind: 'write',
          oldText: null,
          newText: LONG_LINES.join('\n'),
        },
      ],
    },
  ],
  pipelineJobIds: [JOB_ID],
  verificationRuns: [],
  verificationSkippedSurfaces: [],
  verificationUnconfigured: [],
});

let container: HTMLDivElement;
let root: Root;

async function render(initial: CodingProcessDetail): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CodeProcessDetail query={{ jobId: JOB_ID }} initialDetail={initial} />);
  });
}

beforeEach(() => {
  getCodingProcessDetailAction.mockClear();
  listApprovalsAction.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('CodeProcessDetail — la section Files @cap:suivre-execution/ecran', () => {
  it('nomme chaque fichier, son geste et son churn', async () => {
    await render(detail());
    const text = container.textContent ?? '';

    // Le titre porte le compte. Les majuscules sont faites par la CSS
    // (`uppercase`), pas écrites dans le texte : c'est « Files · 2 » qui est
    // dans le DOM, « FILES · 2 » qui s'affiche.
    expect(text).toContain('Files · 2');
    const titre = Array.from(container.querySelectorAll('h2')).find((h) =>
      (h.textContent ?? '').startsWith('Files'),
    );
    expect(titre?.className).toContain('uppercase');

    // Chaque ligne de fichier porte son geste, son chemin et son churn — lus
    // sur LA ligne, pas quelque part dans la page.
    const lignes = Array.from(container.querySelectorAll('button[aria-expanded]'))
      .map((b) => b.textContent ?? '')
      .filter((t) => t.includes('.tsx') || t.includes('.ts'));
    expect(lignes).toEqual([
      'file_editapps/web/src/app/page.tsx+1 −1',
      `file_writeapps/web/src/lib/long.ts+${LONG_LINES.length}`,
    ]);
    // Un zéro se tait : le second fichier n'a rien remplacé.
    expect(text).not.toContain('−0');
  });

  it('montre la ligne remplacée ET la ligne écrite, chacune de son côté', async () => {
    await render(detail());
    const text = container.textContent ?? '';

    expect(text).toContain('const answer = 41;');
    expect(text).toContain('const answer = 42;');

    const retirees = Array.from(container.querySelectorAll('[data-diff="-"]'));
    const ajoutees = Array.from(container.querySelectorAll('[data-diff="+"]'));
    expect(retirees.map((el) => el.textContent)).toContain('1-const answer = 41;');
    expect(ajoutees.map((el) => el.textContent)).toContain('1+const answer = 42;');
    // Le fond dit ce que le signe dit : écrit sur `ok`, remplacé sur `warn`.
    expect(retirees[0]?.className).toContain('bg-warn-bg');
    expect(ajoutees[0]?.className).toContain('bg-ok-bg');
  });

  it('s’arrête à la borne et dit combien de lignes restent', async () => {
    await render(detail());
    const text = container.textContent ?? '';

    expect(text).toContain(`… and ${LONG_LINES.length - PLATE_LINE_LIMIT} more lines`);
    // La borne porte sur le fichier qui déborde, pas sur la page : le premier
    // fichier garde ses deux lignes, et rien n'est rendu au-delà de la borne.
    expect(text).toContain(`line ${PLATE_LINE_LIMIT}`);
    expect(text).not.toContain(`line ${PLATE_LINE_LIMIT + 1}`);
    expect(container.querySelectorAll('[data-diff]')).toHaveLength(PLATE_LINE_LIMIT + 2);
  });

  it('sans fichier changé, le dit', async () => {
    const empty = detail();
    empty.changes = [];
    empty.header.filesChanged = 0;
    await render(empty);

    expect(container.textContent).toContain('No files changed yet.');
    expect(container.querySelectorAll('[data-diff]')).toHaveLength(0);
  });
});

describe('buildPlateRows — la borne tient AVANT le diff @cap:suivre-execution/ecran', () => {
  // Reviewer C, #164 : la borne s'appliquait après coup. Une écriture énorme
  // était comparée en entier — `fragmentDiff` rend au-delà de sa propre borne
  // l'ancien puis le nouveau ligne à ligne — pour n'en dessiner que 80. Ce que
  // ce test regarde est donc ce qui a été CONSTRUIT, pas un temps d'exécution.
  const ENORME = Array.from({ length: 20_000 }, (_, i) => `ligne ${i + 1}`).join('\n');

  it('ne découpe que ce que la plaque peut dessiner, et compte quand même le reste', () => {
    const { lines, total } = budgetedLines(ENORME, PLATE_LINE_LIMIT);
    expect(lines).toHaveLength(PLATE_LINE_LIMIT);
    expect(lines[0]).toBe('ligne 1');
    expect(lines[PLATE_LINE_LIMIT - 1]).toBe(`ligne ${PLATE_LINE_LIMIT}`);
    expect(total).toBe(20_000);
  });

  it('une écriture de vingt mille lignes ne construit que la borne, et le dit', () => {
    const { rows, hiddenOld, hiddenNew } = buildPlateRows(
      [{ filePath: 'src/enorme.ts', kind: 'write', oldText: null, newText: ENORME }],
      PLATE_LINE_LIMIT,
    );
    expect(rows.filter((r) => r.kind === 'line')).toHaveLength(PLATE_LINE_LIMIT);
    expect(hiddenOld).toBe(0);
    expect(hiddenNew).toBe(20_000 - PLATE_LINE_LIMIT);
    expect(hiddenNote(hiddenOld, hiddenNew)).toBe(`… and ${20_000 - PLATE_LINE_LIMIT} more lines`);
  });

  it('un texte plus court que la borne passe entier, et ne cache rien', () => {
    const { lines, total } = budgetedLines('a\nb\nc', PLATE_LINE_LIMIT);
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(total).toBe(3);
    const { rows, hiddenOld, hiddenNew } = buildPlateRows(
      [{ filePath: 'src/court.ts', kind: 'edit', oldText: 'a\nb', newText: 'a\nc' }],
      PLATE_LINE_LIMIT,
    );
    expect(rows.filter((r) => r.kind === 'line')).toHaveLength(3);
    expect(hiddenNote(hiddenOld, hiddenNew)).toBeNull();
  });

  // Reviewer C, passe 2 : additionner les deux restes annonçait un nombre que
  // rien à l'écran ne représente. Une réécriture complète le montre — 80
  // rangées dessinées, deux restes qui ne s'additionnent pas.
  it('une réécriture complète compte SÉPARÉMENT l’ancien et le nouveau', () => {
    const avant = Array.from({ length: 200 }, (_, i) => `avant ${i + 1}`).join('\n');
    const apres = Array.from({ length: 200 }, (_, i) => `après ${i + 1}`).join('\n');
    const { rows, hiddenOld, hiddenNew } = buildPlateRows(
      [{ filePath: 'src/reecrit.ts', kind: 'edit', oldText: avant, newText: apres }],
      PLATE_LINE_LIMIT,
    );

    expect(rows.filter((r) => r.kind === 'line')).toHaveLength(PLATE_LINE_LIMIT);
    expect(hiddenOld).toBe(200 - PLATE_LINE_LIMIT);
    expect(hiddenNew).toBe(200);
    expect(hiddenNote(hiddenOld, hiddenNew)).toBe(
      `… ${200 - PLATE_LINE_LIMIT} old, 200 new lines not shown`,
    );
    // Et surtout : jamais la somme, qui se lirait comme des rangées de plus.
    expect(hiddenNote(hiddenOld, hiddenNew)).not.toContain(String(400 - PLATE_LINE_LIMIT));
  });
});
