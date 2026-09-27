// job-folder.test.ts — the folder the owner attaches to ONE request (#507).
//
// Folders were per agent only. In run 0b505b0d the owner named a folder that
// was in Montage's own; the orchestrator, seeing no folder for anyone, invented
// `shared/Nodal-Video`. A job folder is set on the request, carried down the
// whole delegation tree of that run, and listed FIRST in every agent's folders
// for that run, without ever being added to any agent for good.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentTasks, agentWorkspaces, eq } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { withJobFolder, JOB_FOLDER_LABEL } from '@nodal-agents/tools';

vi.mock('../../job/execute.ts', () => ({
  executeJob: vi.fn(async () => ({ status: 'completed' })),
}));

const { executeReadyTasks } = await import('../../cron/execute-ready.ts');

const DEV = { label: 'Dev', path: 'C:/Users/u/Documents/Dev' };
const SHARED = { label: 'shared', path: 'C:/Users/u/.nodalai/workspaces/e1/shared' };

describe('withJobFolder', () => {
  it('puts the job folder FIRST, labelled as this job’s, before the agent’s own', () => {
    const r = withJobFolder([DEV, SHARED], 'D:/Projets/Nodal-Video');
    expect(r).toEqual([
      { label: JOB_FOLDER_LABEL, path: 'D:/Projets/Nodal-Video', jobFolder: true },
      DEV,
      SHARED,
    ]);
  });

  it('no job folder: the list is unchanged', () => {
    expect(withJobFolder([DEV, SHARED], null)).toEqual([DEV, SHARED]);
  });

  it('a job folder the agent already has is moved first, not listed twice', () => {
    const r = withJobFolder([SHARED, DEV], DEV.path);
    expect(r).toEqual([{ ...DEV, jobFolder: true }, SHARED]);
  });

  it('an agent folder already labelled like the job folder fails loud', () => {
    expect(() =>
      withJobFolder([{ label: JOB_FOLDER_LABEL, path: 'C:/x' }], 'D:/Projets/Nodal-Video'),
    ).toThrow(/job_folder_label_taken/);
  });
});

describe('the job folder travels down the task board', () => {
  let db: TestDb;
  let seed: { userId: string; entityId: string; agentId: string; jobId: string };

  beforeAll(async () => {
    const res = await spinUpTestDb();
    db = res.db;
    seed = await seedMinimal(db);
  });

  it('a task-board child is born with its creator job’s folder, at every depth', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'job-folder-'));
    await db.update(agentJobs).set({ jobFolder: folder }).where(eq(agentJobs.id, seed.jobId));
    const deps = { db } as unknown as RunnerDeps;

    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      title: 'first level',
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      rootJobId: seed.jobId,
      status: 'todo',
    });
    await executeReadyTasks(db as unknown as Parameters<typeof executeReadyTasks>[0], deps);
    const [first] = await db
      .select({ id: agentJobs.id, jobFolder: agentJobs.jobFolder })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, seed.jobId));
    expect(first?.jobFolder).toBe(folder);

    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      title: 'second level',
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      rootJobId: first!.id,
      status: 'todo',
    });
    await executeReadyTasks(db as unknown as Parameters<typeof executeReadyTasks>[0], deps);
    const [second] = await db
      .select({ jobFolder: agentJobs.jobFolder })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, first!.id));
    expect(second?.jobFolder).toBe(folder);

    // Never added to the agent for good.
    const attached = await db
      .select({ path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.agentId, seed.agentId));
    expect(attached.map((w) => w.path)).not.toContain(folder);
  });
});
