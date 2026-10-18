// session.test.ts — une session du banc joue ses essais dans l'espace banc, et nulle part ailleurs.
//
// Le vrai `runBench`, sur une vraie base (spinUpTestDb), avec un vrai espace
// banc créé par la vraie synchronisation : la cible est résolue une fois
// (`resolveBenchTarget`), elle pilote l'agent que run_task vise, l'espace que
// le juge lit (environnement, modèle du root), le contrôle structurel avant
// chaque essai et la vérification du job après. Seuls sont remplacés aux
// frontières : le processus MCP (sa vraie liaison est prouvée par
// mcp.test.ts), l'essai lui-même (trial.test.ts), le verrou et le fichier de
// résultats.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';

/** Ce que chaque run_task a reçu, et où le faux serveur a créé son job. */
const started: Array<{ agentId: string; agentSlug: string }> = [];
let placeJob: (target: { rootAgentId: string }) => Promise<string>;

vi.mock('../mcp', () => ({
  startRunTask: async (
    _stack: string,
    _instruction: string,
    _caller: string,
    target: { rootAgentId: string; rootAgentSlug: string },
  ) => {
    started.push({ agentId: target.rootAgentId, agentSlug: target.rootAgentSlug });
    return { jobId: await placeJob(target), close: () => Promise.resolve() };
  },
}));
vi.mock('../paths', () => ({
  RESULTS_FILE: join(mkdtempSync(join(tmpdir(), 'session-')), 'workflows.ndjson'),
  SUBJECTS_FILE: join(mkdtempSync(join(tmpdir(), 'session-subjects-')), 'research-subjects.json'),
}));
vi.mock('../lock', async (orig) => ({
  ...(await orig<typeof import('../lock')>()),
  claimStack: () => Promise.resolve({ release: () => undefined }),
}));
vi.mock('../stack', async (orig) => ({
  ...(await orig<typeof import('../stack')>()),
  readBenchConfig: () => ({ services: {} }),
  readStackCommit: () => null,
  readStackVersion: () => '0.0.0-test',
  readLiveBenchRoots: () => Promise.resolve([]),
}));
// L'essai : il lit ce que le juge lirait, puis démarre sa demande par
// `deps.start`, et rend une ligne `error` quand le démarrage refuse, comme le vrai.
const judged: Array<{ workspaceRoots: string[]; rootModel: string | null }> = [];
vi.mock('../trial', () => ({
  DEFAULT_TRIAL_OPTIONS: { chatQuietMs: 0 },
  runTrial: async (
    s: { id: string },
    deps: {
      rootModel(): Promise<string | null>;
      env(ms: number): Promise<{ workspaceRoots: string[] }>;
      start(i: string, c: string): Promise<{ jobId: string }>;
    },
  ) => {
    const rootModel = await deps.rootModel();
    const env = await deps.env(Date.now());
    judged.push({ workspaceRoots: env.workspaceRoots, rootModel });
    try {
      const run = await deps.start('instruction', `nodal-bench/${s.id}`);
      return { scenario: s.id, verdict: 'green', reasons: [], rootJobId: run.jobId };
    } catch (e) {
      return { scenario: s.id, verdict: 'error', reasons: [String((e as Error).message)] };
    }
  },
}));

const { runBench } = await import('../session');
const { BenchStop } = await import('../lock');
const { scenarioById } = await import('../scenarios');
const { planSync, applySync } = await import('../../space/sync');
const { copyIdFor, spaceIdFor } = await import('../../space/space');

let db: AnyDrizzleDb;
let pg: Awaited<ReturnType<typeof spinUpTestDb>>['pg'];
let owner: { entityId: string; rootAgentId: string };

beforeEach(async () => {
  started.length = 0;
  judged.length = 0;
  const t = await spinUpTestDb();
  db = t.db as unknown as AnyDrizzleDb;
  pg = t.pg;
  const [user] = await db.insert(d.users).values({ email: 'owner@example.com' }).returning();
  const [ent] = await db
    .insert(d.entities)
    .values({
      userId: user!.id,
      name: 'Owner HQ',
      slug: 'owner-hq',
      rootGrants: DEFAULT_ROOT_GRANTS,
    })
    .returning();
  await db.insert(d.entityMembers).values({ entityId: ent!.id, userId: user!.id, role: 'owner' });
  const [key] = await db
    .insert(d.entityLlmKeys)
    .values({ entityId: ent!.id, provider: 'openrouter', apiKey: 'enc:v1:X', apiKeyLast4: 'abcd' })
    .returning();
  const [root] = await db
    .insert(d.agents)
    .values({
      entityId: ent!.id,
      name: 'Alfred',
      slug: 'alfred',
      personality: 'You orchestrate the team.',
      model: 'z-ai/glm-5.3',
      llmKeyId: key!.id,
      role: 'orchestrator',
    })
    .returning();
  await db.update(d.entities).set({ rootAgentId: root!.id }).where(d.eq(d.entities.id, ent!.id));
  owner = { entityId: ent!.id, rootAgentId: root!.id };
});

async function syncSpace(): Promise<{ spaceId: string; benchRoot: string }> {
  const r = await planSync(db, { workspacesRoot: mkdtempSync(join(tmpdir(), 'ws-')) });
  await applySync(db, r.plan, r.desired);
  const spaceId = spaceIdFor(owner.entityId);
  return { spaceId, benchRoot: copyIdFor(spaceId, 'agents', owner.rootAgentId) };
}

/** Le job qu'un vrai `mcp serve` créerait : dans l'espace et pour l'agent donnés. */
const jobIn = (entityId: string, agentId: string) => async () => {
  const [job] = await db
    .insert(d.agentJobs)
    .values({ entityId, agentId, channel: 'mcp', task: 'trial', status: 'pending' })
    .returning({ id: d.agentJobs.id });
  return job!.id;
};

const session = () =>
  runBench(
    {
      scenarios: [scenarioById('question')!, scenarioById('file')!],
      trials: 1,
      trigger: 'scheduled',
      allowOwnerSends: false,
      stackDir: '/stack',
    },
    db,
    new BenchStop(),
    { log: () => undefined },
  );

describe('runBench plays its trials in the bench space, resolved once', () => {
  it('run_task targets the bench root, and the judge reads the bench space, for every trial', async () => {
    const { spaceId, benchRoot } = await syncSpace();
    placeJob = (t) => jobIn(spaceId, t.rootAgentId)();
    const sum = await session();
    expect(sum.lines.map((l) => [l.scenario, l.verdict])).toEqual([
      ['question', 'green'],
      ['file', 'green'],
    ]);
    expect(started).toEqual([
      { agentId: benchRoot, agentSlug: 'alfred' },
      { agentId: benchRoot, agentSlug: 'alfred' },
    ]);
    // Le juge lit l'espace banc : son dossier partagé, le modèle de SA racine.
    for (const j of judged) {
      expect(j.workspaceRoots[0]).toContain(spaceId);
      expect(j.workspaceRoots.join('|')).not.toContain(owner.entityId);
      expect(j.rootModel).toBe('z-ai/glm-5.3');
    }
    expect(started.map((s) => s.agentId)).not.toContain(owner.rootAgentId);
  });

  it('no bench space: the session refuses with the sync hint, and nothing starts', async () => {
    placeJob = () => Promise.reject(new Error('must not start'));
    await expect(session()).rejects.toThrow(/bench_space_missing: .*pnpm bench:space sync --apply/);
    expect(started).toEqual([]);
    expect(judged).toEqual([]);
    expect(await db.select().from(d.agentJobs)).toEqual([]);
  });

  it('a job that run_task put anywhere else is cancelled, and the trial fails saying so', async () => {
    await syncSpace();
    placeJob = jobIn(owner.entityId, owner.rootAgentId);
    const sum = await session();
    expect(sum.lines.map((l) => l.verdict)).toEqual(['error', 'error']);
    expect(sum.lines[0]!.reasons[0]).toMatch(
      new RegExp(`^workflow_wrong_target: job .* was created in workspace ${owner.entityId}`),
    );
    const jobs = await db.select({ status: d.agentJobs.status }).from(d.agentJobs);
    expect(jobs.map((j) => j.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('a bench space that could reach outside: no run_task at all, the trial fails saying so', async () => {
    const { spaceId, benchRoot } = await syncSpace();
    await pg.query(
      `insert into channel_bindings (entity_id, agent_id, channel, credentials) values ($1, $2, 'discord', 'enc:v1:D')`,
      [spaceId, benchRoot],
    );
    placeJob = () => Promise.reject(new Error('must not start'));
    const sum = await session();
    expect(sum.lines.map((l) => l.verdict)).toEqual(['error', 'error']);
    expect(sum.lines[0]!.reasons[0]).toMatch(/^bench_space_can_send: the trial does not start/);
    expect(started).toEqual([]);
  });
});
