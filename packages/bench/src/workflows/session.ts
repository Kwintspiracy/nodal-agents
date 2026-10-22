// workflows/session.ts — une session du banc : des essais, l'un après l'autre, sur une stack.
//
// Le CLI (`pnpm bench:workflows`, et sa tâche planifiée) lance les essais par
// CE code, et par aucun autre (règle 11) : la cible des essais, le verrou d'un
// seul banc par stack, le ménage des essais qu'un banc mort a laissés vivants,
// les dépendances réelles d'un essai, un `runTrial` par essai et une ligne
// ajoutée à workflows.ndjson.
//
// La cible est résolue UNE fois, au début de la session (`resolveBenchTarget` :
// l'espace banc et son agent racine, jamais l'espace du propriétaire, #769).
// Cette seule résolution pilote l'agent que chaque `run_task` vise, l'espace que
// le juge lit (environnement, modèle du root, livrables), et la vérification
// faite après chaque `run_task` : un job créé ailleurs est annulé, et l'essai
// échoue en le disant. Avant chaque essai, le contrôle structurel de l'espace
// (`assertSpaceCannotSend`) doit passer, sinon l'essai ne démarre pas.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { readTreeFacts } from './facts';
import { BENCH_LOCK_FILE, claimStack, type BenchLock, type BenchStop } from './lock';
import { startRunTask } from './mcp';
import { assertSpaceCannotSend, type AllowedReach } from '../space/guard';
import {
  jobOffTarget,
  readJobPlacement,
  resolveBenchTarget,
  resolveWorkspaceTarget,
  type BenchTarget,
} from '../space/space';
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
  readBenchPrinter,
  readTeamMcpServers,
  readTeamTools,
  readUnlistedMcpServers,
  readWorkspaceRoots,
} from './stack';
import { readResearchSubjects } from './subjects';
import { DEFAULT_TRIAL_OPTIONS, runTrial, type TrialDeps, type TrialProgress } from './trial';
import { probeReachablePrinters } from './printers';
import type { AnyScenario, PrinterReach, ScenarioEnv, ServiceProbe, TrialLine } from './types';

/** L'environnement d'un essai : dossiers de travail, outils de l'équipe, services déclarés et sondés. */
export async function readScenarioEnv(
  db: AnyDrizzleDb,
  entityId: string,
  startedMs: number,
  opts: {
    readonly benchPrinterRecordsDir?: string;
    /** Ce que la sonde des imprimantes a compté pour cet essai ; absent : pas sondé. */
    readonly reachablePrinters?: PrinterReach;
  } = {},
): Promise<ScenarioEnv> {
  const services: Record<string, ServiceProbe> = {};
  for (const [name, url] of Object.entries(readBenchConfig().services)) {
    services[name] = { url, problem: await probeService(url) };
  }
  return {
    workspaceRoots: await readWorkspaceRoots(db, entityId),
    teamTools: await readTeamTools(db, entityId),
    unlistedMcpServers: await readUnlistedMcpServers(db, entityId),
    benchPrinter: await readBenchPrinter(db, entityId, opts.benchPrinterRecordsDir ?? null),
    teamMcpServers: await readTeamMcpServers(db, entityId),
    reachablePrinters: opts.reachablePrinters ?? { kind: 'not-probed' },
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
  /**
   * Ce qu'une campagne (campaign/run.ts) précise ; absent, la session joue
   * dans l'espace banc de la stack, comme avant.
   *  - `targetEntityId` : l'espace testé de l'instance jetable, au lieu de
   *    l'espace banc retrouvé par son slug ; la même validation de la racine ;
   *  - `allowedReach` : les outils sortants que la configuration déclare
   *    (lecture seule), que le contrôle d'avant essai nomme sans refuser ;
   *  - `childEnv` : l'environnement de départ du `mcp serve` de chaque essai ;
   *  - `modelUnderTest`, `campaign`, `configFingerprint` : portés par chaque ligne.
   * Le plafond de coût d'un essai n'est pas ici : c'est le budget de run de
   * l'espace, que le RUNNER tient sur tout l'arbre de délégation
   * (apps/runner/src/job/run-budget.ts), et que la campagne pose avant chaque
   * essai (`beforeTrial`).
   */
  readonly targetEntityId?: string;
  readonly allowedReach?: readonly AllowedReach[];
  readonly childEnv?: Readonly<Record<string, string | undefined>>;
  readonly modelUnderTest?: string | null;
  readonly campaign?: string | null;
  readonly configFingerprint?: string | null;
  /**
   * Le dossier d'enregistrements que le banc a donné à l'imprimante de l'instance,
   * quand il le sait : la déclaration de l'imprimante doit le porter.
   */
  readonly benchPrinterRecordsDir?: string;
  /**
   * Compte les imprimantes qu'une commande de l'instance peut joindre (besoin
   * `no-real-printer`) ; défaut : la sonde par le vrai `run_command`
   * (`probeReachablePrinters`). Lancée une fois par essai qui déclare le
   * besoin, avant lui, et par aucun autre.
   */
  readonly probePrinters?: () => Promise<PrinterReach>;
}

/** Ce qu'une session dit à qui l'écoute. Tout est facultatif sauf `log`. */
export interface SessionHooks {
  log(line: string): void;
  trialStart?(s: AnyScenario, index: number, total: number): void;
  progress?(s: AnyScenario, index: number, event: TrialProgress): void;
  trialEnd?(s: AnyScenario, index: number, line: TrialLine): void;
  /**
   * Avant chaque essai, avant même le contrôle d'avant essai : la campagne y
   * remet l'instance à son état de départ et y pose le budget. Une erreur
   * arrête la session : aucun essai ne part sur un état inconnu.
   */
  beforeTrial?(s: AnyScenario, index: number): Promise<void>;
  /**
   * Après chaque essai, sa ligne écrite : la campagne y exporte les preuves et
   * compte la dépense. `'stop'` : plus aucun essai ne part (le plafond de la
   * campagne est atteint) ; une erreur arrête la session aussi.
   */
  afterTrial?(s: AnyScenario, index: number, line: TrialLine): Promise<'continue' | 'stop'>;
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

  // La cible d'abord, et une seule fois : sans espace banc, la session refuse
  // AVANT de toucher quoi que ce soit (ni verrou, ni ménage, ni essai).
  const target =
    run.targetEntityId === undefined
      ? await resolveBenchTarget(db)
      : await resolveWorkspaceTarget(
          db,
          run.targetEntityId,
          "The campaign's applier sets the root; apply the configuration again.",
        );

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
    hooks.log(
      `Workflow bench — ${run.scenarios.length} scenario(s) × ${run.trials} · Nodal-Agents ${nodalVersion} @ ${stackCommit?.slice(0, 8) ?? 'unknown commit'} · ${run.stackDir} · bench space ${target.entityId} (root ${target.rootAgentSlug})`,
    );
    mkdirSync(dirname(RESULTS_FILE), { recursive: true });
    const total = run.scenarios.length * run.trials;
    let index = 0;
    let halted = false;
    for (const s of run.scenarios) {
      if (halted) break;
      for (let i = 1; i <= run.trials; i++) {
        if (stop.stopped) break;
        index++;
        const at = index;
        hooks.log(`\n▶ ${s.id} v${s.version} [${s.activity}] (${i}/${run.trials})`);
        await hooks.beforeTrial?.(s, at);
        hooks.trialStart?.(s, at, total);
        // La sonde des imprimantes, pour un essai qui la demande seulement : une
        // fois, avant lui ; le jugement d'après relit le même compte.
        let printers: Promise<PrinterReach> | undefined;
        const reachablePrinters = (s.needs ?? []).includes('no-real-printer')
          ? () => (printers ??= (run.probePrinters ?? probeReachablePrinters)())
          : null;
        const deps: TrialDeps = {
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          start: (instruction, caller) =>
            stop.start(() => startOnTarget(db, run, instruction, caller, target)),
          read: (rootId) => readTreeFacts(db, rootId),
          cancel: (ent, rootId) => cancelTree(db, ent, rootId),
          foreign: () => readForeignActivity(db, DEFAULT_TRIAL_OPTIONS.chatQuietMs),
          env: async (startedMs) =>
            readScenarioEnv(db, target.entityId, startedMs, {
              ...(run.benchPrinterRecordsDir
                ? { benchPrinterRecordsDir: run.benchPrinterRecordsDir }
                : {}),
              ...(reachablePrinters ? { reachablePrinters: await reachablePrinters() } : {}),
            }),
          rootModel: () => readRootModel(db, target.entityId),
          subjects: () => readResearchSubjects(),
          log: (l) => hooks.log(l),
          progress: (e) => hooks.progress?.(s, at, e),
        };
        const line = await runTrial(s, deps, {
          ...DEFAULT_TRIAL_OPTIONS,
          trigger: run.trigger,
          nodalVersion,
          stackCommit,
          modelUnderTest: run.modelUnderTest ?? null,
          allowOwnerSends: run.allowOwnerSends,
          campaign: run.campaign ?? null,
          configFingerprint: run.configFingerprint ?? null,
        });
        // Un essai coupé par l'arrêt ne mesure rien : pas de ligne.
        if (stop.stopped) break;
        appendFileSync(RESULTS_FILE, `${JSON.stringify(line)}\n`, 'utf8');
        lines.push(line);
        hooks.trialEnd?.(s, at, line);
        if (line.verdict === 'skipped') skipped++;
        else if (line.verdict !== 'green') failed++;
        if ((await hooks.afterTrial?.(s, at, line)) === 'stop') {
          halted = true;
          break;
        }
      }
    }
  } finally {
    lock?.release();
  }
  return { lines, failed, skipped };
}

/**
 * Un essai démarre sur la cible, et seulement là : le contrôle structurel de
 * l'espace d'abord (rien ne part s'il échoue), puis `run_task` épinglé et
 * nommé sur la racine de l'espace banc, puis la place réelle du job créé. Un
 * job créé ailleurs est annulé et l'essai échoue avec la raison : jamais un
 * essai joué hors de l'espace banc.
 */
async function startOnTarget(
  db: AnyDrizzleDb,
  run: BenchRun,
  instruction: string,
  caller: string,
  target: BenchTarget,
): Promise<{ jobId: string; close(): Promise<void> }> {
  await assertSpaceCannotSend(db, target.entityId, run.allowedReach ?? []);
  const session = await startRunTask(
    run.stackDir,
    instruction,
    caller,
    target,
    // La commande par défaut (`mcp serve` du dépôt de la stack).
    undefined,
    run.childEnv ?? process.env,
  );
  const job = await readJobPlacement(db, session.jobId);
  const off = jobOffTarget(session.jobId, job, target);
  if (off !== null) {
    try {
      if (job?.entityId) await cancelTree(db, job.entityId, session.jobId);
    } finally {
      await session.close();
    }
    throw new Error(off);
  }
  return session;
}
