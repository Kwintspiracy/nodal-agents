// ElicitationCard — la carte d'une question posée par un SERVEUR MCP pendant
// un de ses appels (élicitation, 0145), telle qu'une personne la lit et la
// remplit : dans le fil du run, sur la page Approvals, derrière la cloche.
//
// Les assertions portent sur le DOM rendu et sur ce qui PART au runner (le
// corps de `resolveApprovalAction`) : ce qu'on vérifie est ce qu'une personne
// lit, clique, et ce que le serveur recevra.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/chat/c1',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/lib/actions.ts', () => ({
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
  setAgentShellPolicyAction: vi.fn(),
  listApprovalsAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ApprovalsProvider', () => ({
  useApprovals: () => ({ refresh: async () => {} }),
}));

import ElicitationCard from '../ElicitationCard.tsx';
import ApprovalRequestCard from '../../approvals/ApprovalRequestCard.tsx';
import { resolveApprovalAction } from '@/lib/actions.ts';
import type { ElicitationView } from '@/lib/elicitation-view.ts';

// jsdom ne fournit pas `CSS.supports`, que le `Select` du design system lit.
if (typeof globalThis.CSS?.supports !== 'function') {
  globalThis.CSS = { supports: () => false } as unknown as typeof globalThis.CSS;
}

const SCHEMA = {
  type: 'object',
  properties: {
    paper: {
      type: 'string',
      title: 'Paper',
      enum: ['A4', 'Letter'],
      enumNames: ['A4', 'US Letter'],
    },
    copies: { type: 'integer', title: 'Copies', minimum: 1, maximum: 5 },
    print: { type: 'boolean', title: 'Print', default: false },
  },
  required: ['paper', 'copies', 'print'],
};

function view(over: Partial<ElicitationView> = {}): ElicitationView {
  return {
    approvalRequestId: 'el-1',
    status: 'pending',
    server: 'printer',
    message: 'Print 1 page of <b>report.pdf</b>?',
    requestedSchema: SCHEMA,
    actions: { accept: null, decline: null },
    response: null,
    resolvedBy: null,
    expiresAt: null,
    attachments: [
      { position: 0, mimeType: 'image/png', caption: 'Page 1' },
      { position: 1, mimeType: 'image/png', caption: null },
    ],
    ...over,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function monter(node: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

function rendu(): HTMLDivElement {
  if (!container) throw new Error('rien monté');
  return container;
}

function parTestId(id: string): HTMLElement | null {
  return rendu().querySelector(`[data-testid="${id}"]`);
}

function boutons(): string[] {
  return [...rendu().querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

async function cliquer(el: Element | null): Promise<void> {
  if (!el) throw new Error('élément introuvable');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Saisir dans un champ contrôlé par React : le setter natif, puis l'événement. */
async function saisir(el: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveApprovalAction).mockResolvedValue({
    ok: true,
    data: { jobId: 'j1', decision: 'approve', answer: null },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('la question d’un serveur MCP, sur l’écran @cap:approuver-une-action/ecran', () => {
  it('dit QUI demande, cite la question telle quelle, et montre les images jointes', async () => {
    await monter(<ElicitationCard elicitation={view()} />);
    expect(parTestId('elicitation-header')!.textContent).toBe('MCP server “printer” asks:');
    // Texte tiers : affiché tel quel, jamais interprété comme du HTML.
    const message = parTestId('elicitation-message')!;
    expect(message.textContent).toBe('Print 1 page of <b>report.pdf</b>?');
    expect(message.querySelector('b')).toBeNull();
    const thumbs = [...rendu().querySelectorAll('[data-testid="elicitation-thumbnail"]')];
    expect(thumbs.map((t) => t.getAttribute('src'))).toEqual([
      '/api/approvals/el-1/attachments/0',
      '/api/approvals/el-1/attachments/1',
    ]);
    expect(thumbs[0]!.getAttribute('alt')).toBe('Page 1');
  });

  it('dessine le formulaire demandé, et rien d’une approbation', async () => {
    await monter(<ElicitationCard elicitation={view()} />);
    const select = parTestId('elicitation-field-paper')!.querySelector('select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose…', 'A4', 'US Letter']);
    const copies = parTestId('elicitation-field-copies')!.querySelector('input')!;
    expect(copies.type).toBe('number');
    expect(copies.min).toBe('1');
    expect(copies.max).toBe('5');
    expect(parTestId('elicitation-field-print')!.querySelector('[role="switch"]')).not.toBeNull();
    // Sans libellé du serveur : « ✅ Confirm » / « Decline ». Jamais « Send ».
    expect(boutons()).toEqual(expect.arrayContaining(['✅ Confirm', 'Decline']));
    expect(boutons()).not.toContain('Send');
    expect(boutons().some((b) => /approve|always|never/i.test(b))).toBe(false);
  });

  it('le bouton d’accord porte le libellé que le serveur lui donne', async () => {
    await monter(
      <ElicitationCard elicitation={view({ actions: { accept: 'Print', decline: 'Not now' } })} />,
    );
    expect(parTestId('elicitation-send')!.textContent).toBe('Print');
    expect(parTestId('elicitation-decline')!.textContent).toBe('Not now');
    expect(boutons()).not.toContain('Send');
  });

  it('Envoyer part avec exactement ce qui a été rempli', async () => {
    await monter(<ElicitationCard elicitation={view()} />);
    await saisir(parTestId('elicitation-field-paper')!.querySelector('select')!, 'Letter');
    await saisir(parTestId('elicitation-field-copies')!.querySelector('input')!, '3');
    await cliquer(parTestId('elicitation-field-print')!.querySelector('[role="switch"]'));
    await cliquer(parTestId('elicitation-send'));
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'el-1',
      decision: 'approve',
      content: { paper: 'Letter', copies: 3, print: true },
    });
  });

  it('une valeur hors bornes est dite sous son champ, et rien ne part', async () => {
    await monter(<ElicitationCard elicitation={view()} />);
    await saisir(parTestId('elicitation-field-paper')!.querySelector('select')!, 'A4');
    await saisir(parTestId('elicitation-field-copies')!.querySelector('input')!, '9');
    await cliquer(parTestId('elicitation-send'));
    expect(parTestId('elicitation-field-copies')!.textContent).toContain('must be at most 5');
    expect(vi.mocked(resolveApprovalAction)).not.toHaveBeenCalled();
  });

  it('Refuser part sans contenu', async () => {
    await monter(<ElicitationCard elicitation={view()} />);
    await cliquer(parTestId('elicitation-decline'));
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'el-1',
      decision: 'reject',
    });
  });

  it('répondue : ce qui a été envoyé, avec les libellés, et plus de formulaire', async () => {
    await monter(
      <ElicitationCard
        elicitation={view({
          status: 'approved',
          response: { paper: 'Letter', copies: 2, print: true },
        })}
      />,
    );
    const answer = parTestId('elicitation-answer')!.textContent;
    expect(answer).toContain('US Letter');
    expect(answer).toContain('Copies2');
    expect(answer).toContain('PrintYes');
    expect(parTestId('elicitation-send')).toBeNull();
  });

  it('retirée par le serveur : la carte le dit', async () => {
    await monter(
      <ElicitationCard
        elicitation={view({ status: 'expired', resolvedBy: 'system:server_cancelled' })}
      />,
    );
    expect(parTestId('elicitation-expired')!.textContent).toBe('Withdrawn by the server');
  });

  it('la page Approvals dessine la carte de la question, pas celle d’une approbation', async () => {
    const approval = {
      id: 'el-1',
      kind: 'elicitation',
      status: 'pending',
      toolName: 'printer__request_print',
      elicitation: view(),
    } as unknown as Parameters<typeof ApprovalRequestCard>[0]['approval'];
    await monter(<ApprovalRequestCard approval={approval} />);
    expect(parTestId('elicitation-card')).not.toBeNull();
    expect(boutons().some((b) => /approve/i.test(b))).toBe(false);
  });
});
