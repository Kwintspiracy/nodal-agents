// workflows/cli.ts — `pnpm bench:workflows`
//
//   pnpm bench:workflows                     le jeu de nuit (scénarios `nightly`), un essai chacun
//   pnpm bench:workflows --only question,file
//   pnpm bench:workflows --activity excel,word   tous les scénarios de ces activités
//   pnpm bench:workflows --set release       tous les scénarios, `on-demand` compris (sauf ceux qui envoient au propriétaire)
//   pnpm bench:workflows --only comfyui-telegram --allow-owner-sends
//                                            un scénario qui envoie AU PROPRIÉTAIRE : nommé, et ce drapeau
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
// qu'un essai n'est ni vert ni sauté, pour qu'une tâche planifiée le voie. Les
// essais eux-mêmes passent par session.ts, qui les joue dans l'espace banc et
// nulle part ailleurs (#769) : sans espace banc, la commande refuse et dit de
// lancer `pnpm bench:space sync --apply`.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { catalogText } from './catalog';
import { readTreeFacts } from './facts';
import { productToolJudgedBy, unverifiedOf } from './judge-kit';
import { BenchStop } from './lock';
import {
  formatPlan,
  parseModels,
  planMatrix,
  readPastLines,
  UNDECIDED_APPLIER,
  type MatrixModel,
} from './matrix';
import { CATALOG_FILE, REPO, RESULTS_FILE } from './paths';
import { redactHome } from './redact';
import { SCENARIOS, scenarioById } from './scenarios';
import { assertMatrixable, selectScenarios } from './selection';
import { readScenarioEnv, runBench } from './session';
import { cancelTree, openStackDb, readLiveBenchRoots } from './stack';
import type { AnyScenario, ScenarioEnv } from './types';

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
  return selectScenarios({
    only: list('only') ?? undefined,
    set: arg('set'),
    activity: list('activity') ?? undefined,
  });
}

function printList(): void {
  console.log('Workflow scenarios\n');
  for (const s of SCENARIOS) {
    console.log(
      `${s.id}  v${s.version}  [${s.activity} · ${s.set} · sends ${s.sends}]  timeout ${Math.round(s.timeoutMs / 60_000)} min${s.needs?.length ? `  needs ${s.needs.join(', ')}` : ''}`,
    );
    console.log(`  ${s.title}`);
    console.log(`  Green: ${s.green}`);
    // Le juge du scénario, puis les règles de chemin, comme le catalogue (catalog.ts).
    for (const j of [...s.judgedBy, ...productToolJudgedBy(s)]) console.log(`  Judged: ${j}`);
    for (const c of unverifiedOf(s)) {
      console.log(`  Not verified: ${c.check} (${c.ticket}): ${c.reason}`);
    }
    console.log(`  Request: ${s.instruction}\n`);
  }
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
      ? await readScenarioEnv(db, facts.entityId, startedMs)
      : {
          workspaceRoots: [],
          teamTools: [],
          unlistedMcpServers: [],
          benchPrinter: { kind: 'absent' },
          services: {},
          startedMs,
        };
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
  if (models) assertMatrixable(scenarios);
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
  if (models) await UNDECIDED_APPLIER.apply(models[0]!);

  const { db, close } = await openStackDb();
  // L'arrêt est partagé avec la session : plus aucun lancement une fois demandé,
  // le run_task en vol attendu (30 s au plus), PUIS le balayage des essais vivants.
  const stop = new BenchStop();
  const stopNow = async (signal: string): Promise<void> => {
    console.error(`\n${signal}: stopping the bench`);
    try {
      await stop.stop(
        null,
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
    await close();
    process.exit(130);
  };
  process.once('SIGINT', () => void stopNow('SIGINT'));
  process.once('SIGTERM', () => void stopNow('SIGTERM'));

  let summary: Awaited<ReturnType<typeof runBench>>;
  try {
    summary = await runBench(
      {
        scenarios,
        trials,
        trigger: flag('scheduled') ? 'scheduled' : 'manual',
        allowOwnerSends: flag('allow-owner-sends'),
        stackDir: resolve(arg('stack') ?? REPO),
      },
      db,
      stop,
      {
        log: (l) => console.log(l),
        trialEnd: (_s, _i, line) => console.log(JSON.stringify(line)),
      },
    );
  } finally {
    await close();
  }
  const { failed, skipped } = summary;
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
