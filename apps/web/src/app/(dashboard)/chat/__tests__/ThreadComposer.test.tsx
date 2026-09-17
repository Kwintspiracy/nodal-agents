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
const setAgentModelAndEffortAction = vi.hoisted(() =>
  vi.fn(async (): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true })),
);
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/actions.ts', () => ({ sendChatMessageAction, setAgentModelAndEffortAction }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }));
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
  setAgentModelAndEffortAction.mockClear();
  setAgentModelAndEffortAction.mockResolvedValue({ ok: true });
  toastError.mockClear();
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

// ─── La pastille « modèle · effort » (#138) ──────────────────────────────────
//
// Ce qui se prouve ici : le composeur RÈGLE l'agent, il ne se contente pas
// d'afficher son modèle. L'assertion porte sur l'ARGUMENT reçu par l'action
// mockée, et sur ce que la pastille montre APRÈS (invariant #5) — jamais sur
// un nombre d'appels.
//
// Les modèles et les paliers sont ceux que le test DONNE, pas ceux du
// catalogue : la pastille n'a pas à savoir ce qu'Anthropic propose, et un test
// qui lirait le vrai catalogue changerait de couleur au prochain modèle ajouté.

const PICKER = {
  agentId: 'agent-1',
  model: 'claude-opus-5',
  modelOptions: [
    { modelId: 'claude-opus-5', label: 'Claude Opus 5' },
    { modelId: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ],
  effortsByModel: {
    'claude-opus-5': ['low', 'medium', 'high', 'max', 'off'],
    'claude-sonnet-5': ['low', 'high'],
  },
};

function chip(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[data-testid="model-effort-chip"]');
  if (!el) throw new Error('no chip rendered');
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Le bouton d'option portant ce libellé, dans le panneau ouvert. */
function option(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`no option "${label}" in the popover`);
  return found;
}

describe('ThreadComposer — modèle et effort @cap:choisir-modele/ecran', () => {
  it('la pastille dit le modèle courant, son effort, et la portée du réglage', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    expect(chip().textContent).toContain('claude-opus-5');
    expect(chip().textContent).toContain('Medium');
    // Le réglage n'est PAS propre à cette conversation : la pastille le dit.
    expect(chip().title).toBe("Sets the agent's model for every channel");
  });

  it('sans effort en base, la pastille dit « Auto »', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort={null} />);
    expect(chip().textContent).toContain('Auto');
  });

  it('ouvrir la pastille liste les modèles donnés et les paliers du modèle courant', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    expect(container.querySelector('[data-testid="model-effort-popover"]')).toBeNull();
    await click(chip());
    const labels = [...container.querySelectorAll('[role="radio"]')].map((b) => b.textContent);
    expect(labels.some((t) => t?.includes('Claude Sonnet 5'))).toBe(true);
    expect(labels.some((t) => t?.includes('Auto'))).toBe(true);
    expect(labels.some((t) => t?.includes('Max'))).toBe(true);
    // Aucun `<select>` natif : le DS remplace les widgets natifs.
    expect(container.querySelector('select')).toBeNull();
  });

  it('choisir un effort l’écrit sur l’AGENT, et la pastille prend la nouvelle valeur', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await click(chip());
    await click(option('High'));
    expect(setAgentModelAndEffortAction.mock.calls).toEqual([
      [{ agentId: 'agent-1', model: 'claude-opus-5', reasoningEffort: 'high' }],
    ]);
    expect(chip().textContent).toContain('High');
    // Le panneau se referme sur le choix.
    expect(container.querySelector('[data-testid="model-effort-popover"]')).toBeNull();
  });

  it('choisir un modèle qui n’offre pas l’effort courant repasse à Auto', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await click(chip());
    await click(option('Claude Sonnet 5'));
    // 'medium' n'est pas dans les paliers de claude-sonnet-5 : il tombe, comme
    // sur l'écran d'édition, plutôt que de partir vers un refus de l'action.
    expect(setAgentModelAndEffortAction.mock.calls).toEqual([
      [{ agentId: 'agent-1', model: 'claude-sonnet-5', reasoningEffort: null }],
    ]);
    expect(chip().textContent).toContain('claude-sonnet-5');
    expect(chip().textContent).toContain('Auto');
  });

  it('un échec se dit et la pastille GARDE l’ancienne valeur', async () => {
    setAgentModelAndEffortAction.mockResolvedValue({
      ok: false,
      message: 'Only the workspace owner can change an agent’s model.',
    });
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await click(chip());
    await click(option('High'));
    expect(toastError.mock.calls).toEqual([
      ['Only the workspace owner can change an agent’s model.'],
    ]);
    // Ce que l'écran montre est ce que la base contient (inv. #4).
    expect(chip().textContent).toContain('Medium');
    expect(chip().textContent).not.toContain('High');
  });

  it('sans agent, pas de pastille : il n’y a rien à régler', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    expect(container.querySelector('[data-testid="model-effort-chip"]')).toBeNull();
    // Et l'envoi est toujours là.
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('Échap referme le panneau sans rien écrire', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await click(chip());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-testid="model-effort-popover"]')).toBeNull();
    expect(setAgentModelAndEffortAction.mock.calls).toEqual([]);
  });
});
