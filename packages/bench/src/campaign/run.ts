// campaign/run.ts — une campagne, de bout en bout.
//
//   balayer les campagnes mortes → créer le dossier → démarrer l'instance →
//   appliquer la configuration → vérifier l'équipe → pour chaque modèle :
//   (remettre à zéro → poser le budget → un essai → exporter ses preuves) ×N →
//   résumé → arrêter → effacer.
//
// Les essais passent par la session du banc (workflows/session.ts) et par
// aucun autre chemin (règle 11) : la même cible épinglée, le même contrôle
// d'avant essai, le même juge. Ce que la campagne ajoute passe par ses
// crochets (`beforeTrial`, `afterTrial`) et sa cible (`targetEntityId`).
//
// QUOI QU'IL ARRIVE, l'instance est arrêtée et effacée (`finally`) : une
// erreur, un plafond atteint, Ctrl+C. Un banc tué net ne passe pas par là ;
// la campagne suivante efface alors ce qu'il a laissé avant de commencer
// (instance.ts, `sweepLeftoverCampaigns`).

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { Sandbox } from '@nodal-agents/sandbox';
import { mcpToolPrefix } from '@nodal-agents/shared';
import { BenchStop } from '../workflows/lock';
import { modelKey, type MatrixModel } from '../workflows/matrix';
import type { BenchRun, SessionHooks, SessionSummary } from '../workflows/session';
import type { TreeFacts } from '../workflows/facts';
import { probeReachablePrinters } from '../workflows/printers';
import type { AnyScenario, PrinterReach, TrialLine } from '../workflows/types';
import type { AllowedReach } from '../space/guard';
import {
  applyCampaignConfig,
  runnerSkillInstaller,
  type AppliedCampaign,
  type ApplyDeps,
} from './apply';
import { CampaignBudget } from './budget';
import { configFingerprint, type CampaignConfig } from './config';
import { campaignEvidenceDir, exportInstanceLogs, exportSummary, exportTrial } from './export';
import { describeError } from './home';
import {
  campaignEnv,
  createInstanceFiles,
  eraseInstance,
  instancePaths,
  instanceSandboxEnv,
  instanceWorkerSecret,
  planInstance,
  startInstance,
  stopInstance,
  sweepLeftoverCampaigns,
  type CampaignInstance,
  type LaunchedCli,
  type LifecycleDeps,
} from './instance';
import type { CampaignKeys } from './keys';
import { campaignModelApplier } from './model';
import { campaignFolders, resetBetweenTrials, type ResetDeps } from './reset';
import { teamDrift } from './team';

export interface CampaignRequest {
  readonly id: string;
  readonly config: CampaignConfig;
  readonly keys: CampaignKeys;
  readonly scenarios: readonly AnyScenario[];
  readonly trials: number;
  /** Les modèles de la matrice ; null : le modèle de la configuration. */
  readonly models: readonly MatrixModel[] | null;
  readonly trigger: TrialLine['trigger'];
  /** Le dépôt d'où l'instance tourne et d'où le banc lance `mcp serve`. */
  readonly stackDir: string;
}

/** Ce qu'une campagne appelle au-dehors ; les tests en passent des faux. */
export interface CampaignDeps extends LifecycleDeps {
  /** Ouvre la base de l'instance (sa `config.json`, sous `NODALAI_HOME`). */
  openDb(): Promise<{ db: AnyDrizzleDb; close(): Promise<void> }>;
  /** La session du banc (`runBench`). */
  runBench(
    run: BenchRun,
    db: AnyDrizzleDb,
    stop: BenchStop,
    hooks: SessionHooks,
  ): Promise<SessionSummary>;
  /** Les faits de l'arbre d'un essai (`readTreeFacts`). */
  readFacts(db: AnyDrizzleDb, rootJobId: string): Promise<TreeFacts>;
  /** Les dossiers de travail tels que le produit les résout (`workspacesRoot`, `SHARED_WORKSPACE_LABEL`). */
  readonly folders: ResetDeps;
  /** Le dossier où la campagne exporte ses preuves. */
  readonly evidenceRoot?: string;
  /** L'arrêt partagé, pour Ctrl+C. */
  readonly stop?: BenchStop;
  /** Remplace la sonde des imprimantes (défaut : `run_command` sous le bac à sable de l'instance). */
  readonly probePrinters?: () => Promise<PrinterReach>;
  /** Remplace la connexion qui liste les outils de l'imprimante du banc (`listStdioMcpServer`). */
  readonly listMcpServer?: ApplyDeps['listMcpServer'];
  /** Remplace l'installateur de skills communautaires (les tests n'ont pas de runner). */
  readonly installCommunitySkill?: (
    instance: CampaignInstance,
  ) => (source: string, entityId: string) => Promise<void>;
}

export interface CampaignSummary {
  readonly id: string;
  readonly instance: CampaignInstance;
  readonly applied: AppliedCampaign | null;
  readonly lines: TrialLine[];
  readonly failed: number;
  readonly skipped: number;
  readonly spentUsd: number;
  readonly stopReason: string | null;
  readonly evidenceDir: string;
}

/**
 * Les outils sortants que la configuration déclare, par agent : les
 * connecteurs en lecture seule (schéma validé), et l'imprimante du banc, sous
 * le nom que le runner donne à ses outils (`bench_printer__request_print`).
 */
export function allowedReachOf(config: CampaignConfig): AllowedReach[] {
  return config.agents.flatMap((a) => [
    ...a.connectors.map((c) => ({ agent: a.slug, via: c.slug, tools: [...c.operations] })),
    ...(a.printConnector === null
      ? []
      : [
          {
            agent: a.slug,
            via: a.printConnector.mcpServer,
            tools: a.printConnector.tools.map(
              (t) => `${mcpToolPrefix(a.printConnector!.mcpServer)}__${t}`,
            ),
          },
        ]),
  ]);
}

export async function runCampaign(
  req: CampaignRequest,
  deps: CampaignDeps,
): Promise<CampaignSummary> {
  const { config } = req;
  const fingerprint = configFingerprint(config);
  const instance = planInstance(req.id, config.instance.ports, req.stackDir, deps.userHome);
  const evidenceDir = campaignEvidenceDir(req.id, deps.evidenceRoot);
  const startedAt = new Date().toISOString();

  await sweepLeftoverCampaigns({ ...deps, stackDir: req.stackDir, ports: config.instance.ports });

  const budget = new CampaignBudget(config.budget.perTrialUsd, config.budget.perCampaignUsd);
  const stop = deps.stop ?? new BenchStop();
  const lines: TrialLine[] = [];
  let failed = 0;
  let skipped = 0;
  let applied: AppliedCampaign | null = null;
  let error: unknown = null;
  let launched: LaunchedCli | undefined;
  try {
    createInstanceFiles(instance, req.keys);
    launched = await startInstance(instance, deps);
    const { db, close } = await deps.openDb();
    try {
      const install =
        deps.installCommunitySkill?.(instance) ??
        runnerSkillInstaller(instance.ports.runner, instanceWorkerSecret(instance));
      applied = await applyCampaignConfig(db, config, req.keys, {
        foldersRoot: instancePaths(instance).folders,
        printerRecordsDir: instancePaths(instance).printerRecords,
        installCommunitySkill: install,
        ...(deps.listMcpServer ? { listMcpServer: deps.listMcpServer } : {}),
        log: deps.log,
      });
      const drift = await teamDrift(db, config, applied);
      if (drift.length > 0) {
        throw new Error(
          `campaign_apply_drift: the applied team is not the configuration's:\n  - ${drift.join('\n  - ')}`,
        );
      }
      deps.log(
        `Configuration ${fingerprint} applied: ${config.agents.map((a) => a.slug).join(', ')}.`,
      );

      const team = applied;
      // Les imprimantes que les commandes de l'instance peuvent joindre,
      // comptées sous le bac à sable que SON runner ouvre (ses ports).
      let sandbox: Promise<Sandbox> | undefined;
      const probePrinters =
        deps.probePrinters ??
        (async () =>
          probeReachablePrinters({
            sandbox: await (sandbox ??= import('@nodal-agents/sandbox').then((m) =>
              m.instanceSandbox(instanceSandboxEnv(config.instance.ports)),
            )),
          }));
      const models = req.models ?? [config.models.tested];
      const applier = campaignModelApplier(db, config, team);
      let index = 0;
      for (const model of models) {
        if (stop.stopped || budget.stopped !== null) break;
        const applying = await applier.apply(model);
        // Ce que l'équipe DOIT être pendant cette ligne de la matrice : la
        // configuration, avec le modèle testé de la ligne. La remise à zéro
        // d'avant chaque essai compare l'équipe à CELLE-CI : comparée à la
        // configuration seule, une ligne sur un autre modèle était prise pour
        // une dérive, et la campagne s'arrêtait avant son premier essai.
        const rowConfig: CampaignConfig = {
          ...config,
          models: { ...config.models, tested: { provider: model.provider, model: model.model } },
        };
        try {
          const summary = await deps.runBench(
            {
              scenarios: req.scenarios,
              trials: req.trials,
              trigger: req.trigger,
              // Une instance sans canal : rien ne peut aller au propriétaire.
              allowOwnerSends: false,
              stackDir: req.stackDir,
              targetEntityId: team.tested.entityId,
              allowedReach: allowedReachOf(config),
              childEnv: campaignEnv(deps.baseEnv, instance.home),
              modelUnderTest: modelKey(model),
              campaign: req.id,
              configFingerprint: fingerprint,
              probePrinters,
              // Le juge ne lit que le dossier que le banc a donné à l'imprimante.
              ...(team.printerRecordsDir === null
                ? {}
                : { benchPrinterRecordsDir: team.printerRecordsDir }),
            },
            db,
            stop,
            {
              log: deps.log,
              trialEnd: (_s, _i, line) => deps.log(JSON.stringify(line)),
              beforeTrial: async () => {
                // Le plafond de l'essai est RÉSERVÉ sur ce qui reste, puis posé
                // comme budget de run : le runner le tient sur tout l'arbre.
                const cap = budget.reserve();
                if (cap === null) throw new Error(`campaign_budget_reached: ${budget.stopped}`);
                await resetBetweenTrials(db, rowConfig, team, deps.folders);
                const { setRunBudgetRepo } = await import('@nodal-agents/db');
                await setRunBudgetRepo(db, team.tested.entityId, {
                  maxRunCostUsd: cap,
                  maxRunHours: 0,
                });
              },
              afterTrial: async (_s, _i, line) => {
                index++;
                lines.push(line);
                const facts = line.rootJobId ? await deps.readFacts(db, line.rootJobId) : null;
                exportTrial(evidenceDir, index, {
                  line,
                  facts,
                  folders: [
                    ...campaignFolders(team, deps.folders).map((f) => f.path),
                    ...(team.printerRecordsDir === null ? [] : [team.printerRecordsDir]),
                  ],
                });
                const next = budget.record(line);
                if (next === 'stop') deps.log(`Campaign stops: ${budget.stopped}.`);
                return next;
              },
            },
          );
          failed += summary.failed;
          skipped += summary.skipped;
        } finally {
          await applying.restore();
        }
      }
    } finally {
      await close();
    }
  } catch (e) {
    error = e;
  } finally {
    exportSummary(evidenceDir, {
      id: req.id,
      startedAt,
      endedAt: new Date().toISOString(),
      stackDir: req.stackDir,
      configFingerprint: fingerprint,
      config,
      models: (req.models ?? [config.models.tested]).map(modelKey),
      trials: lines.length,
      failed,
      skipped,
      spentUsd: budget.spent,
      stopReason: budget.stopped,
      error: error === null ? null : describeError(error),
    });
    await stopInstance(instance, deps, launched).catch((e: unknown) =>
      deps.log(`stopping the instance failed: ${String(e instanceof Error ? e.message : e)}`),
    );
    // Arrêtée, l'instance a fini d'écrire ses journaux : ils partent dans les
    // preuves avant que l'effacement ne les emporte.
    try {
      exportInstanceLogs(evidenceDir, instance.home);
    } catch (e) {
      deps.log(`the instance logs could not be exported: ${describeError(e)}`);
    }
    try {
      await eraseInstance(instance, deps);
    } catch (e) {
      // Un effacement incomplet est l'erreur que l'on rend, même après une
      // autre : c'est elle qui laisse quelque chose derrière.
      error = error === null ? e : new Error(`${describeError(error)}\n${describeError(e)}`);
    }
  }
  if (error !== null) throw error;
  return {
    id: req.id,
    instance,
    applied,
    lines,
    failed,
    skipped,
    spentUsd: budget.spent,
    stopReason: budget.stopped,
    evidenceDir,
  };
}
