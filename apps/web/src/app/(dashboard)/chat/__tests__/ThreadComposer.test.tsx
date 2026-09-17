// ThreadComposer.test.tsx — la saisie en bas d'un fil (P7, redessinée en
// P2bis). Ce qui se prouve : c'est une ZONE de texte (un collage multi-ligne
// garde ses retours, Maj+Entrée en ajoute un), Entrée envoie le texte tel
// quel à l'action, et le champ redevient vide après l'envoi — vide ET encore
// haut de trois lignes, sur sa propre surface, depuis #135.
//
// Rendu dans jsdom et TAPÉ, pas seulement rendu : l'assertion porte sur
// l'ARGUMENT reçu par l'action mockée (invariant #5).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// Les hauteurs sont écrites en dur dans les assertions, jamais importées du
// composant : un test qui lit la constante qu'il prouve reste vert quand on
// l'abaisse (revue Reviewer C).
import ThreadComposer from '../ThreadComposer.tsx';

const sendChatMessageAction = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
const refresh = vi.hoisted(() => vi.fn());

vi.mock('@/lib/actions.ts', () => ({ sendChatMessageAction }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

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

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('no textarea rendered');
  return el;
}

/** Tape un texte comme un collage : la valeur entière, d'un coup. */
async function type(text: string): Promise<void> {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(key: string, shiftKey = false): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
}

beforeEach(() => {
  sendChatMessageAction.mockClear();
  refresh.mockClear();
});

describe('ThreadComposer', () => {
  it('est une zone de texte de trois lignes à vide, qui nomme l’agent', async () => {
    await render(<ThreadComposer conversationId="conv-1" agentName="Alfred" />);
    const el = textarea();
    expect(el.rows).toBe(3);
    expect(el.placeholder).toBe('Reply to Alfred…');
    // Pas de champ d'une ligne : il aplatirait un collage (revue Codex, passe 56).
    expect(container.querySelector('input')).toBeNull();
  });

  it('porte sa propre surface et son texte de 14 px (#135)', async () => {
    await render(<ThreadComposer conversationId="conv-1" agentName="Alfred" />);
    const el = textarea();
    const frame = el.closest('div.rounded-xl');
    if (!frame) throw new Error('no composer frame rendered');
    expect(frame.className).toContain('bg-feed-composer');
    // Le papier du fil n'est plus la surface de la saisie.
    expect(frame.className).not.toContain('bg-paper');
    expect(el.className).toContain('text-body-14');
    expect(el.className).not.toContain('text-body-15');
    // Plancher et plafond du cadre, tenus en CSS avant toute mesure.
    expect(el.className).toContain('min-h-[60px]');
    expect(el.className).toContain('max-h-[200px]');
    // L'indication se lit sur la surface : `ink-4` n'y fait que ~2,6:1
    // (revue Reviewer C).
    expect(el.className).toContain('placeholder:text-ink-2/70');
  });

  it('après un envoi, la zone vidée garde ses trois lignes', async () => {
    await render(<ThreadComposer conversationId="conv-1" agentName="Alfred" />);
    await type('une ligne\ndeux\ntrois\nquatre\ncinq');
    await press('Enter');
    const el = textarea();
    expect(el.value).toBe('');
    expect(el.rows).toBe(3);
    // jsdom ne met aucune hauteur au contenu : `scrollHeight` vaut 0, et c'est
    // donc le PLANCHER qui décide. Sans lui, la zone vidée retombait à 0 px.
    // Le chiffre est écrit ici EN DUR — trois lignes de 20 px : lu depuis les
    // constantes du composant, le test suivrait un plancher qu'on abaisserait.
    const measured = Number.parseInt(el.style.height, 10);
    expect(Number.isNaN(measured)).toBe(false);
    expect(measured).toBeGreaterThanOrEqual(60);
  });

  it('Entrée envoie le texte TEL QUEL, retours à la ligne compris, puis vide le champ', async () => {
    await render(<ThreadComposer conversationId="conv-1" agentName="Alfred" />);
    await type('Première ligne\nDeuxième ligne\n\n```ts\nconst x = 1;\n```');
    await press('Enter');
    expect(sendChatMessageAction.mock.calls).toEqual([
      [
        {
          conversationId: 'conv-1',
          message: 'Première ligne\nDeuxième ligne\n\n```ts\nconst x = 1;\n```',
        },
      ],
    ]);
    expect(textarea().value).toBe('');
    expect(refresh).toHaveBeenCalled();
  });

  it('Maj+Entrée n’envoie pas : c’est un retour à la ligne', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await type('en cours');
    await press('Enter', true);
    expect(sendChatMessageAction.mock.calls).toEqual([]);
    expect(textarea().value).toBe('en cours');
  });

  it('un texte vide ne part pas', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await type('   ');
    await press('Enter');
    expect(sendChatMessageAction.mock.calls).toEqual([]);
  });
});
