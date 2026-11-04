// ConversationEvents.test.tsx — the conversation shows what the runner pushes
// as soon as it arrives (#944).
//
// Before: a new approval reached the thread on the rail's next 15 s poll, a
// finished job on LiveRefresh's next 3 s tick. What this proves, rendered in
// jsdom with the REAL provider (`ApprovalsProvider`) and the REAL card list
// (`ConversationApprovals`): when the stream says `approval.requested`, the card
// is on screen with no timer having run; when it says `job.finished` or
// `resync`, the thread is re-read; `ready` re-reads nothing; leaving the page
// closes the stream. Only `EventSource` (absent from jsdom) and the server
// actions are stand-ins.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const refresh = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh, push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const listApprovalsAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({
  listApprovalsAction,
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
}));
vi.mock('@/lib/actions', () => ({
  listApprovalsAction,
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
}));

/** The browser's EventSource, as far as the component uses it. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** What the runner pushes, as the browser hands it to the page. */
  emit(type: string, data: unknown, id: string): void {
    if (this.readyState === FakeEventSource.CLOSED) return;
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id });
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}
vi.stubGlobal('EventSource', FakeEventSource);

const approval = (id: string) => ({
  id,
  jobId: 'j1',
  agentId: 'a1',
  agentName: 'Excel',
  agentSlug: 'excel',
  toolName: 'run_command',
  toolInput: { command: 'rm -rf out', purpose: 'Clear the stale build output.' },
  kind: 'approval',
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
    purpose: 'Clear the stale build output.',
    args: [],
    impact: null,
  },
  ruleChain: [],
  toolDefault: 'require_approval',
  agentWorkspaces: [],
  gateReasons: [],
});

const { ApprovalsProvider } = await import('@/components/ApprovalsProvider');
const { default: ConversationApprovals } = await import('../[id]/ConversationApprovals.tsx');
const { default: ConversationEvents } = await import('../[id]/ConversationEvents.tsx');

let container: HTMLDivElement;
let root: Root;

/** Lets the coalesced re-read and the server actions' promises settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ApprovalsProvider initial={[]}>
        <ConversationEvents conversationId="conv-1" />
        <ConversationApprovals conversationId="conv-1" />
      </ApprovalsProvider>,
    );
  });
  await flush();
}

const cards = (): number => container.querySelectorAll('[data-testid="approval-card"]').length;

beforeEach(() => {
  refresh.mockReset();
  FakeEventSource.last = null;
  listApprovalsAction.mockReset();
  listApprovalsAction.mockResolvedValue({ ok: true, data: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the conversation follows the push stream (#944) @cap:suivre-execution/ecran', () => {
  it("listens to THIS conversation's events, through the web proxy", async () => {
    await render();
    expect(FakeEventSource.last?.url).toBe('/api/events?conversationId=conv-1');
  });

  it('an approval.requested puts the card on screen at once, with no poll having run', async () => {
    await render();
    expect(cards()).toBe(0);

    // The runner has written the row and pushes it.
    listApprovalsAction.mockResolvedValue({ ok: true, data: [approval('ap-1')] });
    await act(async () => {
      FakeEventSource.last!.emit(
        'approval.requested',
        { type: 'approval.requested', approvalId: 'ap-1', jobId: 'j1', conversationId: 'conv-1' },
        'b:1',
      );
    });
    await flush();

    expect(cards()).toBe(1);
    expect(container.textContent).toContain('Clear the stale build output.');
  });

  it('an approval.resolved takes the card away once the rows say so', async () => {
    listApprovalsAction.mockResolvedValue({ ok: true, data: [approval('ap-1')] });
    await render();
    // The provider seeds from `initial` and polls later: the event is what reads.
    await act(async () => {
      FakeEventSource.last!.emit('approval.requested', { approvalId: 'ap-1' }, 'b:1');
    });
    await flush();
    expect(cards()).toBe(1);

    // Answered from another client: the row is no longer pending.
    listApprovalsAction.mockResolvedValue({ ok: true, data: [] });
    await act(async () => {
      FakeEventSource.last!.emit('approval.resolved', { approvalId: 'ap-1' }, 'b:2');
    });
    await flush();
    expect(cards()).toBe(0);
  });

  it('a job.finished, a job.failed or a resync re-reads the thread; ready does not', async () => {
    await render();
    await act(async () => {
      FakeEventSource.last!.emit('ready', {}, 'b:0');
    });
    await flush();
    expect(refresh).not.toHaveBeenCalled();

    for (const type of ['job.finished', 'job.failed', 'resync']) {
      refresh.mockReset();
      await act(async () => {
        FakeEventSource.last!.emit(type, { type }, 'b:1');
      });
      await flush();
      expect(refresh, type).toHaveBeenCalledTimes(1);
    }
  });

  it('a replayed burst is read once, not once per event', async () => {
    await render();
    await act(async () => {
      FakeEventSource.last!.emit('job.finished', {}, 'b:1');
      FakeEventSource.last!.emit('job.finished', {}, 'b:2');
      FakeEventSource.last!.emit('approval.resolved', {}, 'b:3');
    });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaving the conversation closes its stream', async () => {
    await render();
    const source = FakeEventSource.last!;
    act(() => root.unmount());
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    // afterEach unmounts again: give it a fresh root.
    root = createRoot(container);
  });
});
