// ProofRepairSection.test.tsx — LE RÉGLAGE SOUS LES YEUX (#377).
//
// @cap:verifier-un-livrable/ecran
//
// Le moteur est prouvé ailleurs : la borne elle-même dans
// `apps/runner/src/tests/job/repair-turn.test.ts` (0 ne rejoue rien, 2 rejoue
// deux fois), la ligne de la liste et l'écriture en base dans
// `settings-rows.test.ts`. Ce qui se prouve ICI est l'autre moitié : le
// réglage EXISTE à l'écran, il dit sa valeur, le geste part vers l'action, et
// les trois budgets anti-boucle s'affichent avec les nombres qu'on lui donne.
//
// CE QU'IL PROUVE :
//   1. la valeur courante est celle qui est active dans le contrôle ;
//   2. la phrase sous le titre CHANGE avec la valeur — « 0 » ne se lit pas
//      comme « 1 », et un chiffre nu ne dirait rien à personne ;
//   3. cliquer un segment appelle l'action avec ce nombre ;
//   4. un refus de l'action REMET la valeur d'avant — l'écran ne garde pas
//      une valeur que la base n'a pas prise ;
//   5. les trois budgets sont rendus avec les nombres reçus, pas des nombres
//      écrits dans l'écran ;
//   6. un non-propriétaire voit le réglage et ne peut pas y toucher.
//
// Mutations vérifiées :
//   - le `setAttempts(avant)` du chemin d'erreur retiré → le point 4 rougit ;
//   - `phrase()` qui rend toujours le même texte → le point 2 rougit ;
//   - les valeurs des budgets remplacées par des constantes → le point 5
//     rougit.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock('@/lib/actions.ts', () => ({
  setProofRepairAction: vi.fn(),
}));

import ProofRepairSection from '../ProofRepairSection.tsx';
import { setProofRepairAction, type ProofRepairView } from '@/lib/actions.ts';

const BUDGETS = { resumesPerRun: 15, toolCallsPerTurn: 50, delegationDepth: 3 };

const vue = (over: Partial<ProofRepairView> = {}): ProofRepairView => ({
  repairAttempts: 1,
  isOwner: true,
  budgets: BUDGETS,
  ...over,
});

let container: HTMLDivElement;
let root: Root;

async function render(initial: ProofRepairView): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(ProofRepairSection, { initial }));
  });
}

/** Le segment d'un choix, par son ancre stable. */
function segment(n: number): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="repair-turns-${n}"]`);
  if (!el) throw new Error(`aucun segment pour ${n}`);
  return el;
}

async function clic(n: number): Promise<void> {
  await act(async () => {
    segment(n).click();
  });
}

const texte = (): string => container.textContent ?? '';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(setProofRepairAction).mockReset();
  vi.mocked(setProofRepairAction).mockResolvedValue({ ok: true, data: undefined });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe('le réglage des tours de réparation @cap:verifier-un-livrable/ecran', () => {
  it('rend la valeur courante comme le segment actif, et la dit en une phrase', async () => {
    await render(vue({ repairAttempts: 2 }));

    // L'ACTIF porte la classe active du contrôle, les autres non : sans cette
    // paire, un rendu qui n'allumerait aucun segment passerait.
    expect(segment(2).className).toContain('bg-ink');
    expect(segment(1).className).not.toContain('bg-ink');
    expect(segment(0).className).not.toContain('bg-ink');
    // La phrase, pas le chiffre nu : « 2 » tout seul ne dit rien.
    expect(texte()).toContain('reopens the run up to 2 times');
  });

  it('zéro ne se lit PAS comme un tour : la phrase change avec la valeur', async () => {
    await render(vue({ repairAttempts: 0 }));
    expect(texte()).toContain('ends the run at once');
    expect(texte()).not.toContain('reopens the run once');
  });

  it('cliquer un segment envoie CE nombre à l’action', async () => {
    await render(vue({ repairAttempts: 1 }));

    await clic(3);

    expect(setProofRepairAction).toHaveBeenCalledWith({ repairAttempts: 3 });
    expect(texte()).toContain('reopens the run up to 3 times');
  });

  it('un refus de l’action remet la valeur d’avant sous les yeux', async () => {
    vi.mocked(setProofRepairAction).mockResolvedValue({
      ok: false,
      code: 'forbidden',
      message: 'Only the workspace owner can change this setting.',
    });
    await render(vue({ repairAttempts: 1 }));

    await clic(0);

    // L'écran ne garde pas une valeur que la base n'a pas prise.
    expect(texte()).toContain('reopens the run once');
    expect(texte()).not.toContain('ends the run at once');
  });

  it('les trois budgets s’affichent avec les nombres REÇUS', async () => {
    await render(vue({ budgets: { resumesPerRun: 7, toolCallsPerTurn: 21, delegationDepth: 2 } }));

    const lire = (cle: string): string =>
      container.querySelector<HTMLElement>(`[data-testid="budget-${cle}"]`)?.textContent ?? '';

    expect(lire('resumes')).toContain('Resumes per run');
    expect(lire('resumes')).toContain('7');
    expect(lire('tool-calls')).toContain('21');
    expect(lire('delegation')).toContain('2');
    // Et pas les nombres du produit : ce que l'écran affiche vient de ce qu'on
    // lui donne, jamais d'une constante recopiée ici.
    expect(lire('resumes')).not.toContain('15');
  });

  it('un invité voit le réglage, et ne peut pas y toucher', async () => {
    await render(vue({ isOwner: false }));

    expect(texte()).toContain('Only the workspace owner can change this setting.');
    expect(segment(0).disabled).toBe(true);

    await clic(0);
    expect(setProofRepairAction).not.toHaveBeenCalled();
  });
});
