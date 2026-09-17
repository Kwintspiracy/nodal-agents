// InlineSelect.test.tsx — le choix posé dans une phrase (DS, #138).
//
// Ce qui se prouve : une option GRISÉE reste écrite avec sa raison mais ne se
// choisit pas et les flèches la sautent ; le focus REVIENT sur l'intitulé après
// un choix ou une fermeture au clavier (revue Reviewer C, PR #142 : sans ça il
// retombait en haut du document).
//
// Rendu dans jsdom et MANIPULÉ : les assertions portent sur ce que l'appelant
// REÇOIT (`onPick`) et sur l'élément qui a le focus (invariant #5).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import InlineSelect, { type InlineSelectRow } from '../InlineSelect.tsx';

let container: HTMLDivElement;
let root: Root;

const ROWS: InlineSelectRow[] = [
  { kind: 'heading', label: 'Models' },
  { kind: 'option', value: 'a', label: 'alpha' },
  { kind: 'option', value: 'b', label: 'beta', disabled: true, hint: 'No tools' },
  { kind: 'option', value: 'c', label: 'gamma' },
];

/** L'appelant tient l'état ouvert/fermé, comme la pastille du composeur. */
function Host({ onPick }: { onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <InlineSelect
      name="model"
      label="alpha"
      open={open}
      rows={ROWS}
      value="a"
      onToggle={() => setOpen((o) => !o)}
      onPick={(v) => {
        onPick(v);
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
    />
  );
}

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function trigger(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[data-testid="inline-select-model"]');
  if (!el) throw new Error('no trigger rendered');
  return el;
}

function list(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="inline-select-model-list"]');
  if (!el) throw new Error('no list open');
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function key(el: Element, k: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

describe('InlineSelect', () => {
  it('une option grisée reste écrite avec sa raison, mais ne se choisit pas', async () => {
    const onPick = vi.fn();
    await render(<Host onPick={onPick} />);
    await click(trigger());
    const beta = list().querySelector<HTMLButtonElement>('[data-value="b"]');
    if (!beta) throw new Error('beta not rendered');
    expect(beta.textContent).toContain('beta');
    expect(beta.disabled).toBe(true);
    expect(beta.getAttribute('aria-disabled')).toBe('true');
    expect(beta.title).toBe('No tools');
    await click(beta);
    expect(onPick.mock.calls).toEqual([]);
    // La liste est toujours là : rien n'a été choisi.
    expect(container.querySelector('[data-testid="inline-select-model-list"]')).not.toBeNull();
  });

  it('les flèches SAUTENT l’option grisée, et Entrée choisit celle où l’on est', async () => {
    const onPick = vi.fn();
    await render(<Host onPick={onPick} />);
    await click(trigger());
    // Départ sur « alpha » (la valeur courante) ; une flèche vers le bas doit
    // atterrir sur « gamma », par-dessus « beta » qui est grisée.
    await key(list(), 'ArrowDown');
    await key(list(), 'Enter');
    expect(onPick.mock.calls).toEqual([['c']]);
  });

  it('après un choix, le focus REVIENT sur l’intitulé', async () => {
    await render(<Host onPick={() => {}} />);
    await click(trigger());
    expect(document.activeElement).toBe(list());
    const gamma = list().querySelector<HTMLButtonElement>('[data-value="c"]');
    if (!gamma) throw new Error('gamma not rendered');
    await click(gamma);
    expect(container.querySelector('[data-testid="inline-select-model-list"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Échap ferme sans choisir, et rend le focus à l’intitulé', async () => {
    const onPick = vi.fn();
    await render(<Host onPick={onPick} />);
    await click(trigger());
    await key(list(), 'Escape');
    expect(onPick.mock.calls).toEqual([]);
    expect(container.querySelector('[data-testid="inline-select-model-list"]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });
});
