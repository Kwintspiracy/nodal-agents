// AutonomyToolRow.test.tsx : une ligne de l'onglet Approvals, telle que la lit
// le PROPRIÉTAIRE (issue #382).
//
// Ce que ça prouve, sur le DOM rendu : la ligne affiche le titre court et le
// résumé, pose l'identifiant technique dessous, et n'affiche JAMAIS la
// `description` écrite pour le modèle, c'est-à-dire ce qu'elle affichait
// avant, et le propriétaire y lisait un mur d'instructions adressées à
// quelqu'un d'autre. Le curseur porte les trois mots de la décision.
//
// La mutation qui rougit ce fichier : rendre `description` à la place de
// `summary` dans AutonomyToolRow.tsx.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AutonomyToolRow, { type AutonomyAction } from '../AutonomyToolRow.tsx';

/** Le vrai texte de `file_write`, côté modèle : ce que la ligne ne doit pas montrer. */
const MODEL_TEXT =
  'Create or overwrite a file in the agent workspace. Path must be workspace-relative. ' +
  'Do NOT use it for a small edit: use file_edit.';

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

async function render(
  overrides: Partial<Parameters<typeof AutonomyToolRow>[0]> = {},
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AutonomyToolRow
        slug="file_write"
        label="Write a workspace file"
        summary="Create or replace a file safely. For a small change to an existing file, use Edit a workspace file. Maximum write size: 1 MiB."
        risk="write"
        value={'auto_approve' as AutonomyAction}
        saving={false}
        onChange={onChange}
        {...overrides}
      />,
    );
  });
}

function buttonLabels(): string[] {
  return [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

beforeEach(() => {
  onChange.mockClear();
});

describe("une ligne d'outil parle au propriétaire @cap:regler-autonomie/ecran", () => {
  it('affiche le titre et le résumé, et jamais le texte du modèle', async () => {
    await render();
    const text = container.textContent ?? '';

    expect(text).toContain('Write a workspace file');
    expect(text).toContain(
      'Create or replace a file safely. For a small change to an existing file, use Edit a workspace file. Maximum write size: 1 MiB.',
    );
    // Le mur adressé au modèle n'a même pas de chemin jusqu'ici : la ligne ne
    // prend pas de `description` du tout.
    expect(text).not.toContain(MODEL_TEXT);
    expect(text).not.toContain('Do NOT');
  });

  it("garde l'identifiant technique sous le résumé", async () => {
    await render();
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('file_write');
  });

  it("dit l'accès en mots, pas en jargon", async () => {
    await render({ risk: 'read' });
    expect(container.textContent).toContain('Read');

    await render({ risk: 'write' });
    expect(container.textContent).toContain('Write');

    await render({ risk: 'destructive' });
    expect(container.textContent).toContain('Cannot be undone');
    expect(container.textContent).not.toContain('irreversible');
  });

  it('offre les trois décisions, dans les mots du propriétaire', async () => {
    await render();
    expect(buttonLabels()).toEqual(['Run without asking', 'Ask for approval', 'Block']);
  });

  it('remonte la décision choisie', async () => {
    await render();
    const block = container.querySelector<HTMLButtonElement>(
      '[data-testid="autonomy-btn-file_write-block"]',
    );
    expect(block).not.toBeNull();
    await act(async () => {
      block!.click();
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('block');
  });

  it("remplace le curseur par la raison quand l'outil ne peut pas être bloqué", async () => {
    await render({
      slug: 'return_result',
      label: 'Finish a task',
      lockedReason:
        'Always available. The agent needs this tool to finish a job or explain why it is stuck. ' +
        'It cannot be blocked.',
    });

    expect(
      container.querySelector('[data-testid="autonomy-locked-return_result"]')?.textContent,
    ).toBe(
      'Always available. The agent needs this tool to finish a job or explain why it is stuck. It cannot be blocked.',
    );
    expect(buttonLabels()).toEqual([]);
  });
});
