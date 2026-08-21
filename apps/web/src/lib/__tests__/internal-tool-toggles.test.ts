// internal-tool-toggles.test.ts — per-tool control over the always-on builtins.
//
// The sixteen built-in tools every agent gets were always on and never listed
// in the dashboard: the only way to restrain one was the read-only preset,
// which blocks five write tools at once. There was no way to say "this agent
// may read workspace files but must never search the web".
//
// Two things have to hold, and the second is the one that matters:
//   1. Any of them can carry a rule, like any outward tool.
//   2. `return_result` can NOT be blocked, and the refusal lives on the SERVER.
//      It is not a capability — it is the signal that ENDS a job. Blocking it
//      would leave every job unable to finish, and the agent unable to say so,
//      because reporting is the very tool it just lost. A UI-only guard would
//      be one API call away from that trap.
//
// Asserts on real rows (invariant #5): a call-count test would pass even if the
// action wrote nothing.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, approvalRules } from '@nodal-agents/db';
import { INTERNAL_TOOL_DESCRIPTORS } from '@nodal-agents/orchestration';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

async function rulesFor(toolName: string) {
  return testDb
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.entityId, seed.entityId), eq(approvalRules.toolName, toolName)));
}

describe('the descriptors the dashboard renders', () => {
  // The "covers EVERY always-on tool" check lives in packages/orchestration,
  // which can import @nodal-agents/tools; apps/web deliberately cannot (it
  // would drag the Office document libraries into the dashboard for sixteen
  // labels). See internal-tools.test.ts there.

  it('carries a human label and the tool name for every entry', () => {
    for (const d of INTERNAL_TOOL_DESCRIPTORS) {
      expect(d.name, `${d.slug} has no label`).toBeTruthy();
      // The label must not just be the slug echoed back — that would be a
      // missing entry silently passing as a label.
      expect(d.name).not.toBe(d.slug);
      expect(d.description, `${d.slug} has no description`).toBeTruthy();
    }
  });

  it('marks return_result — and only it — as unblockable', () => {
    const locked = INTERNAL_TOOL_DESCRIPTORS.filter((d) => d.unblockableReason !== undefined);
    expect(locked.map((d) => d.slug)).toEqual(['return_result']);
    expect(locked[0]!.unblockableReason).toMatch(/finished|stuck/i);
  });

  it('classes workspace writes and outward reach as write, plain reads as read', () => {
    const risk = (slug: string) => INTERNAL_TOOL_DESCRIPTORS.find((d) => d.slug === slug)?.risk;
    expect(risk('file_write')).toBe('write');
    expect(risk('file_edit')).toBe('write');
    expect(risk('save_memory')).toBe('write');
    expect(risk('web_search')).toBe('write');
    expect(risk('file_read')).toBe('read');
    expect(risk('file_list')).toBe('read');
  });
});

describe('setAgentApprovalRuleAction — internal tools', () => {
  it('blocks web_search for one agent, and the row proves it', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'web_search',
      action: 'block',
    });
    expect(r.ok).toBe(true);

    const rows = await rulesFor('web_search');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('block');
    expect(rows[0]!.agentId).toBe(seed.agentId);
  });

  it('can put an internal tool behind approval rather than blocking it', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'file_write',
      action: 'require_approval',
    });
    expect(r.ok).toBe(true);

    const rows = await rulesFor('file_write');
    expect(rows[0]!.action).toBe('require_approval');
  });

  it('REFUSES to block return_result, and says why', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'return_result',
      action: 'block',
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('validation_failed');
    // The message is what the owner reads — it has to explain the trap, not
    // just say "forbidden".
    expect(r.message).toMatch(/finished|stuck/i);

    // And nothing was written: a refusal that still persists the row would be
    // the worst of both.
    expect(await rulesFor('return_result')).toHaveLength(0);
  });

  it('still allows a NON-blocking rule on return_result', async () => {
    // Only `block` is the trap. Asking for approval before a job may end is
    // odd but harmless, and refusing it would be a rule nobody asked for.
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'return_result',
      action: 'auto_approve',
    });
    expect(r.ok).toBe(true);
    expect((await rulesFor('return_result'))[0]!.action).toBe('auto_approve');
  });
});
