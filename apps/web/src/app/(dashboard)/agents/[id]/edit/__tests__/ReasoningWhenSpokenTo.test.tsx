// ReasoningWhenSpokenTo.test.tsx — le réglage « Reasoning when spoken to »
// (#977) sur l'écran d'édition d'un agent, sur le DOM rendu.
//
// L'effort d'un tour de chat dont la réponse est ENTENDUE, à côté de
// Reasoning, avec les paliers que le modèle offre (`reasoningOptionValues`).
// Ce que ce fichier prouve : l'écran montre la valeur RANGÉE (jamais une
// valeur déduite de Reasoning), Save envoie les deux efforts tels qu'ils sont,
// un modèle qui n'offre plus le palier le ramène à Auto — et ce qui part au
// serveur le dit —, et un modèle sans réglage cache les deux champs. Les
// assertions portent sur l'argument de `updateAgentAction`, jamais sur un
// compteur d'appels (invariant #5).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Payload = {
  model: string;
  reasoningEffort: string | null;
  spokenReasoningEffort: string | null;
};

const actions = vi.hoisted(() => {
  const noop = () => vi.fn(async () => ({ ok: true as const, data: undefined }));
  return {
    updateAgentAction: vi.fn(
      async (_raw: Payload): Promise<{ ok: true; data: undefined }> => ({
        ok: true,
        data: undefined,
      }),
    ),
    listAgentWorkspacesAction: vi.fn(async () => ({ ok: true as const, data: [] })),
    listKeyModelsAction: vi.fn(async () => ({ ok: true as const, data: [] as string[] })),
    listWorkspaceFilesAction: vi.fn(async () => ({ ok: true as const, data: [] })),
    listAgentApprovalRulesAction: vi.fn(async () => ({ ok: true as const, data: [] })),
    listInternalToolsAction: vi.fn(async () => ({ ok: true as const, data: [] })),
    listAgentAutonomyToolsAction: vi.fn(async () => ({
      ok: true as const,
      data: { tools: [], sharedFileSetting: true },
    })),
    getAgentBudgetAction: vi.fn(async () => ({ ok: false as const, code: 'x', message: 'x' })),
    setAgentFirstTokenWaitAction: noop(),
    addAgentWorkspaceAction: noop(),
    removeAgentWorkspaceAction: noop(),
    uploadToWorkspaceAction: noop(),
    deleteWorkspaceFileAction: noop(),
    setWorkspaceHiddenFromCodeAction: noop(),
    setAgentApprovalRuleAction: noop(),
    setRunCommandRuleAction: noop(),
    setCodeTaskYoloAction: noop(),
    setCliDefaultsAction: noop(),
    setReviewerReadOnlyPresetAction: noop(),
    setAgentRuntimeAction: noop(),
    setCliRuntimeModeAction: noop(),
    setCliRuntimeShellAction: noop(),
    setSkillScriptsAuthorizedAction: noop(),
    setSkillFilesWritableAction: noop(),
    setAgentCommandAllowlistAction: noop(),
    setAgentMayChangeTeamAction: noop(),
    assignSkillAction: noop(),
    unassignSkillAction: noop(),
    deleteAgentAction: noop(),
  };
});

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/agents/x/edit',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams('tab=settings'),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
// La ligne « Diagnostics and defaults » interroge la CLI installée : hors sujet ici.
vi.mock('../CodeTaskProviderRow.tsx', () => ({ default: () => null, ProviderRow: () => null }));
vi.mock('../AgentBudgetSection.tsx', () => ({ default: () => null }));
vi.mock('../FirstTokenWaitField.tsx', () => ({ default: () => null }));

// jsdom ne fournit pas `CSS.supports`, que le `Select` du design system lit au montage.
if (typeof globalThis.CSS?.supports !== 'function') {
  globalThis.CSS = { supports: () => false } as unknown as typeof globalThis.CSS;
}

const { default: AgentComposer } = await import('../AgentComposer.tsx');

const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const KEY_ID = '66666666-6666-4666-8666-666666666666';
// Trois contrôles du catalogue OpenRouter : des paliers et Off ; des paliers
// sans Off (raisonnement obligatoire) ; aucun réglage.
const EFFORT_AND_OFF = 'anthropic/claude-haiku-5.5';
const MANDATORY = 'anthropic/claude-sonnet-5.5';
const NO_CONTROL = 'deepseek/deepseek-v3.2';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  actions.updateAgentAction.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

async function render(agent: {
  model: string;
  reasoningEffort: string | null;
  spokenReasoningEffort: string | null;
}): Promise<void> {
  const row = {
    id: AGENT_ID,
    entityId: '77777777-7777-4777-8777-777777777777',
    name: 'Alfred',
    slug: 'alfred',
    personality: 'You are Alfred.',
    model: agent.model,
    llmKeyId: KEY_ID,
    fallbackChain: [],
    reasoningEffort: agent.reasoningEffort,
    spokenReasoningEffort: agent.spokenReasoningEffort,
    active: true,
    isDefault: true,
    role: 'orchestrator',
    avatarUrl: null,
    orchestratorMode: 'router',
    subAgentIds: [],
    subAgentInstructions: {},
    runtime: 'nodal',
  };
  const key = {
    id: KEY_ID,
    provider: 'openrouter',
    baseUrl: null,
    nickname: null,
    isActive: true,
    hasApiKey: true,
    apiKeyLast4: 'abcd',
  };
  await act(async () => {
    root.render(
      createElement(AgentComposer, {
        agent: row,
        peers: [],
        allAgents: [],
        llmKeys: [key],
        connectors: [],
        mcpServers: [],
        jobs: [],
        attachedSkills: [],
        allSkills: [],
        channelsError: null,
        telegramCfg: null,
        telegramAllowedChats: [],
        discordCfg: null,
        discordAllowedConversations: [],
        slackCfg: null,
        slackAllowedConversations: [],
        whatsappStatus: 'disconnected',
        whatsappAllowedConversations: [],
      } as unknown as Parameters<typeof AgentComposer>[0]),
    );
  });
}

const fieldLabels = (): string[] =>
  [...document.querySelectorAll('label')].map((l) => l.textContent?.trim() ?? '');
const spokenSelect = (): HTMLSelectElement | null =>
  document.querySelector<HTMLSelectElement>('select[aria-label="Reasoning when spoken to"]');
/** Le champ dont l'intitulé est exactement `label` : son `<select>`. */
const selectUnder = (label: string): HTMLSelectElement | null => {
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  return l?.parentElement?.querySelector('select') ?? null;
};
const modelSelect = (): HTMLSelectElement | null =>
  [...document.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === EFFORT_AND_OFF),
  ) ?? null;
const optionsOf = (s: HTMLSelectElement | null): string[] =>
  [...(s?.options ?? [])].map((o) => `${o.value}=${o.textContent ?? ''}`);

function choose(select: HTMLSelectElement | null, value: string): void {
  if (!select) throw new Error('select not rendered');
  act(() => {
    // Le setter natif : React n'entend pas une affectation directe de `.value`.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function save(): Promise<Payload> {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Save',
  );
  if (!button) throw new Error('Save button not rendered');
  await act(async () => button.click());
  const payload = actions.updateAgentAction.mock.calls.at(-1)?.[0];
  if (!payload) throw new Error('nothing was sent to updateAgentAction');
  return payload;
}

describe('Agent settings, Reasoning when spoken to (#977) @cap:configurer-agent/ecran', () => {
  it('sits next to Reasoning with the levels the model offers, and shows the stored value', async () => {
    await render({ model: EFFORT_AND_OFF, reasoningEffort: 'high', spokenReasoningEffort: null });
    const labels = fieldLabels();
    expect(labels.indexOf('Reasoning when spoken to')).toBe(labels.indexOf('Reasoning') + 1);
    expect(optionsOf(spokenSelect())).toEqual([
      '=Auto',
      'low=Low',
      'medium=Medium',
      'high=High',
      'max=Max',
      'off=Off',
    ]);
    // Rangé NULL = Auto, et non le Reasoning de l'agent recopié.
    expect(spokenSelect()?.value).toBe('');
    expect(selectUnder('Reasoning')?.value).toBe('high');
    expect(container.textContent).toContain('Typed chat and the tasks it starts keep Reasoning.');
  });

  it('a stored level is shown as stored', async () => {
    await render({ model: EFFORT_AND_OFF, reasoningEffort: null, spokenReasoningEffort: 'low' });
    expect(spokenSelect()?.value).toBe('low');
    expect(selectUnder('Reasoning')?.value).toBe('');
  });

  it('Save sends both efforts, each as chosen', async () => {
    await render({ model: EFFORT_AND_OFF, reasoningEffort: 'high', spokenReasoningEffort: null });
    choose(spokenSelect(), 'off');
    const payload = await save();
    expect({
      reasoningEffort: payload.reasoningEffort,
      spokenReasoningEffort: payload.spokenReasoningEffort,
    }).toEqual({ reasoningEffort: 'high', spokenReasoningEffort: 'off' });
  });

  it('Auto is saved as null, and Reset brings the stored value back', async () => {
    await render({ model: EFFORT_AND_OFF, reasoningEffort: 'high', spokenReasoningEffort: 'off' });
    choose(spokenSelect(), '');
    expect(spokenSelect()?.value).toBe('');
    const reset = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Reset',
    );
    act(() => reset?.click());
    expect(spokenSelect()?.value).toBe('off');
    choose(spokenSelect(), '');
    expect((await save()).spokenReasoningEffort).toBeNull();
  });

  it('a model that does not offer the stored level brings it back to Auto, and says so on save', async () => {
    await render({ model: EFFORT_AND_OFF, reasoningEffort: 'high', spokenReasoningEffort: 'off' });
    choose(modelSelect(), MANDATORY);
    // Le modèle obligatoire n'offre pas Off : le champ montre Auto, et c'est
    // Auto qui part — jamais « off » rangé derrière un écran qui dit Auto.
    expect(optionsOf(spokenSelect())).not.toContain('off=Off');
    expect(spokenSelect()?.value).toBe('');
    const payload = await save();
    expect({
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
      spokenReasoningEffort: payload.spokenReasoningEffort,
    }).toEqual({ model: MANDATORY, reasoningEffort: 'high', spokenReasoningEffort: null });
  });

  it('a model with no reasoning control shows neither field', async () => {
    await render({ model: NO_CONTROL, reasoningEffort: null, spokenReasoningEffort: null });
    expect(fieldLabels()).not.toContain('Reasoning');
    expect(spokenSelect()).toBeNull();
  });
});
