// workflows/session.ts — une session du banc : des essais, l'un après l'autre, sur une stack.
//
// Le CLI (`pnpm bench:workflows`) et Bench Studio lancent les essais par CE
// code, et par aucun autre (règle 11) : le verrou d'un seul banc par stack, le
// ménage des essais qu'un banc mort a laissés vivants, l'espace que `run_task`
// vise, les dépendances réelles d'un essai, un `runTrial` par essai et une
// ligne ajoutée à workflows.ndjson. Chacun n'y ajoute que sa façon d'écouter
// (`SessionHooks`) : le terminal pour l'un, un flux d'événements pour l'autre.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { readTreeFacts } from './facts';
import { BENCH_LOCK_FILE, claimStack, type BenchLock, type BenchStop } from './lock';
import { startRunTask } from './mcp';
import { RESULTS_FILE } from './paths';
import {
  cancelTree,
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
import { DEFAULT_TRIAL_OPTIONS, runTrial, type TrialDeps, type TrialProgress } from './trial';
import type { AnyScenario, ScenarioEnv, ServiceProbe, TrialLine } from './types';

/**
 * L'espace que `run_task` vise : la même règle que le serveur MCP
 * (`resolveRootAgentId`), lue par la même fonction — l'unique espace dont une
 * personne est membre et qui a un agent racine. Plusieurs, ou aucun :
 * `run_task` refuserait aussi, on le dit avant.
 */
export async function rootEntity(db: AnyDrizzleDb): Promise<string> {
  const { listMemberWorkspaces } = await import('@nodal-agents/db');
  const rows = await listMemberWorkspaces(db, { withRootAgent: true });
  if (rows.length !== 1) {
    throw new Error(
      `workflow_no_root: ${rows.length} workspace(s) you are a member of have a root agent; run_task needs exactly one`,
    );
  }
  return rows[0]!.id;
}

/** L'environnement d'un essai : dossiers de travail, outils de l'équipe, services déclarés et sondés. */
export async function readScenarioEnv(
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

export interface BenchRun {
  readonly scenarios: readonly AnyScenario[];
  readonly trials: number;
  readonly trigger: TrialLine['trigger'];
  readonly allowOwnerSends: boolean;
  /** Le dossier de la stack mesurée (sa version, son commit, `nodal-agents mcp serve`). */
  readonly stackDir: string;
}

/** Ce qu'une session dit à qui l'écoute. Tout est facultatif sauf `log`. */
export interface SessionHooks {
  log(line: string): void;
  trialStart?(s: AnyScenario, index: number, total: number): void;
  progress?(s: AnyScenario, index: number, event: TrialProgress): void;
  trialEnd?(s: AnyScenario, index: number, line: TrialLine): void;
}

export interface SessionSummary {
  readonly lines: TrialLine[];
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Joue une session sur la base `db`. `stop` est l'arrêt partagé : une fois
 * demandé, plus aucun essai ne part, et un essai coupé n'écrit pas de ligne.
 */
export async function runBench(
  run: BenchRun,
  db: AnyDrizzleDb,
  stop: BenchStop,
  hooks: SessionHooks,
): Promise<SessionSummary> {
  const nodalVersion = readStackVersion(run.stackDir);
  // Douze caractères : sans ambiguïté dans ce dépôt, et une ligne qui porte à
  // la fois « …Tokens » et un sha complet de 40 caractères hexadécimaux est
  // prise pour une clé par la garde anti-secrets (scripts/check-no-secrets.mjs).
  const stackCommit = readStackCommit(run.stackDir)?.slice(0, 12) ?? null;
  // La configuration du banc est lue avant tout essai : mal formée, rien ne part.
  readBenchConfig();

  let lock: BenchLock | null = null;
  const lines: TrialLine[] = [];
  let failed = 0;
  let skipped = 0;
  try {
    // Un seul banc par stack : le verrou d'abord (un second banc refuse, en
    // disant qui le tient), puis les essais qu'un banc mort a laissés vivants.
    lock = await claimStack({
      lockPath: BENCH_LOCK_FILE,
      liveRoots: () => readLiveBenchRoots(db),
      cancel: (orphan) => cancelTree(db, orphan.entityId, orphan.id),
      log: (l) => hooks.log(l),
    });
    stop.hold(lock);
    const entityId = await rootEntity(db);
    hooks.log(
      `Workflow bench — ${run.scenarios.length} scenario(s) × ${run.trials} · Nodal-Agents ${nodalVersion} @ ${stackCommit?.slice(0, 8) ?? 'unknown commit'} · ${run.stackDir}`,
    );
    mkdirSync(dirname(RESULTS_FILE), { recursive: true });
    const total = run.scenarios.length * run.trials;
    let index = 0;
    for (const s of run.scenarios) {
      for (let i = 1; i <= run.trials; i++) {
        if (stop.stopped) break;
        index++;
        const at = index;
        hooks.log(`\n▶ ${s.id} v${s.version} [${s.activity}] (${i}/${run.trials})`);
        hooks.trialStart?.(s, at, total);
        const deps: TrialDeps = {
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          start: (instruction, caller) =>
            stop.start(() => startRunTask(run.stackDir, instruction, caller)),
          read: (rootId) => readTreeFacts(db, rootId),
          cancel: (ent, rootId) => cancelTree(db, ent, rootId),
          foreign: () => readForeignActivity(db, DEFAULT_TRIAL_OPTIONS.chatQuietMs),
          env: (startedMs) => readScenarioEnv(db, entityId, startedMs),
          rootModel: () => readRootModel(db, entityId),
          log: (l) => hooks.log(l),
          progress: (e) => hooks.progress?.(s, at, e),
        };
        const line = await runTrial(s, deps, {
          ...DEFAULT_TRIAL_OPTIONS,
          trigger: run.trigger,
          nodalVersion,
          stackCommit,
          modelUnderTest: null,
          allowOwnerSends: run.allowOwnerSends,
        });
        // Un essai coupé par l'arrêt ne mesure rien : pas de ligne.
        if (stop.stopped) break;
        appendFileSync(RESULTS_FILE, `${JSON.stringify(line)}\n`, 'utf8');
        lines.push(line);
        hooks.trialEnd?.(s, at, line);
        if (line.verdict === 'skipped') skipped++;
        else if (line.verdict !== 'green') failed++;
      }
    }
  } finally {
    lock?.release();
  }
  return { lines, failed, skipped };
}
