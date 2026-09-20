// automations-new-param.test.tsx — le « + » d'une section de la barre latérale
// OUVRE le formulaire en arrivant (`/automations?new=schedule|webhook`,
// Quentin 20/09 : « cliquer + ne fait rien du tout »). Ce qui se prouve ici :
// le paramètre ouvre le bon formulaire, il n'ouvre rien sans agent (le bouton
// lui-même est désactivé), et fermer un formulaire ouvert par l'adresse retire
// le paramètre de l'adresse.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/automations',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/actions.ts', () => ({
  createScheduleAction: vi.fn(),
  updateScheduleAction: vi.fn(),
  deleteScheduleAction: vi.fn(),
  createWebhookTriggerAction: vi.fn(),
  deleteWebhookTriggerAction: vi.fn(),
  rotateWebhookSecretAction: vi.fn(),
  toggleScheduleAction: vi.fn(),
  runScheduleNowAction: vi.fn(),
  toggleWebhookTriggerAction: vi.fn(),
  listAgentsAction: vi.fn(),
}));

import AutomationsClient from '../AutomationsClient.tsx';

// jsdom n'a pas `CSS.supports`, que `Select` lit pour le sélecteur natif
// personnalisable ; le même double que `NewProjectButton.test.tsx`.
const cssStub = { supports: () => false } as unknown as typeof globalThis.CSS;
if (typeof globalThis.CSS?.supports !== 'function') {
  Object.defineProperty(globalThis, 'CSS', { value: cssStub, configurable: true });
}

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

const AGENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Alfred',
  slug: 'alfred',
} as unknown as Parameters<typeof AutomationsClient>[0]['agents'][number];

function titre(): string[] {
  // Le titre d'une modale est un `h3` (Modal.tsx), celui d'une section un `h2`.
  return [...document.querySelectorAll('h2, h3')].map((h) => h.textContent?.trim() ?? '');
}

beforeEach(() => {
  document.body.innerHTML = '';
  replace.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('le « + » de la barre ouvre le formulaire @cap:planifier-une-tache/ecran', () => {
  it('`?new=schedule` ouvre « New schedule » dès l’arrivée', async () => {
    await render(
      createElement(AutomationsClient, {
        agents: [AGENT],
        schedules: [],
        webhooks: [],
        initialNew: 'schedule',
      }),
    );
    expect(titre()).toContain('New schedule');
    expect(titre()).not.toContain('New webhook');
  });

  it('`?new=webhook` ouvre « New webhook » dès l’arrivée', async () => {
    await render(
      createElement(AutomationsClient, {
        agents: [AGENT],
        schedules: [],
        webhooks: [],
        initialNew: 'webhook',
      }),
    );
    expect(titre()).toContain('New webhook');
    expect(titre()).not.toContain('New schedule');
  });

  it('sans agent, rien ne s’ouvre : le bouton est désactivé, le paramètre aussi', async () => {
    await render(
      createElement(AutomationsClient, {
        agents: [],
        schedules: [],
        webhooks: [],
        initialNew: 'schedule',
      }),
    );
    expect(titre()).not.toContain('New schedule');
    // … et le paramètre part de l'adresse tout de suite (revue #302, C2) :
    // laissé là, il rouvrirait le formulaire au premier rechargement après la
    // création d'un agent, sans que personne ne l'ait redemandé.
    expect(replace.mock.calls[0]?.[0]).toBe('/automations');
  });

  it('sans paramètre, rien ne s’ouvre', async () => {
    await render(
      createElement(AutomationsClient, { agents: [AGENT], schedules: [], webhooks: [] }),
    );
    expect(titre()).not.toContain('New schedule');
    expect(titre()).not.toContain('New webhook');
  });

  it('fermer le formulaire ouvert par l’adresse retire le paramètre', async () => {
    await render(
      createElement(AutomationsClient, {
        agents: [AGENT],
        schedules: [],
        webhooks: [],
        initialNew: 'schedule',
      }),
    );
    const cancel = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    );
    expect(cancel).toBeDefined();
    await act(async () => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(titre()).not.toContain('New schedule');
    expect(replace.mock.calls[0]?.[0]).toBe('/automations');
  });
});
