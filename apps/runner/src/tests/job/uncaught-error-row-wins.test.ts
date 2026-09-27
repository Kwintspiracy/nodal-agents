// uncaught-error-row-wins.test.ts — ce qu'un job propage après une erreur non
// rattrapée est TOUJOURS ce que sa ligne dit (#507, revue Codex passe 3).
//
// `failOnUncaughtError` échoue le job par `failJob`, dont l'écriture est
// gardée : un job annulé ou fini entre l'exception et cette écriture n'est pas
// réécrit, et `failJob` rend `false`. L'appelant rapportait pourtant
// `{ status: 'failed' }` : le parent recevait un faux échec pendant que la
// ligne disait `cancelled`. Ici, l'écriture terminale gagne AVANT `failJob`,
// et ce qui est propagé doit égaler la ligne.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';

const { avantFailJob } = vi.hoisted(() => ({
  /** Ce qui se passe juste AVANT que `failJob` n'écrive — l'écriture concurrente. */
  avantFailJob: { current: null as null | ((jobId: string) => Promise<void>) },
}));

vi.mock('../../job/state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../job/state.ts')>();
  return {
    ...actual,
    failJob: async (...args: Parameters<typeof actual.failJob>) => {
      await avantFailJob.current?.(args[1]);
      return actual.failJob(...args);
    },
  };
});

import { executeJob } from '../../job/execute.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

function deps(): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

/** Un job dont le dossier a disparu : sa préparation lèvera `job_folder_missing`. */
async function jobSansDossier(): Promise<string> {
  const dossier = mkdtempSync(join(tmpdir(), 'row-wins-'));
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'monte la vidéo',
      status: 'pending',
      messages: [],
      jobFolder: dossier,
    })
    .returning({ id: agentJobs.id });
  rmSync(dossier, { recursive: true, force: true });
  return row!.id;
}

describe('après une erreur non rattrapée, la ligne fait foi (#507) @cap:organiser-equipe/moteur', () => {
  it('annulé avant failJob : cancelled est propagé, pas un faux échec', async () => {
    const jobId = await jobSansDossier();
    avantFailJob.current = async (id) => {
      await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, id));
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await executeJob(jobId as JobId, deps());
      expect(outcome).toEqual({ status: 'cancelled' });
    } finally {
      avantFailJob.current = null;
      err.mockRestore();
    }
    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row).toEqual({ status: 'cancelled', error: null });
  });

  it('fini ailleurs avant failJob : ce qui est propagé est ce que la ligne dit', async () => {
    const jobId = await jobSansDossier();
    avantFailJob.current = async (id) => {
      await db
        .update(agentJobs)
        .set({ status: 'failed', error: 'runner_restarted', result: '[stopped: runner restarted]' })
        .where(eq(agentJobs.id, id));
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await executeJob(jobId as JobId, deps());
      expect(outcome).toEqual({
        status: 'failed',
        error: 'runner_restarted',
        result: '[stopped: runner restarted]',
      });
    } finally {
      avantFailJob.current = null;
      err.mockRestore();
    }
  });
});
