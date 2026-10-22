// process-scopes.test.ts — QUAND le périmètre d'un job se ferme (#628) : à la
// fin du job, quelle qu'elle soit, et jamais avant. Sur la vraie table
// `agent_jobs`. La mort réelle des processus : de bout en bout par
// run-command-flow.test.ts, et ici, pour CHAQUE fin (#750) — terminé, échoué,
// arrêté, repris d'un runner mort —, sur un démon détaché qu'une commande a
// laissé derrière elle.
//
// Mutation vérifiée (annulée ensuite) : `releaseProcessesOfLostJob` retiré de
// `reclaimJobsOfDeadRunners` → « reclaimed » rouge, le démon survit.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellCommand, buildChildEnv } from '@nodal-agents/tools';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, cancelJobTree, eq } from '@nodal-agents/db';
import {
  closeAllJobProcessScopes,
  createSandbox,
  defaultSandbox,
  isProcessAlive,
  type Sandbox,
  jobProcessScope,
  openJobProcessScopeIds,
} from '@nodal-agents/sandbox';
import { reclaimJobsOfDeadRunners } from '../../cron/reclaim-jobs.ts';
import {
  JOB_PROCESSES_RELEASED,
  releaseIfEnded,
  releaseJobProcessesIfEnded,
  startJobProcessSweep,
} from '../../job/process-scopes.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
const asDb = () => db as unknown as Parameters<typeof releaseIfEnded>[0];

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
});

afterAll(async () => {
  await closeAllJobProcessScopes();
});

async function job(status: string): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 't', status })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('job insert failed');
  return row.id;
}

describe('releaseIfEnded @cap:executer-une-commande/moteur', () => {
  it('a job still alive keeps its processes: processing, pending (self-chain), awaiting approval or delegation', async () => {
    const ids = await Promise.all(
      ['processing', 'pending', 'awaiting_approval', 'awaiting_delegation'].map(job),
    );
    for (const id of ids) jobProcessScope(id);
    const released = await releaseIfEnded(asDb(), ids, () => {});
    expect(released).toEqual([]);
    for (const id of ids) expect(openJobProcessScopeIds()).toContain(id);
  });

  it('a finished job releases them, whatever the end: completed, failed, cancelled', async () => {
    const ids = await Promise.all(['completed', 'failed', 'cancelled'].map(job));
    for (const id of ids) jobProcessScope(id);
    const logged: { code: string; data: Record<string, unknown> }[] = [];
    const released = await releaseIfEnded(asDb(), ids, (code, data) => logged.push({ code, data }));
    expect(released.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(openJobProcessScopeIds()).not.toContain(id);
    expect(logged.map((l) => l.code)).toEqual([
      JOB_PROCESSES_RELEASED,
      JOB_PROCESSES_RELEASED,
      JOB_PROCESSES_RELEASED,
    ]);
  });

  it('a job whose row is gone releases them too', async () => {
    const id = await job('processing');
    jobProcessScope(id);
    await db.delete(agentJobs).where(eq(agentJobs.id, id));
    expect(await releaseIfEnded(asDb(), [id], () => {})).toEqual([id]);
    expect(openJobProcessScopeIds()).not.toContain(id);
  });

  it('closing one job leaves the other jobs’ scopes open', async () => {
    const done = await job('completed');
    const live = await job('processing');
    jobProcessScope(done);
    jobProcessScope(live);
    await releaseIfEnded(asDb(), [done, live], () => {});
    expect(openJobProcessScopeIds()).not.toContain(done);
    expect(openJobProcessScopeIds()).toContain(live);
  });

  it('the periodic sweep releases a job stopped while suspended, which no run sees end', async () => {
    const id = await job('awaiting_approval');
    jobProcessScope(id);
    const sweep = startJobProcessSweep(asDb(), 50);
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(openJobProcessScopeIds()).toContain(id);
      // Le Stop d'un job suspendu : sa ligne passe à `cancelled`, aucun run ne tourne.
      await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, id));
      for (let i = 0; i < 40 && openJobProcessScopeIds().includes(id); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(openJobProcessScopeIds()).not.toContain(id);
    } finally {
      sweep.stop();
    }
  });
});

// Les deux régimes d'une commande : hors bac à sable (le périmètre tient ses
// processus : Job Object sous Windows, groupe et étiquette sous Unix), et dans
// le bac à sable de la plateforme quand cette machine en a un (le conteneur).
const unconfinedSandbox = createSandbox(null, { platform: 'linux', log: () => {} });
const regimes: [string, Sandbox][] = [
  ['without the sandbox', unconfinedSandbox],
  ...((await defaultSandbox().status()).state === 'available'
    ? ([['in the sandbox', defaultSandbox()]] as [string, Sandbox][])
    : []),
];

describe.each(regimes)(
  'every end of a job kills the detached process one of its commands left, %s (#750) @cap:executer-une-commande/moteur',
  (_regime, sandbox) => {
    const dir = mkdtempSync(join(tmpdir(), 'nodal-job-ends-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
    const node = process.execPath;
    writeFileSync(
      join(dir, 'daemon.cjs'),
      "const fs = require('fs'); fs.writeFileSync(process.argv[2], String(process.pid)); let n = 0; setInterval(() => fs.writeFileSync(process.argv[3], String(++n)), 100);\n",
    );
    // La commande lance le démon DÉTACHÉ (hors de son groupe, hors de son
    // arbre une fois sortie) et sort.
    writeFileSync(
      join(dir, 'spawner.cjs'),
      "require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'daemon.cjs'), process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' }).unref();\n",
    );
    writeFileSync(
      join(dir, 'probe.cjs'),
      "try { process.kill(Number(require('fs').readFileSync(process.argv[2], 'utf8')), 0); console.log('alive'); } catch { console.log('dead'); }\n",
    );

    /** Une commande du job, par le moteur des outils (run_command, preuves). */
    const command = (jobId: string, line: string) =>
      runShellCommand({
        target: { command: line },
        cwd: dir,
        timeoutMs: 30_000,
        env: buildChildEnv(process.env),
        confinement: { writableRoots: [dir] },
        scope: jobProcessScope(jobId, sandbox),
      });

    /** Commande 1 lance le démon ; commande 2 du même job le trouve vivant. */
    async function daemonOf(jobId: string): Promise<{ pid: number; counter: string }> {
      const pidFile = join(dir, `${jobId}.pid`);
      const counter = join(dir, `${jobId}.count`);
      const first = await command(jobId, `"${node}" spawner.cjs "${pidFile}" "${counter}"`);
      expect(first.outcome).toEqual({ kind: 'exit', exitCode: 0 });
      for (let i = 0; i < 200 && !(existsSync(pidFile) && existsSync(counter)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const second = await command(jobId, `"${node}" probe.cjs "${pidFile}"`);
      expect(second.stdout.trim()).toBe('alive');
      return { pid: Number(readFileSync(pidFile, 'utf8')), counter };
    }

    async function expectDead(d: { pid: number; counter: string }): Promise<void> {
      for (let i = 0; i < 100 && isProcessAlive(d.pid); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const alive = isProcessAlive(d.pid);
      if (alive) process.kill(d.pid);
      expect(alive).toBe(false);
      const frozen = readFileSync(d.counter, 'utf8');
      await new Promise((r) => setTimeout(r, 400));
      expect(readFileSync(d.counter, 'utf8')).toBe(frozen);
    }

    it.each(['completed', 'failed'])(
      'the job ends %s: the run that saw it end kills the daemon',
      async (end) => {
        const id = await job('processing');
        const d = await daemonOf(id);
        await db.update(agentJobs).set({ status: end }).where(eq(agentJobs.id, id));
        // Ce que `executeJob` appelle après chaque run.
        await releaseJobProcessesIfEnded(asDb(), id);
        await expectDead(d);
      },
      60_000,
    );

    it('Stop: the job is cancelled while suspended, the sweep kills the daemon', async () => {
      const id = await job('awaiting_approval');
      const d = await daemonOf(id);
      const sweep = startJobProcessSweep(asDb(), 50);
      try {
        await cancelJobTree(asDb() as unknown as Parameters<typeof cancelJobTree>[0], {
          entityId: seed.entityId,
          jobId: id,
        });
        await expectDead(d);
      } finally {
        sweep.stop();
      }
    }, 60_000);

    it('reclaimed: the job of a runner that stopped beating is failed, and its daemon dies', async () => {
      const id = await job('processing');
      const d = await daemonOf(id);
      // Plus aucun battement depuis 10 minutes, vu de « maintenant ».
      const result = await reclaimJobsOfDeadRunners(asDb(), {
        now: new Date(Date.now() + 10 * 60_000),
      });
      expect(result.reclaimed + result.resumed).toBeGreaterThanOrEqual(1);
      await expectDead(d);
    }, 60_000);
  },
);
