// workflows/cli.ts — `pnpm bench:workflows`
//
//   pnpm bench:workflows                     le jeu de nuit (scénarios `nightly`), un essai chacun
//   pnpm bench:workflows --only question,file
//   pnpm bench:workflows --activity excel,word   tous les scénarios de ces activités
//   pnpm bench:workflows --set release       tous les scénarios, `on-demand` compris
//   pnpm bench:workflows --trials 3          trois essais par scénario
//   pnpm bench:workflows --models a,b --dry-run   la matrice : le plan et son coût, sans rien lancer
//   pnpm bench:workflows --stack D:/APPS/NodalAI   la stack mesurée (défaut : ce dépôt)
//   pnpm bench:workflows --scheduled         posé par la tâche planifiée : la ligne le dit
//   pnpm bench:workflows --list              les scénarios et ce que « vert » veut dire
//   pnpm bench:workflows --catalog           réécrit apps/qa/data/workflow-catalog.json
//   pnpm bench:workflows --capture <jobId> --scenario <id> --out <f.json>
//                                            photographie un essai déjà joué (fixtures des tests)
//
// Chaque essai ajoute UNE ligne à apps/qa/data/workflows.ndjson (du dépôt qui
// lance la commande) ; le fichier n'est jamais réécrit. Code de sortie 1 dès
// qu'un essai n'est ni vert ni sauté, pour qu'une tâche planifiée le voie.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { z } from 'zod';
import { catalogText } from './catalog';
import { executeRows, readTreeFacts } from './facts';
import { BENCH_LOCK_FILE, BenchStop, claimStack, type BenchLock } from './lock';
import {
  formatPlan,
  parseModels,
  planMatrix,
  UNDECIDED_APPLIER,
  type MatrixModel,
  type PastLine,
} from './matrix';
import { startRunTask } from './mcp';
import { redactHome } from './redact';
import { SCENARIOS, scenarioById } from './scenarios';
import {
  cancelTree,
  openStackDb,
  probeService,
  readBenchConfig,
  readForeignActivity,
  readLiveBenchRoots,
  readRootModel,
  readStackCommit,
  readStackVersion,
  readTeamTools,
  readUnlistedMcpServers,
  readWorkspaceRoots,
} from './stack';
import { DEFAULT_TRIAL_OPTIONS, runTrial, type TrialDeps } from './trial';
import {
  ACTIVITIES,
  type AnyScenario,
  type ScenarioEnv,
  type ServiceProbe,
  type TrialLine,
} from './types';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const RESULTS_FILE = join(REPO, 'apps', 'qa', 'data', 'workflows.ndjson');
export const CATALOG_FILE = join(REPO, 'apps', 'qa', 'data', 'workflow-catalog.json');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function list(name: string): string[] | null {
  const v = arg(name);
  return v === undefined
    ? null
    : v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
}

function pickScenarios(): AnyScenario[] {
  const only = list('only');
  if (only) {
    const unknown = only.filter((id) => !scenarioById(id));
    if (unknown.length > 0) {
      throw new Error(
        `unknown scenario(s): ${unknown.join(', ')} — known: ${SCENARIOS.map((s) => s.id).join(', ')}`,
      );
    }
    return only.map((id) => scenarioById(id)!);
  }
  const set = arg('set') ?? 'nightly';
  if (set !== 'release' && set !== 'nightly')
    throw new Error(`unknown set ${set} — known: nightly, release`);
  const activities = list('activity');
  if (activities) {
    // Nommer une activité, c'est demander ses scénarios, `on-demand` compris.
    const unknown = activities.filter((a) => !(ACTIVITIES as readonly string[]).includes(a));
    if (unknown.length > 0)
      throw new Error(`unknown activity: ${unknown.join(', ')} — known: ${ACTIVITIES.join(', ')}`);
    return SCENARIOS.filter((s) => activities.includes(s.activity));
  }
  return set === 'release' ? [...SCENARIOS] : SCENARIOS.filter((s) => s.set === 'nightly');
}

function printList(): void {
  console.log('Workflow scenarios\n');
  for (const s of SCENARIOS) {
    console.log(
      `${s.id}  v${s.version}  [${s.activity} · ${s.set}]  timeout ${Math.round(s.timeoutMs / 60_000)} min${s.needs?.length ? `  needs ${s.needs.join(', ')}` : ''}`,
    );
    console.log(`  ${s.title}`);
    console.log(`  Green: ${s.green}`);
    for (const c of s.unverified ?? []) {
      console.log(`  Not verified: ${c.check} (${c.ticket}): ${c.reason}`);
    }
    console.log(`  Request: ${s.instruction}\n`);
  }
}

/** Les lignes passées, pour les médianes du plan. Une ligne illisible est comptée et dite. */
function readPastLines(): { lines: PastLine[]; unreadable: number } {
  if (!existsSync(RESULTS_FILE)) return { lines: [], unreadable: 0 };
  const lines: PastLine[] = [];
  let unreadable = 0;
  for (const raw of readFileSync(RESULTS_FILE, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as PastLine);
    } catch {
      unreadable++;
    }
  }
  return { lines, unreadable };
}

/**
 * L'espace que `run_task` vise : la même règle que le serveur MCP
 * (`resolveRootAgentId`) — l'unique espace qui a un agent racine. Plusieurs, ou
 * aucun : `run_task` refuserait aussi, on le dit avant.
 */
async function rootEntity(db: AnyDrizzleDb): Promise<string> {
  const { sql } = await import('@nodal-agents/db');
  const rows = z.array(z.object({ id: z.string() })).parse(
    await executeRows(
      db,
      sql`
        select id::text from entities where root_agent_id is not null`,
    ),
  );
  if (rows.length !== 1) {
    throw new Error(
      `workflow_no_root: ${rows.length} workspace(s) have a root agent; run_task needs exactly one`,
    );
  }
  return rows[0]!.id;
}

/** L'environnement d'un essai : dossiers de travail, outils de l'équipe, services déclarés et sondés. */
async function readEnv(
  db: AnyDrizzleDb,
  entityId: string,
  startedMs: number,
): Promise<ScenarioEnv> {
  const services: Record<string, ServiceProbe> = {};
  for (const [name, url] of Object.entries(readBenchConfig().services)) {
    services[name] = { url, problem: await probeService(url) };
  }
  return {
    workspaceRoots: await readWorkspaceRoots(db, entityId),
    teamTools: await readTeamTools(db, entityId),
    unlistedMcpServers: await readUnlistedMcpServers(db, entityId),
    services,
    startedMs,
  };
}

async function capture(): Promise<void> {
  const jobId = arg('capture');
  const id = arg('scenario');
  const out = arg('out');
  const s = id ? scenarioById(id) : undefined;
  if (!jobId || !s || !out)
    throw new Error('usage: --capture <jobId> --scenario <id> --out <file.json>');
  const { db, close } = await openStackDb();
  try {
    const facts = await readTreeFacts(db, jobId);
    const startedMs = Math.min(...facts.jobs.map((j) => j.createdMs)) - 5_000;
    const env: ScenarioEnv = facts.entityId
      ? await readEnv(db, facts.entityId, startedMs)
      : { workspaceRoots: [], teamTools: [], unlistedMcpServers: [], services: {}, startedMs };
    const observed = await s.observe(facts, env);
    const json = JSON.stringify({ scenario: s.id, version: s.version, facts, observed }, null, 1);
    writeFileSync(out, `${redactHome(json)}\n`);
    console.log(
      `captured ${jobId} (${facts.jobs.length} job(s), ${facts.toolCalls.length} tool call(s)) → ${out}`,
    );
    console.log(`verdict now: ${JSON.stringify(s.judge(facts, observed))}`);
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  if (flag('list')) return printList();
  if (flag('catalog')) {
    writeFileSync(CATALOG_FILE, catalogText(), 'utf8');
    console.log(`wrote ${CATALOG_FILE}`);
    return;
  }
  if (arg('capture')) return capture();

  const scenarios = pickScenarios();
  if (scenarios.length === 0) throw new Error('workflow_no_scenario: the selection is empty');
  const trials = Number(arg('trials') ?? '1');
  if (!Number.isInteger(trials) || trials < 1 || trials > 20)
    throw new Error('--trials must be an integer from 1 to 20');

  // La matrice : le plan d'abord ; jouer réellement attend une décision du
  // propriétaire (matrix.ts), et le banc le refuse AVANT de toucher la stack.
  const modelsArg = arg('models');
  const models: MatrixModel[] | null = modelsArg === undefined ? null : parseModels(modelsArg);
  if (models && flag('dry-run')) {
    const past = readPastLines();
    console.log(formatPlan(planMatrix(scenarios, models, trials, past.lines), models));
    if (past.unreadable > 0)
      console.log(
        `${past.unreadable} line(s) of ${RESULTS_FILE} could not be read and were left out.`,
      );
    return;
  }
  if (flag('dry-run')) throw new Error('--dry-run plans a model matrix: give --models too');
  const applier = UNDECIDED_APPLIER;
  if (models) await applier.apply(models[0]!);

  const stackDir = resolve(arg('stack') ?? REPO);
  const nodalVersion = readStackVersion(stackDir);
  // Douze caractères : sans ambiguïté dans ce dépôt, et une ligne qui porte à
  // la fois « …Tokens » et un sha complet de 40 caractères hexadécimaux est
  // prise pour une clé par la garde anti-secrets (scripts/check-no-secrets.mjs).
  const stackCommit = readStackCommit(stackDir)?.slice(0, 12) ?? null;
  // La configuration du banc est lue avant tout essai : mal formée, rien ne part.
  readBenchConfig();
  const { db, close } = await openStackDb();

  let lock: BenchLock | null = null;
  // L'arrêt est partagé avec la boucle : plus aucun lancement une fois demandé,
  // le run_task en vol attendu (30 s au plus), PUIS le balayage des essais vivants.
  const stop = new BenchStop();
  const stopNow = async (signal: string): Promise<void> => {
    console.error(`\n${signal}: stopping the bench`);
    try {
      await stop.stop(
        lock,
        {
          liveRoots: () => readLiveBenchRoots(db),
          cancel: (root) => cancelTree(db, root.entityId, root.id),
          log: (l) => console.error(l),
        },
        { waitMs: 30_000 },
      );
    } catch (e) {
      console.error(
        `could not cancel the bench trials still alive: ${String(e instanceof Error ? e.message : e)}. The next bench cancels them before it starts.`,
      );
    }
    lock?.release();
    await close();
    process.exit(130);
  };
  process.once('SIGINT', () => void stopNow('SIGINT'));
  process.once('SIGTERM', () => void stopNow('SIGTERM'));

  let failed = 0;
  let skipped = 0;
  try {
    // Un seul banc par stack : le verrou d'abord (un second banc refuse, en
    // disant qui le tient), puis les essais qu'un banc mort a laissés vivants.
    lock = await claimStack({
      lockPath: BENCH_LOCK_FILE,
      liveRoots: () => readLiveBenchRoots(db),
      cancel: (orphan) => cancelTree(db, orphan.entityId, orphan.id),
      log: (l) => console.log(l),
    });
    const entityId = await rootEntity(db);
    const deps: TrialDeps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      start: (instruction, caller) => stop.start(() => startRunTask(stackDir, instruction, caller)),
      read: (rootId) => readTreeFacts(db, rootId),
      cancel: (ent, rootId) => cancelTree(db, ent, rootId),
      foreign: () => readForeignActivity(db, DEFAULT_TRIAL_OPTIONS.chatQuietMs),
      env: (startedMs) => readEnv(db, entityId, startedMs),
      rootModel: () => readRootModel(db, entityId),
      log: (l) => console.log(l),
    };
    console.log(
      `Workflow bench — ${scenarios.length} scenario(s) × ${trials} · Nodal-Agents ${nodalVersion} @ ${stackCommit?.slice(0, 8) ?? 'unknown commit'} · ${stackDir}`,
    );
    mkdirSync(dirname(RESULTS_FILE), { recursive: true });
    for (const s of scenarios) {
      for (let i = 1; i <= trials; i++) {
        if (stop.stopped) break;
        console.log(`\n▶ ${s.id} v${s.version} [${s.activity}] (${i}/${trials})`);
        const line: TrialLine = await runTrial(s, deps, {
          ...DEFAULT_TRIAL_OPTIONS,
          trigger: flag('scheduled') ? 'scheduled' : 'manual',
          nodalVersion,
          stackCommit,
          modelUnderTest: null,
        });
        // Un essai coupé par l'arrêt ne mesure rien : pas de ligne.
        if (stop.stopped) break;
        appendFileSync(RESULTS_FILE, `${JSON.stringify(line)}\n`, 'utf8');
        console.log(JSON.stringify(line));
        if (line.verdict === 'skipped') skipped++;
        else if (line.verdict !== 'green') failed++;
      }
    }
  } finally {
    lock?.release();
    await close();
  }
  console.log(
    `\n${failed === 0 ? 'All green' : `${failed} trial(s) not green`}${skipped > 0 ? `, ${skipped} skipped` : ''}. Results: ${RESULTS_FILE}`,
  );
  // exitCode plutôt que exit() : sous Windows, sortir pendant que le pool et le
  // processus MCP se ferment fait avorter libuv (UV_HANDLE_CLOSING).
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
});
