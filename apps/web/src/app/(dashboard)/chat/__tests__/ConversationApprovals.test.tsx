// ConversationApprovals.test.tsx — an approval answered in the conversation (#469).
//
// Quentin, 24/09: answering an approval meant leaving the conversation "just to
// click a button". What this proves, rendered in jsdom with the REAL card
// (`ApprovalRequestCard`): the conversation's pending approvals appear in the
// thread, questions stay out (#465), and "Approve once" answers from here: the
// card leaves and the thread is re-read, with no navigation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const refresh = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh, push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The rail's pending list, as ApprovalsProvider would hand it: set per test,
// then re-rendered to play a poll.
const rail = vi.hoisted(() => ({ pending: [] as Array<{ id: string }> }));
vi.mock('@/components/ApprovalsProvider', () => ({
  useApprovals: () => ({ pending: rail.pending, refresh: async () => {} }),
}));

const listApprovalsAction = vi.hoisted(() => vi.fn());
const resolveApprovalAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({
  listApprovalsAction,
  resolveApprovalAction,
  setAgentApprovalRuleAction: vi.fn(),
}));

const approval = (id: string, kind: 'approval' | 'question') => ({
  id,
  jobId: 'j1',
  agentId: 'a1',
  agentName: 'Excel',
  agentSlug: 'excel',
  toolName: 'run_command',
  toolInput: { command: 'python shared/scripts/x.py', purpose: 'Inspect the workbook.' },
  kind,
  answer: null,
  status: 'pending',
  requestedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  expiresAt: null,
  notes: null,
  jobTask: null,
  jobChannel: 'dashboard',
  conversationId: 'conv-1',
  conversationChannel: 'dashboard',
  rootChannel: null,
  rootJobId: null,
  explanation: {
    what: 'Run a shell command',
    effect: 'external',
    effectLabel: 'Runs a command',
    target: null,
    provenance: { kind: 'builtin' },
    purpose: 'Inspect the workbook.',
    args: [],
    impact: null,
  },
  ruleChain: [],
  toolDefault: 'require_approval',
  agentWorkspaces: [],
  gateReasons: [{ category: 'delete_files', state: 'ask', details: ['rm -rf out'] }],
});

const { default: ConversationApprovals } = await import('../[id]/ConversationApprovals.tsx');

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConversationApprovals conversationId="conv-1" />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function poll(pending: Array<{ id: string }>): Promise<void> {
  rail.pending = pending;
  await act(async () => {
    root.render(<ConversationApprovals conversationId="conv-1" />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p-${i}` }));

beforeEach(() => {
  rail.pending = [];
  refresh.mockReset();
  resolveApprovalAction.mockReset();
  listApprovalsAction.mockReset();
  listApprovalsAction.mockResolvedValue({
    ok: true,
    data: [approval('ap-1', 'approval'), approval('q-1', 'question')],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('approvals in the conversation (#469) @cap:approuver-une-action/ecran', () => {
  it("reads this conversation's pending approvals and shows the card, not the questions", async () => {
    await render();

    expect(listApprovalsAction.mock.calls.map((c) => c[0])).toEqual([
      { status: 'pending', conversationId: 'conv-1' },
    ]);
    const cards = container.querySelectorAll('[data-testid="approval-card"]');
    expect(cards).toHaveLength(1);
    expect(container.textContent).toContain('Delete files or discard changes');
  });

  it('"Approve once" answers from the thread: the card leaves and the thread is re-read', async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: true,
      data: { jobId: 'j1', decision: 'approve', answer: null },
    });
    await render();

    const approve = container.querySelector<HTMLButtonElement>(
      '[data-testid="approval-approve-once"]',
    );
    expect(approve).not.toBeNull();
    await act(async () => {
      approve!.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(resolveApprovalAction.mock.calls.map((c) => c[0])).toEqual([
      { approvalRequestId: 'ap-1', decision: 'approve' },
    ]);
    expect(container.querySelector('[data-testid="approval-card"]')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('nothing pending: nothing in the thread', async () => {
    listApprovalsAction.mockResolvedValue({ ok: true, data: [] });
    await render();
    expect(container.querySelector('[data-testid="conversation-approvals"]')).toBeNull();
  });

  // Review of PR #482 (Reviewer A, P2 and P3).
  it('a new request anywhere re-reads; a poll with the same ids does not', async () => {
    rail.pending = [{ id: 'x' }];
    await render();
    expect(listApprovalsAction).toHaveBeenCalledTimes(1);

    await poll([{ id: 'x' }]);
    expect(listApprovalsAction).toHaveBeenCalledTimes(1);

    await poll([{ id: 'x' }, { id: 'y' }]);
    expect(listApprovalsAction).toHaveBeenCalledTimes(2);
  });

  it('once the rail list is full, every poll re-reads: an older request may have been answered', async () => {
    rail.pending = ids(100);
    await render();
    expect(listApprovalsAction).toHaveBeenCalledTimes(1);

    await poll(ids(100));
    expect(listApprovalsAction).toHaveBeenCalledTimes(2);
  });

  it('a read that lands after the answer does not bring the card back', async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: true,
      data: { jobId: 'j1', decision: 'approve', answer: null },
    });
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="approval-approve-once"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="approval-card"]')).toBeNull();

    // A read started before the answer still returns the request.
    await poll([{ id: 'z' }]);
    expect(listApprovalsAction).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="approval-card"]')).toBeNull();
  });
});
