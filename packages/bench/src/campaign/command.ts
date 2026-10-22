// campaign/command.ts — ce que `pnpm bench:campaign` fait, une fois le processus pointé sur la campagne.

import { readTreeFacts } from '../workflows/facts';
import { BenchStop } from '../workflows/lock';
import { formatPlan, parseModels, planMatrix, readPastLines } from '../workflows/matrix';
import { REPO, RESULTS_FILE } from '../workflows/paths';
import { assertMatrixable, selectScenarios } from '../workflows/selection';
import { runBench } from '../workflows/session';
import { cancelTree, openStackDb, readLiveBenchRoots } from '../workflows/stack';
import { configFingerprint, loadCampaignConfig } from './config';
import { campaignsRoot } from './home';
import { productCli, sweepLeftoverCampaigns, type LifecycleDeps } from './instance';
import { defaultKeysFile, readCampaignKeys } from './keys';
import { runCampaign } from './run';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
function list(name: string): string[] | undefined {
  const v = arg(name);
  return v === undefined
    ? undefined
    : v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
}

export async function runCommand(
  command: string,
  ctx: { id: string; baseEnv: Record<string, string | undefined> },
): Promise<void> {
  const config = loadCampaignConfig();
  const fingerprint = configFingerprint(config);
  const lifecycle: LifecycleDeps = {
    cli: productCli(REPO),
    baseEnv: ctx.baseEnv,
    log: (l) => console.log(l),
  };

  if (command === 'erase') {
    const erased = await sweepLeftoverCampaigns({
      ...lifecycle,
      stackDir: REPO,
      ports: config.instance.ports,
    });
    console.log(
      erased.length === 0
        ? `No campaign left behind under ${campaignsRoot()}.`
        : `Erased ${erased.length} campaign(s): ${erased.join(', ')}.`,
    );
    return;
  }

  const keys = readCampaignKeys(arg('keys') ?? defaultKeysFile(), config);
  if (command === 'check') {
    console.log(`Configuration ${fingerprint}: ${config.agents.length} agent(s), keys complete.`);
    return;
  }
  if (command !== 'run' && command !== 'rehearsal') {
    throw new Error(
      'usage: pnpm bench:campaign [check | rehearsal | erase] [--only …] [--models …] [--dry-run]',
    );
  }

  // La répétition : tout le cycle (démarrer, appliquer, vérifier l'équipe,
  // arrêter, effacer) et AUCUN essai, donc aucun appel de modèle.
  const scenarios =
    command === 'rehearsal'
      ? []
      : selectScenarios({ only: list('only'), set: arg('set'), activity: list('activity') });
  if (command === 'run' && scenarios.length === 0) {
    throw new Error('campaign_no_scenario: the selection is empty');
  }
  const trials = Number(arg('trials') ?? '1');
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) {
    throw new Error('--trials must be an integer from 1 to 20');
  }
  const modelsArg = arg('models');
  const models = modelsArg === undefined ? null : parseModels(modelsArg);
  if (models) assertMatrixable(scenarios);
  if (flag('dry-run')) {
    const plan = planMatrix(
      scenarios,
      models ?? [config.models.tested],
      trials,
      readPastLines().lines,
    );
    console.log(`Configuration ${fingerprint}. Nothing is started.\n`);
    console.log(formatPlan(plan, models ?? [config.models.tested]));
    return;
  }

  // Ctrl+C : plus aucun essai ne part, les essais vivants sont annulés par le
  // chemin du bouton Stop ; puis `runCampaign` arrête et efface l'instance.
  const stop = new BenchStop();
  const onSignal = (signal: string): void => {
    console.error(`\n${signal}: stopping the campaign, then erasing its Nodal`);
    void (async () => {
      const { db, close } = await openStackDb();
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
      } finally {
        await close();
      }
    })().catch((e: unknown) => console.error(String(e instanceof Error ? e.message : e)));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const { workspacesRoot, SHARED_WORKSPACE_LABEL } = await import('@nodal-agents/tools');
  const summary = await runCampaign(
    {
      id: ctx.id,
      config,
      keys,
      scenarios,
      trials,
      models,
      trigger: flag('scheduled') ? 'scheduled' : 'manual',
      stackDir: REPO,
    },
    {
      ...lifecycle,
      openDb: openStackDb,
      runBench,
      readFacts: readTreeFacts,
      folders: { workspacesRoot: workspacesRoot(), sharedLabel: SHARED_WORKSPACE_LABEL },
      stop,
    },
  );
  console.log(
    `\nCampaign ${summary.id} (configuration ${fingerprint}): ${summary.lines.length} trial(s), ` +
      `${summary.failed} not green, ${summary.skipped} skipped, $${summary.spentUsd} spent` +
      `${summary.stopReason ? `; stopped: ${summary.stopReason}` : ''}.\n` +
      `Results: ${RESULTS_FILE}\nEvidence: ${summary.evidenceDir}`,
  );
  process.exitCode = summary.failed === 0 ? 0 : 1;
}
