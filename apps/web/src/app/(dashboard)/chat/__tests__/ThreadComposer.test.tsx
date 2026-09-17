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
// La liste ATTENDUE se calcule avec la fonction que l'écran d'édition appelle :
// c'est le sens de « la même liste que les réglages », et le seul moyen de le
// prouver sans recopier un catalogue qui bougera.
import { buildModelOptionGroups, modelIdsOf } from '@/lib/model-choices.ts';

const sendChatMessageAction = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
const refresh = vi.hoisted(() => vi.fn());
const setAgentModelAndEffortAction = vi.hoisted(() =>
  vi.fn(async (): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true })),
);
const toastError = vi.hoisted(() => vi.fn());
/** La liste EN DIRECT du fournisseur — la même action que l'écran d'édition. */
const listKeyModelsAction = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ ok: true; data: string[] } | { ok: false; message: string }> => ({
      ok: true,
      data: [],
    }),
  ),
);

vi.mock('@/lib/actions.ts', () => ({
  sendChatMessageAction,
  setAgentModelAndEffortAction,
  listKeyModelsAction,
}));
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
  listKeyModelsAction.mockClear();
  listKeyModelsAction.mockResolvedValue({ ok: true, data: [] });
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

// ─── Les trois listes : provider, modèle, effort (#138) ──────────────────────
//
// Ce qui se prouve ici : le composeur RÈGLE l'agent, il ne se contente pas
// d'afficher son modèle, et sa liste de modèles est CELLE DES RÉGLAGES. Le
// reproche de Quentin portait exactement là-dessus : « la liste des modèles est
// foireuse et ne correspond pas à ce qu'on a dans les settings ».
//
// Les assertions portent sur l'ARGUMENT reçu par l'action mockée et sur ce que
// les listes montrent APRÈS (invariant #5) — jamais sur un nombre d'appels.
//
// Les fournisseurs sont de VRAIS fournisseurs du catalogue (openai, anthropic) :
// reposer le modèle quand on change de clé n'a de sens qu'avec un vrai
// catalogue derrière, et un fournisseur inventé ne prouverait rien.

const KEYS = [
  { id: 'key-openai', provider: 'openai', nickname: 'Work OpenAI' },
  { id: 'key-anthropic', provider: 'anthropic', nickname: null },
  // deepseek-chat, premier du catalogue DeepSeek, n'a AUCUN contrôle de
  // raisonnement : c'est le témoin de l'effort qui doit tomber.
  { id: 'key-deepseek', provider: 'deepseek', nickname: 'DS' },
];

const PICKER = {
  agentId: 'agent-1',
  llmKeyId: 'key-openai',
  model: 'gpt-5',
  llmKeys: KEYS,
};

function select(name: 'provider' | 'model' | 'effort'): HTMLSelectElement {
  const el = container.querySelector<HTMLSelectElement>('[data-testid="composer-' + name + '"]');
  if (!el) throw new Error('no ' + name + ' select rendered');
  return el;
}

function optionValues(el: HTMLSelectElement): string[] {
  return [...el.querySelectorAll('option')].map((o) => o.value);
}

/** Choisit une valeur comme un utilisateur : la valeur, puis l'événement. */
async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Laisse la liste EN DIRECT arriver : le composant la demande au montage. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ThreadComposer — provider, modèle, effort @cap:choisir-modele/ecran', () => {
  it('rend TROIS listes, portant les valeurs de l’agent', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await settle();
    expect(select('provider').value).toBe('key-openai');
    expect(select('model').value).toBe('gpt-5');
    expect(select('effort').value).toBe('medium');
    // Le réglage n'est PAS propre à cette conversation, et chaque liste le dit.
    expect(select('model').title).toBe("Sets the agent's setting for every channel");
  });

  it('la liste des modèles est CELLE DES RÉGLAGES : catalogue + modèles vus en direct', async () => {
    listKeyModelsAction.mockResolvedValue({
      ok: true,
      data: ['gpt-5', 'gpt-6-preview-not-catalogued'],
    });
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort={null} />);
    await settle();
    // La liste de l'écran d'édition pour la MÊME clé et la MÊME réponse du
    // fournisseur — construite par la fonction que les deux écrans appellent.
    const attendu = modelIdsOf(
      buildModelOptionGroups('openai', ['gpt-5', 'gpt-6-preview-not-catalogued']),
    );
    expect(optionValues(select('model'))).toEqual(attendu);
    // Et concrètement : le modèle vu en direct y est, une seule fois.
    expect(
      optionValues(select('model')).filter((v) => v === 'gpt-6-preview-not-catalogued'),
    ).toEqual(['gpt-6-preview-not-catalogued']);
    // La clé est lue par l'action que l'écran d'édition utilise, pas une autre.
    expect(listKeyModelsAction.mock.calls).toEqual([['key-openai']]);
  });

  it('le fournisseur n’ayant pas répondu, il reste le catalogue — le repli de l’écran d’édition', async () => {
    listKeyModelsAction.mockResolvedValue({ ok: false, message: 'provider unreachable' });
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort={null} />);
    await settle();
    expect(optionValues(select('model'))).toEqual(modelIdsOf(buildModelOptionGroups('openai', [])));
  });

  it('changer de fournisseur REPOSE le modèle sur celui du nouveau', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await settle();
    await choose(select('provider'), 'key-anthropic');
    // Le modèle gpt-5 ne veut rien dire chez Anthropic : il est reposé sur le
    // premier du catalogue de la nouvelle clé, comme sur l'écran d'édition.
    // 'medium' existe pour claude-opus-5, donc il reste.
    expect(setAgentModelAndEffortAction.mock.calls).toEqual([
      [
        {
          agentId: 'agent-1',
          llmKeyId: 'key-anthropic',
          model: 'claude-opus-5',
          reasoningEffort: 'medium',
        },
      ],
    ]);
    expect(select('provider').value).toBe('key-anthropic');
    expect(select('model').value).toBe('claude-opus-5');
    expect(select('effort').value).toBe('medium');
  });

  it('changer de fournisseur LÂCHE un effort que le nouveau modèle n’offre pas', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await settle();
    await choose(select('provider'), 'key-deepseek');
    expect(setAgentModelAndEffortAction.mock.calls).toEqual([
      [
        {
          agentId: 'agent-1',
          llmKeyId: 'key-deepseek',
          model: 'deepseek-chat',
          reasoningEffort: null,
        },
      ],
    ]);
    expect(select('model').value).toBe('deepseek-chat');
    expect(select('effort').value).toBe('');
    // Rien à régler pour ce modèle : la liste reste, inerte, et le dit.
    expect(select('effort').disabled).toBe(true);
    expect(select('effort').title).toBe('This model offers no reasoning setting');
  });

  it('changer de modèle écrit le nouveau et garde un effort qu’il offre', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="high" />);
    await settle();
    await choose(select('model'), 'gpt-5-mini');
    expect(setAgentModelAndEffortAction.mock.calls).toEqual([
      [
        {
          agentId: 'agent-1',
          llmKeyId: 'key-openai',
          model: 'gpt-5-mini',
          reasoningEffort: 'high',
        },
      ],
    ]);
    expect(select('model').value).toBe('gpt-5-mini');
    expect(select('effort').value).toBe('high');
  });

  it('choisir un effort l’écrit sur l’AGENT, et la liste prend la nouvelle valeur', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await settle();
    await choose(select('effort'), 'low');
    expect(setAgentModelAndEffortAction.mock.calls).toEqual([
      [{ agentId: 'agent-1', llmKeyId: 'key-openai', model: 'gpt-5', reasoningEffort: 'low' }],
    ]);
    expect(select('effort').value).toBe('low');
  });

  it('un échec se dit et les listes GARDENT les anciennes valeurs', async () => {
    setAgentModelAndEffortAction.mockResolvedValue({
      ok: false,
      message: 'That LLM key is disabled.',
    });
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await settle();
    await choose(select('provider'), 'key-anthropic');
    expect(toastError.mock.calls).toEqual([['That LLM key is disabled.']]);
    // Ce que l'écran montre est ce que la base contient (inv. #4).
    expect(select('provider').value).toBe('key-openai');
    expect(select('model').value).toBe('gpt-5');
    expect(select('effort').value).toBe('medium');
  });

  it('sans agent, aucune liste : il n’y a rien à régler', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await settle();
    expect(container.querySelector('[data-testid="composer-provider"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-model"]')).toBeNull();
    // Et l'envoi est toujours là.
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('sans aucune clé LLM, aucune liste — et rien n’est demandé au fournisseur', async () => {
    await render(
      <ThreadComposer
        conversationId="conv-1"
        agentId="agent-1"
        llmKeyId={null}
        model=""
        reasoningEffort={null}
        llmKeys={[]}
      />,
    );
    await settle();
    expect(container.querySelector('[data-testid="composer-provider"]')).toBeNull();
    expect(listKeyModelsAction.mock.calls).toEqual([]);
  });
});

// ─── La rangée d'actions : une seule ligne, et l'envoi qui se voit ───────────
//
// Deux demandes de Quentin sur la rangée, et deux faits mesurables : les
// listes ne dépassent pas le bouton, et le bouton CHANGE DE COULEUR quand il
// y a quelque chose à envoyer. Les classes sont écrites EN DUR ici, jamais
// lues depuis les composants : un test qui lit la valeur qu'il prouve reste
// vert quand on la change.

function sendButton(): HTMLButtonElement {
  const buttons = [...container.querySelectorAll('button')];
  const el = buttons.find((b) => b.textContent === 'Send' || b.textContent === 'Sending…');
  if (!el) throw new Error('no Send button rendered');
  return el;
}

describe('ThreadComposer — la rangée d’actions @cap:parler-a-un-agent/ecran', () => {
  it('les trois listes font la hauteur du bouton, pas plus', async () => {
    await render(<ThreadComposer conversationId="conv-1" {...PICKER} reasoningEffort="medium" />);
    await settle();
    // 30 px : la taille `sm`, celle de PrimaryButton.
    expect(sendButton().className).toContain('h-[30px]');
    for (const name of ['provider', 'model', 'effort'] as const) {
      expect(select(name).className).toContain('h-[30px]');
      // Et pas la hauteur des champs de formulaire, qui ferait deux lignes.
      expect(select(name).className).not.toContain('h-8.5');
      expect(select(name).className).toContain('text-body-13');
      expect(select(name).className).not.toContain('text-body-14');
    }
  });

  it('l’envoi est VIF dès qu’il y a du texte, neutre quand il n’y a rien', async () => {
    await render(<ThreadComposer conversationId="conv-1" agentName="Alfred" />);
    // Rien à envoyer : cliquer ne ferait rien, et le bouton ne le promet pas.
    expect(sendButton().className).toContain('bg-paper');
    expect(sendButton().className).not.toContain('bg-agent-vivid');
    expect(sendButton().disabled).toBe(true);

    await type('bonjour');
    // Le changement de couleur EST le signal « on peut envoyer ».
    expect(sendButton().className).toContain('bg-agent-vivid');
    expect(sendButton().className).not.toContain('bg-paper');
    expect(sendButton().disabled).toBe(false);
  });

  it('un texte fait d’espaces ne rend pas l’envoi vif', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await type('    ');
    expect(sendButton().className).not.toContain('bg-agent-vivid');
    expect(sendButton().disabled).toBe(true);
  });
});
