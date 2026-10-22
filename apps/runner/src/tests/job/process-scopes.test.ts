// process-scopes.test.ts — QUAND le périmètre d'un job se ferme (#628) : à la
// fin du job, quelle qu'elle soit, et jamais avant. Sur la vraie table
// `agent_jobs`. La mort réelle des processus : de bout en bout par
// run-command-flow.test.ts, et ici, pour CHAQUE fin (#750) — terminé, échoué,
// arrêté, repris d'un runner mort —, sur un démon détaché qu'une commande a
// laissé derrière elle.
//
// Mutations vérifiées (chacune annulée ensuite), sur `takeLostRun`, la règle
// des faucheurs :
//   - la libération retirée → « reclaimed » rouge, le démon survit ;
//   - la prise sans ses conditions (statut, prise, ancienneté : la libération
//     par seul identifiant de job) → les quatre cas « came back to life »
//     rouges, la commande du run revenu meurt ;
//   - la remise en file AVANT la prise et la libération → « the resumed run's
//     command … survives » rouge.

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
  closeJobProcessScope,
  createSandbox,
  defaultSandbox,
  detachedDescendantsReachable,
  isProcessAlive,
  type Sandbox,
  jobProcessScope,
  openJobProcessScopeIds,
} from '@nodal-agents/sandbox';
import { COUNTER_DAEMON_SOURCE, counterRise, readCounter } from '@nodal-agents/test-kit';
import { reclaimJobsOfDeadRunners } from '../../cron/reclaim-jobs.ts';
import { failStalePendingJobs, resetOrphanedJobs } from '../../cron/reset-orphans.ts';
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
//
// Et deux formes de ce que la commande laisse : dans le GROUPE de la commande
// (chaque OS), ou DÉTACHÉ d'elle (sa propre session sous Unix). Hors bac à
// sable, la forme détachée n'est tenue que là où le système retrouve un
// descendant détaché (`detachedDescendantsReachable` : Windows, Linux ; pas
// macOS, limite dite dans unix-job-processes.ts) : ailleurs le cas est SAUTÉ,
// la raison au titre, jamais rouge. Dans le conteneur, les deux formes le sont.
const unconfinedSandbox = createSandbox(null, { platform: 'linux', log: () => {} });
const sandboxAvailable = (await defaultSandbox().status()).state === 'available';
const reachable = detachedDescendantsReachable();
type Shape = 'group' | 'detached';
const cases: [string, Sandbox, Shape, boolean][] = [
  ['without the sandbox, in its command’s group', unconfinedSandbox, 'group', true],
  [
    reachable
      ? 'without the sandbox, detached from its command'
      : 'without the sandbox, detached from its command: SKIPPED, this platform cannot find a detached descendant (macOS: no /proc, stated limit)',
    unconfinedSandbox,
    'detached',
    reachable,
  ],
  ...(sandboxAvailable
    ? ([
        ['in the sandbox, in its command’s group', defaultSandbox(), 'group', true],
        ['in the sandbox, detached from its command', defaultSandbox(), 'detached', true],
      ] as [string, Sandbox, Shape, boolean][])
    : []),
];

describe.each(cases)(
  'every end of a job kills the process one of its commands left running, %s (#750) @cap:executer-une-commande/moteur',
  (_label, sandbox, shape, enabled) => {
    const dir = mkdtempSync(join(tmpdir(), 'nodal-job-ends-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
    const node = process.execPath;
    // `daemon.cjs <compteur> <pid>` (test-kit counter-process.ts).
    writeFileSync(join(dir, 'daemon.cjs'), COUNTER_DAEMON_SOURCE);
    // La commande lance le démon et sort. `detached` : sa propre session sous
    // Unix. `group` : le groupe de la commande (sous Windows détaché de
    // l'arbre quand même : un enfant non détaché meurt avec le job Node de
    // son parent).
    writeFileSync(
      join(dir, 'spawner.cjs'),
      "const detached = process.argv[4] === 'detached' || process.platform === 'win32'; require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'daemon.cjs'), process.argv[3], process.argv[2]], { detached, stdio: 'ignore' }).unref();\n",
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
      const first = await command(
        jobId,
        `"${node}" spawner.cjs "${pidFile}" "${counter}" ${shape}`,
      );
      expect(first.outcome).toEqual({ kind: 'exit', exitCode: 0 });
      for (let i = 0; i < 200 && !(existsSync(pidFile) && existsSync(counter)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const second = await command(jobId, `"${node}" probe.cjs "${pidFile}"`);
      expect(second.stdout.trim()).toBe('alive');
      return { pid: readCounter(pidFile), counter };
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

    (enabled ? it : it.skip).each(['completed', 'failed'])(
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

    it.runIf(enabled)(
      'Stop: the job is cancelled while suspended, the sweep kills the daemon',
      async () => {
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
      },
      60_000,
    );

    it.runIf(enabled)(
      'reclaimed: the job of a runner that stopped beating is failed, and its daemon dies',
      async () => {
        const id = await job('processing');
        const d = await daemonOf(id);
        // Plus aucun battement depuis 10 minutes, vu de « maintenant ».
        const result = await reclaimJobsOfDeadRunners(asDb(), {
          now: new Date(Date.now() + 10 * 60_000),
        });
        expect(result.reclaimed + result.resumed).toBeGreaterThanOrEqual(1);
        await expectDead(d);
      },
      60_000,
    );
  },
);

// #834, revue A passe 1 (P2-1) : un job REPRIS d'un runner mort repasse en
// `pending`, et un worker peut le prendre dès cet instant. Les processus du
// run perdu doivent être libérés AVANT que la ligne redevienne prenable —
// sinon la libération tue ceux du NOUVEAU run. Ce qui se prouve : une commande
// que le run repris lance juste après la bascule survit à la reprise.
describe('a lost job releases its processes before the row can be claimed again (#750) @cap:executer-une-commande/moteur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-job-resume-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  // `ticker.cjs <compteur> <pid>` (test-kit counter-process.ts).
  writeFileSync(join(dir, 'ticker.cjs'), COUNTER_DAEMON_SOURCE);

  /**
   * La base telle que la reprise la voit, avec un geste glissé juste APRÈS
   * l'écriture qui rend le job à la file (`status: 'pending'`) : ce qu'un
   * worker ferait en le prenant à cet instant.
   */
  function withHookAfterResumeFlip(real: TestDb, hook: () => Promise<void>): TestDb {
    const afterAwait = <T extends object>(obj: T): T =>
      new Proxy(obj, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop === 'then' && typeof value === 'function') {
            return (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
              (value as (a: (v: unknown) => unknown) => Promise<unknown>)
                .call(target, async (v: unknown) => {
                  await hook();
                  return v;
                })
                .then(onOk, onErr);
          }
          if (typeof value === 'function') {
            return (...args: unknown[]) => {
              const out = (value as (...a: unknown[]) => unknown).apply(target, args);
              return out && typeof out === 'object' ? afterAwait(out) : out;
            };
          }
          return value;
        },
      });
    return new Proxy(real, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop !== 'update' || typeof value !== 'function') {
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        }
        return (table: unknown) => {
          const builder = (value as (t: unknown) => { set: (v: unknown) => object }).call(
            target,
            table,
          );
          const set = builder.set.bind(builder);
          builder.set = (values: unknown) => {
            const next = set(values);
            return (values as { status?: string }).status === 'pending' ? afterAwait(next) : next;
          };
          return builder;
        };
      },
    });
  }

  it('the resumed run’s command, started right after the row went back to pending, survives the reclaim', async () => {
    const [row] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: 't',
        status: 'processing',
        turn: 3,
        messages: [{ role: 'user', content: 't' }],
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning({ id: agentJobs.id });
    const id = row!.id;
    const counter = join(dir, `${id}.count`);
    const pidFile = join(dir, `${id}.pid`);
    let started: Awaited<ReturnType<ReturnType<typeof jobProcessScope>['startOwned']>> | null =
      null;
    try {
      const reprise = await reclaimJobsOfDeadRunners(
        withHookAfterResumeFlip(db, async () => {
          if (started) return;
          // Le nouveau run du job lance sa première commande.
          started = await jobProcessScope(id, unconfinedSandbox).startOwned({
            target: { file: process.execPath, args: [join(dir, 'ticker.cjs'), counter, pidFile] },
            cwd: dir,
            env: buildChildEnv(process.env),
          });
          started.stdout?.resume();
          started.stderr?.resume();
          for (let i = 0; i < 100 && !(existsSync(counter) && existsSync(pidFile)); i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }) as unknown as Parameters<typeof reclaimJobsOfDeadRunners>[0],
      );
      expect(reprise.resumedJobIds).toContain(id);
      expect(started).not.toBeNull();
      // Elle tourne encore : son compteur monte après la reprise.
      const before = readCounter(counter);
      const rise = await counterRise(counter, before, { pid: readCounter(pidFile) });
      expect(rise.value, rise.why).toBeGreaterThan(before);
      expect(openJobProcessScopeIds()).toContain(id);
    } finally {
      await closeJobProcessScope(id);
    }
  }, 60_000);
});

// #834, revue A passe 2 : la libération et la décision « ce run est perdu »
// sont UN seul fait. Un faucheur lit ses candidats, puis — avant d'écrire — le
// run qu'il croyait perdu repart (il se remet en file, il se suspend, un
// worker le prend) : rien de ce run ne doit mourir, et la ligne reste ce que
// le run en a fait. Chaque chemin de faucheur, une règle.
describe('a reaper whose candidate came back to life releases nothing and writes nothing (#750) @cap:executer-une-commande/moteur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-job-alive-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  // `ticker.cjs <compteur> <pid>` (test-kit counter-process.ts).
  writeFileSync(join(dir, 'ticker.cjs'), COUNTER_DAEMON_SOURCE);

  /** La base, avec un geste glissé juste après la PREMIÈRE lecture du faucheur (ses candidats). */
  function withHookAfterFirstRead(real: TestDb, hook: () => Promise<void>): TestDb {
    let fired = false;
    const afterAwait = <T extends object>(obj: T): T =>
      new Proxy(obj, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop === 'then' && typeof value === 'function') {
            return (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
              (value as (a: (v: unknown) => unknown) => Promise<unknown>)
                .call(target, async (v: unknown) => {
                  if (!fired) {
                    fired = true;
                    await hook();
                  }
                  return v;
                })
                .then(onOk, onErr);
          }
          if (typeof value === 'function') {
            return (...args: unknown[]) => {
              const out = (value as (...a: unknown[]) => unknown).apply(target, args);
              return out && typeof out === 'object' ? afterAwait(out) : out;
            };
          }
          return value;
        },
      });
    return new Proxy(real, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        if (prop !== 'select' || fired) return (value as () => unknown).bind(target);
        return (...args: unknown[]) =>
          afterAwait((value as (...a: unknown[]) => object).apply(target, args));
      },
    });
  }

  const stale = (): Date => new Date(Date.now() - 10 * 60_000);

  const cases: {
    name: string;
    row: { status: string; turn: number };
    /** Ce que le run, vivant, fait de sa ligne entre la lecture et l'écriture. */
    comesBack: Record<string, unknown>;
    reap: (d: TestDb) => Promise<unknown>;
  }[] = [
    {
      name: 'reclaimJobsOfDeadRunners, a job it would resume: the run suspends for an approval',
      row: { status: 'processing', turn: 3 },
      comesBack: { status: 'awaiting_approval' },
      reap: (d) =>
        reclaimJobsOfDeadRunners(d as unknown as Parameters<typeof reclaimJobsOfDeadRunners>[0]),
    },
    {
      name: 'reclaimJobsOfDeadRunners, a job it would fail: the run self-chains back to pending',
      row: { status: 'processing', turn: 0 },
      comesBack: { status: 'pending' },
      reap: (d) =>
        reclaimJobsOfDeadRunners(d as unknown as Parameters<typeof reclaimJobsOfDeadRunners>[0]),
    },
    {
      name: 'resetOrphanedJobs: the run suspends for an approval',
      row: { status: 'processing', turn: 0 },
      comesBack: { status: 'awaiting_approval' },
      reap: (d) => resetOrphanedJobs(d as unknown as Parameters<typeof resetOrphanedJobs>[0]),
    },
    {
      name: 'failStalePendingJobs: a worker claims the pending job',
      row: { status: 'pending', turn: 0 },
      comesBack: { status: 'processing', claimGeneration: 7 },
      reap: (d) => failStalePendingJobs(d as unknown as Parameters<typeof failStalePendingJobs>[0]),
    },
  ];

  it.each(cases)(
    '$name: its command survives, its row is untouched',
    async (c) => {
      const [row] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'internal',
          task: 't',
          status: c.row.status,
          turn: c.row.turn,
          messages: [{ role: 'user', content: 't' }],
          updatedAt: stale(),
        })
        .returning({ id: agentJobs.id });
      const id = row!.id;
      const counter = join(dir, `${id}.count`);
      const pidFile = join(dir, `${id}.pid`);
      // La commande que le run, vivant, fait tourner.
      const running = await jobProcessScope(id, unconfinedSandbox).startOwned({
        target: { file: process.execPath, args: [join(dir, 'ticker.cjs'), counter, pidFile] },
        cwd: dir,
        env: buildChildEnv(process.env),
      });
      running.stdout?.resume();
      running.stderr?.resume();
      for (let i = 0; i < 100 && !(existsSync(counter) && existsSync(pidFile)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        await c.reap(
          withHookAfterFirstRead(db, async () => {
            // Le run repart, sa ligne toujours vieille (son battement a raté).
            await db
              .update(agentJobs)
              .set({ ...c.comesBack, updatedAt: stale() })
              .where(eq(agentJobs.id, id));
          }),
        );
        const before = readCounter(counter);
        const rise = await counterRise(counter, before, { pid: readCounter(pidFile) });
        expect(rise.value, rise.why).toBeGreaterThan(before);
        const [after] = await db
          .select({ status: agentJobs.status })
          .from(agentJobs)
          .where(eq(agentJobs.id, id));
        expect(after?.status).toBe(c.comesBack['status']);
      } finally {
        running.kill();
        await closeJobProcessScope(id);
      }
    },
    60_000,
  );
});
