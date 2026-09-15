// delegation — does a delegated run actually DELIVER something?
//
// Online, and opt-in (`--online`). The reason it exists: issue #107. A sub-agent
// that signals `return_result{status:'success'}` without writing any text used
// to be finalized `completed` with an empty result; the orchestrator then read
// "(no output)" as an answer and told the user the work was under way. Nothing
// ever arrived. Unit tests prove the guard fires on a scripted model; only a
// real model, on the real agents, says how often the situation ARISES and how
// often a user ends up with words.
//
// Three numbers, no verdict:
//   - `parent_delivered_pct` — runs where the head job ended with a non-empty
//     result. This is what a user would have received.
//   - `child_delivered_pct`  — delegated sub-jobs that handed back a non-empty
//     deliverable. The number #107 is about.
//   - `empty_success_runs`   — runs that ended `completed` with nothing in them.
//     After the fix this should be 0 by construction: such a run is `failed`.
//
// Requires the stack to be up (`pnpm --filter nodal-agents exec tsx src/index.ts
// --dev`) and a real key configured for the agents. Every failure mode is loud:
// a missing config, an unreachable runner and an unknown agent each throw, and
// `runSections` records the section error rather than reporting a silent 0.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Metric, Section } from '../types';

/** The task replayed each run — the exact one from the incident (job f1852d35). */
const TASK = 'Fais une recherche sur la longueur de Planck';

const DEFAULT_RUNS = 5;
/** A delegated research run is slow; a real one has taken ~4 min end to end. */
const JOB_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 3_000;

interface LocalConfig {
  ports?: { web?: number; runner?: number; postgres?: number };
  workerSecret?: string;
  postgresPassword?: string;
}

function readLocalConfig(): LocalConfig {
  const path = join(homedir(), '.nodalai', 'config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Configuration locale introuvable (${path}) — la stack n'a jamais démarré ici.`,
    );
  }
  return JSON.parse(raw) as LocalConfig;
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface JobSnapshot {
  id: string;
  status: string;
  result: string;
  error: string | null;
  children: Array<{ status: string; result: string }>;
}

/**
 * Read a job and its children through the runner's own SQL handle.
 *
 * The runner exposes no job-read endpoint, and the dashboard is explicitly out
 * of scope for this measurement, so the bench queries the same Postgres the
 * runner writes. The driver stays behind `@nodal-agents/db` — the bench never
 * imports `pg`/`postgres` itself (architecture rule, `pnpm deps:check`).
 */
async function readJob(
  db: Awaited<ReturnType<typeof openDb>>['db'],
  jobId: string,
): Promise<JobSnapshot> {
  const { agentJobs, eq } = await import('@nodal-agents/db');
  const [row] = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      result: agentJobs.result,
      error: agentJobs.error,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} introuvable en base`);
  const kids = await db
    .select({ status: agentJobs.status, result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.parentJobId, jobId));
  return {
    id: row.id,
    status: row.status ?? 'unknown',
    result: row.result ?? '',
    error: row.error ?? null,
    children: kids.map((k) => ({ status: k.status ?? 'unknown', result: k.result ?? '' })),
  };
}

async function openDb() {
  const config = readLocalConfig();
  const port = config.ports?.postgres ?? 25444;
  const password = config.postgresPassword;
  if (!password) throw new Error('postgresPassword absent de ~/.nodalai/config.json');
  const url = `postgresql://nodalai:${encodeURIComponent(password)}@localhost:${port}/nodalai`;
  const { createClient } = await import('@nodal-agents/db');
  return createClient(url, { max: 2 });
}

async function startJob(runnerUrl: string, secret: string, agentSlug: string): Promise<string> {
  const res = await fetch(`${runnerUrl}/api/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ agentSlug, task: TASK, channel: 'api' }),
  });
  const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
  if (!res.ok || !body.jobId) {
    throw new Error(`POST /api/agent → ${res.status} ${body.error ?? '(corps illisible)'}`);
  }
  return body.jobId;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export const delegationSection: Section = {
  id: 'delegation',
  label: 'Contrat de délégation — livraison réelle',
  why: "Un sous-agent peut signaler « succès » sans rien produire ; le parent promet alors à l'utilisateur un résultat qui n'existera jamais.",
  tests: ['@nodal-agents/runner:src/tests/job/delegation-contract.test.ts'],

  async run(): Promise<Metric[]> {
    const runs = intFromEnv('BENCH_DELEGATION_RUNS', DEFAULT_RUNS);
    const agentSlug = process.env['BENCH_DELEGATION_AGENT'] ?? 'alfred';
    const config = readLocalConfig();
    const secret = config.workerSecret;
    if (!secret) throw new Error('workerSecret absent de ~/.nodalai/config.json');
    const runnerUrl =
      process.env['BENCH_RUNNER_URL'] ?? `http://127.0.0.1:${config.ports?.runner ?? 3001}`;

    const health = await fetch(`${runnerUrl}/api/health`).catch(() => null);
    if (!health?.ok) throw new Error(`Runner injoignable sur ${runnerUrl} — démarre la stack.`);

    const { db, close } = await openDb();
    const detail: string[] = [];
    let parentDelivered = 0;
    let emptySuccess = 0;
    let childTotal = 0;
    let childDelivered = 0;

    try {
      for (let i = 1; i <= runs; i++) {
        const jobId = await startJob(runnerUrl, secret, agentSlug);
        const deadline = Date.now() + JOB_TIMEOUT_MS;
        let snap = await readJob(db, jobId);
        while (!TERMINAL.has(snap.status) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          snap = await readJob(db, jobId);
        }
        const delivered = snap.result.trim().length > 0;
        if (delivered) parentDelivered += 1;
        if (snap.status === 'completed' && !delivered) emptySuccess += 1;
        for (const kid of snap.children) {
          childTotal += 1;
          if (kid.result.trim().length > 0) childDelivered += 1;
        }
        detail.push(
          `run ${i}: ${snap.status}` +
            `, parent ${snap.result.trim().length} car.` +
            `, ${snap.children.length} sous-job(s) [` +
            snap.children.map((k) => `${k.status}/${k.result.trim().length}c`).join(' ') +
            `]${snap.error ? ` — ${snap.error}` : ''} (${jobId.slice(0, 8)})`,
        );
      }
    } finally {
      await close();
    }

    const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 100));

    return [
      { id: 'runs', label: 'Runs mesurés', value: runs, unit: '', direction: 'exact' },
      {
        id: 'parent_delivered_pct',
        label: 'Jobs de tête avec un livrable non vide',
        value: pct(parentDelivered, runs),
        unit: '%',
        direction: 'higher-is-better',
        detail,
      },
      {
        id: 'child_delivered_pct',
        label: 'Sous-jobs délégués avec un livrable non vide',
        value: pct(childDelivered, childTotal),
        unit: '%',
        direction: 'higher-is-better',
        detail: [`${childDelivered}/${childTotal} sous-jobs`],
      },
      {
        id: 'empty_success_runs',
        label: 'Runs « completed » sans rien livrer',
        value: emptySuccess,
        unit: '',
        direction: 'lower-is-better',
      },
    ];
  },
};
