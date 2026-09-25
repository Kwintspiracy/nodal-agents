// shell-policy-actions.test.ts — the server side of the autonomy checklist (#464).
//
// What this proves, on a real database (rows read back, never call counts):
//   - `setAgentShellPolicyAction` stores ONLY what the owner set, one kind of
//     action at a time, without losing the others, and refuses what the engine
//     would not read;
//   - `getAutoRunPauseAction` gives the screen the workspace autonomy, which
//     the "Run commands" sentence needs to say what really happens;
//   - `listApprovalsAction` carries the reasons the gate stored, masked like
//     everything else the card shows.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agents, approvalRequests, entities } from '@nodal-agents/db';
import { DEFAULT_ROOT_GRANTS, DEFAULT_SHELL_POLICY } from '@nodal-agents/shared';

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
    requireAuth: async () => ({ userId: seed?.userId ?? 'u', entityId: seed?.entityId ?? 'e' }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

const storedPolicy = async (): Promise<unknown> => {
  const [row] = await testDb
    .select({ shellPolicy: agents.shellPolicy })
    .from(agents)
    .where(eq(agents.id, seed.agentId));
  return row?.shellPolicy;
};

describe('setAgentShellPolicyAction @cap:regler-autonomie/moteur', () => {
  it('stores one kind of action at a time, keeping the others', async () => {
    const { setAgentShellPolicyAction } = await import('../actions.ts');

    const first = await setAgentShellPolicyAction({
      agentId: seed.agentId,
      category: 'inline_code',
      state: 'never',
    });
    const second = await setAgentShellPolicyAction({
      agentId: seed.agentId,
      category: 'delete_files',
      state: 'allow',
    });

    expect(first.ok && second.ok).toBe(true);
    expect(await storedPolicy()).toEqual({ inline_code: 'never', delete_files: 'allow' });
    expect(second.ok && second.data).toEqual({
      ...DEFAULT_SHELL_POLICY,
      inline_code: 'never',
      delete_files: 'allow',
    });
  });

  it('refuses a kind of action or a state the engine would not read', async () => {
    const { setAgentShellPolicyAction } = await import('../actions.ts');
    const before = await storedPolicy();

    const badCategory = await setAgentShellPolicyAction({
      agentId: seed.agentId,
      category: 'format_disk',
      state: 'never',
    });
    const badState = await setAgentShellPolicyAction({
      agentId: seed.agentId,
      category: 'download',
      state: 'maybe',
    });

    expect(badCategory.ok).toBe(false);
    expect(badState.ok).toBe(false);
    expect(await storedPolicy()).toEqual(before);
  });

  it('an agent of another workspace is not found, and nothing is written', async () => {
    const { setAgentShellPolicyAction } = await import('../actions.ts');
    const res = await setAgentShellPolicyAction({
      agentId: '99999999-9999-4999-8999-999999999999',
      category: 'download',
      state: 'never',
    });
    expect(res.ok).toBe(false);
  });

  // Review of PR #486 (Reviewer A, P2): "Never for this agent" sets several
  // kinds at once, and must save all of them or none.
  it('sets several kinds to one state in one write, or none of them', async () => {
    const { setAgentShellPolicyAction } = await import('../actions.ts');
    const before = await storedPolicy();

    const bad = await setAgentShellPolicyAction({
      agentId: seed.agentId,
      categories: ['stop_programs', 'format_disk'],
      state: 'never',
    });
    expect(bad.ok).toBe(false);
    expect(await storedPolicy()).toEqual(before);

    const both = await setAgentShellPolicyAction({
      agentId: seed.agentId,
      category: 'download',
      categories: ['download'],
      state: 'never',
    });
    expect(both.ok, 'one category and a list at once').toBe(false);

    const good = await setAgentShellPolicyAction({
      agentId: seed.agentId,
      categories: ['stop_programs', 'system_settings'],
      state: 'never',
    });
    expect(good.ok).toBe(true);
    expect(await storedPolicy()).toEqual({
      ...((before as Record<string, string> | null) ?? {}),
      stop_programs: 'never',
      system_settings: 'never',
    });
  });
});

describe('getAutoRunPauseAction gives the workspace autonomy (#464) @cap:regler-autonomie/moteur', () => {
  it('reads it from root_grants', async () => {
    await testDb
      .update(entities)
      .set({ rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'destructive_gate' } })
      .where(eq(entities.id, seed.entityId));
    const { getAutoRunPauseAction } = await import('../actions.ts');

    const res = await getAutoRunPauseAction();

    expect(res.ok && res.data.workspaceAutonomy).toBe('destructive_gate');
  });
});

describe('listApprovalsAction carries the gate reasons (#464) @cap:approuver-une-action/moteur', () => {
  it('reads them back, masked', async () => {
    const secret = 'sk-ant-api03-QRSTUVWXYZ0123456789ABCDEFGHIJ'; // secrets:allow (fixture : clé factice)
    await testDb.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'type x', purpose: 'read' },
      status: 'pending',
      gateReasons: [
        { category: 'download', state: 'ask', details: ['wget https://example.com/a.zip'] },
        { category: 'inline_code', state: 'ask', details: [`python -c "print('${secret}')"`] },
      ],
    });
    const { listApprovalsAction } = await import('../actions.ts');

    const res = await listApprovalsAction({ status: 'pending', jobIds: [seed.jobId] });

    expect(res.ok).toBe(true);
    const row = res.ok ? res.data.find((r) => r.toolName === 'run_command') : undefined;
    expect(row?.gateReasons.map((r) => r.category)).toEqual(['download', 'inline_code']);
    expect(row?.gateReasons[0]?.details).toEqual(['wget https://example.com/a.zip']);
    expect(JSON.stringify(row?.gateReasons)).not.toContain(secret);
  });
});
