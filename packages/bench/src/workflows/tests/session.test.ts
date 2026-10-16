// session.test.ts — une session passe à CHAQUE run_task l'agent qu'on lui a épinglé, et aucun autre.
//
// Bench Studio ouvre sa porte sur un agent vérifié (studio/launch-gate.ts) ; ce
// test prouve que la session, le code que le CLI et le studio partagent,
// transmet exactement cet agent au `mcp serve` de chaque essai. La pile, le
// verrou et l'essai sont remplacés aux frontières ; `runBench` est le vrai.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyDrizzleDb } from '@nodal-agents/db';

const started: Array<{ stackDir: string; pinnedAgentId: string | null }> = [];

vi.mock('../mcp', () => ({
  startRunTask: (stackDir: string, _i: string, _c: string, pinnedAgentId: string | null) => {
    started.push({ stackDir, pinnedAgentId });
    return Promise.resolve({ jobId: 'job-1', close: () => Promise.resolve() });
  },
}));
vi.mock('../paths', () => ({
  RESULTS_FILE: join(mkdtempSync(join(tmpdir(), 'session-')), 'workflows.ndjson'),
}));
vi.mock('../lock', async (orig) => ({
  ...(await orig<typeof import('../lock')>()),
  claimStack: () => Promise.resolve({ release: () => undefined }),
}));
vi.mock('../stack', () => ({
  cancelTree: vi.fn(),
  probeService: vi.fn(),
  readBenchConfig: () => ({ services: {} }),
  readForeignActivity: vi.fn(),
  readLiveBenchRoots: () => Promise.resolve([]),
  readRootModel: () => Promise.resolve(null),
  readStackCommit: () => null,
  readStackVersion: () => '0.0.0-test',
  readTeamTools: () => Promise.resolve([]),
  readUnlistedMcpServers: () => Promise.resolve([]),
  readWorkspaceRoots: () => Promise.resolve([]),
}));
vi.mock('@nodal-agents/db', async (orig) => ({
  ...(await orig<typeof import('@nodal-agents/db')>()),
  listMemberWorkspaces: () => Promise.resolve([{ id: 'owner-space' }]),
}));
// L'essai lui-même : il démarre sa demande par `deps.start`, comme le vrai.
vi.mock('../trial', () => ({
  DEFAULT_TRIAL_OPTIONS: { chatQuietMs: 0 },
  runTrial: async (s: { id: string }, deps: { start(i: string, c: string): Promise<unknown> }) => {
    await deps.start('instruction', `nodal-bench/${s.id}`);
    return { scenario: s.id, verdict: 'green', reasons: [] };
  },
}));

const { runBench } = await import('../session');
const { BenchStop } = await import('../lock');
const { scenarioById } = await import('../scenarios');

beforeEach(() => {
  started.length = 0;
});

describe('runBench pins every run_task to the agent it was given', () => {
  const run = (pinnedAgentId: string | null) =>
    runBench(
      {
        scenarios: [scenarioById('question')!, scenarioById('file')!],
        trials: 2,
        trigger: 'manual',
        allowOwnerSends: false,
        stackDir: '/stack',
        pinnedAgentId,
      },
      {} as AnyDrizzleDb,
      new BenchStop(),
      { log: () => undefined },
    );

  it('the pinned agent reaches each of the four run_task calls', async () => {
    const sum = await run('bench-root-agent');
    expect(sum.lines).toHaveLength(4);
    expect(started).toEqual(
      Array.from({ length: 4 }, () => ({ stackDir: '/stack', pinnedAgentId: 'bench-root-agent' })),
    );
  });

  it('no pinned agent: none is passed, the server resolves its target itself', async () => {
    await run(null);
    expect(started.map((s) => s.pinnedAgentId)).toEqual([null, null, null, null]);
  });
});
