// workflows/trial.ts — un essai, et les règles qui le rendent sûr sur la stack du propriétaire.
//
// Le banc tourne sur la VRAIE stack, avec les vrais agents. Quatre règles dures,
// toutes tenues ici et prouvées par trial.test.ts :
//
//   1. Il ne tourne JAMAIS par-dessus le propriétaire. Un job vivant qui n'est
//      pas à lui, ou un tour de chat récent : il attend, puis renonce en le
//      disant (ligne `skipped`, avec la raison).
//   2. Une approbation ou une question levée par un essai est un ROUGE
//      (« asked an approval »), et l'arbre est annulé dans la foulée : le banc
//      ne répond jamais à la place du propriétaire. La base est relue toutes
//      les `pollMs` (2 s par défaut), c'est le temps pendant lequel une carte
//      reste ouverte.
//   3. Il ne laisse aucun run vivant : dépassement, erreur, interruption — tout
//      finit par une annulation de l'arbre entier (`cancelJobTree`, le chemin du
//      bouton Stop).
//   4. Un scénario dont la condition manque (pas de coffre, pas d'imprimante)
//      est ROUGE avec cette raison, sans lancer de job : jamais sauté en silence.

import type { TreeFacts } from './facts';
import { isLive, liveJobs, pendingApprovals } from './facts';
import type { ForeignActivity } from './stack';
import type { AnyScenario, ScenarioEnv, TrialLine } from './types';

export interface TrialDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Envoie la demande par le chemin MCP de l'utilisateur. */
  start(instruction: string, caller: string): Promise<{ jobId: string; close(): Promise<void> }>;
  read(rootId: string): Promise<TreeFacts>;
  cancel(entityId: string, rootId: string): Promise<unknown>;
  foreign(): Promise<ForeignActivity>;
  env(startedMs: number): Promise<ScenarioEnv>;
  log(line: string): void;
}

export interface TrialOptions {
  readonly pollMs: number;
  /** Combien de temps attendre que le propriétaire ait fini, avant de renoncer. */
  readonly idleWaitMs: number;
  readonly idlePollMs: number;
  /** Un tour de chat plus récent que ça compte comme « le propriétaire travaille ». */
  readonly chatQuietMs: number;
  readonly trigger: TrialLine['trigger'];
  readonly nodalVersion: string;
  readonly stackCommit: string | null;
}

export const DEFAULT_TRIAL_OPTIONS: Omit<TrialOptions, 'trigger' | 'nodalVersion' | 'stackCommit'> =
  {
    pollMs: 2_000,
    idleWaitMs: 30 * 60_000,
    idlePollMs: 30_000,
    chatQuietMs: 5 * 60_000,
  };

export function benchCaller(s: AnyScenario): string {
  return `nodal-bench/${s.id}/v${s.version}`;
}

/** Pourquoi la stack n'est pas libre, ou null si elle l'est. */
export function busyReason(a: ForeignActivity, nowMs: number, chatQuietMs: number): string | null {
  const parts: string[] = [];
  if (a.jobs.length > 0) {
    parts.push(
      `${a.jobs.length} job(s) of the owner still live: ` +
        a.jobs
          .slice(0, 5)
          .map(
            (j) =>
              `${j.id.slice(0, 8)} ${j.agentSlug ?? '?'} ${j.status ?? 'no status'} via ${j.channel}`,
          )
          .join('; '),
    );
  }
  if (a.lastChatMs !== null && nowMs - a.lastChatMs < chatQuietMs) {
    parts.push(`a chat turn ran ${Math.round((nowMs - a.lastChatMs) / 1000)} s ago`);
  }
  return parts.length > 0 ? parts.join(' and ') : null;
}

function emptyLine(
  s: AnyScenario,
  o: TrialOptions,
  startedMs: number,
): Omit<TrialLine, 'verdict' | 'reasons'> {
  return {
    scenario: s.id,
    scenarioVersion: s.version,
    title: s.title,
    green: s.green,
    set: s.set,
    nodalVersion: o.nodalVersion,
    stackCommit: o.stackCommit,
    trigger: o.trigger,
    startedAt: new Date(startedMs).toISOString(),
    unverified: [...(s.unverified ?? [])],
    durationMs: null,
    firstModelReplyMs: null,
    jobs: 0,
    agents: [],
    models: [],
    toolCalls: 0,
    llmCalls: 0,
    cliRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    approvals: 0,
    rootJobId: null,
    cancelled: false,
  };
}

/** Une somme dont un terme manque n'est pas une somme : null, jamais un total sous-estimé. */
function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/**
 * Les mesures d'un arbre : durée, jetons, coût, modèles. Pur.
 *
 * Deux sources de consommation, une seule sémantique :
 *   - `llm_calls` (un agent en API) : l'entrée y est cache COMPRIS ;
 *   - `cli_runs` (un agent sous Claude Code ou Codex) : l'entrée y est HORS
 *     cache, les lectures et écritures de cache à part. Elles sont rajoutées,
 *     pour que les deux se comparent.
 * Un appel qui a échoué ne consomme rien de mesurable ; un appel qui a répondu
 * sans rapporter ses jetons rend la mesure ABSENTE (null), jamais zéro.
 *
 * Le coût est ce qui est FACTURÉ à l'appel : les appels d'API, et les runs de
 * CLI payés par une clé. Un run sous abonnement n'est pas facturé à l'appel ;
 * son coût notionnel n'est pas une dépense, il n'entre pas ici (ses jetons, si).
 * Un arbre qui n'a tourné que sous abonnement n'a donc pas de coût : null.
 */
export function measure(
  facts: TreeFacts,
): Pick<
  TrialLine,
  | 'durationMs'
  | 'firstModelReplyMs'
  | 'jobs'
  | 'agents'
  | 'models'
  | 'toolCalls'
  | 'llmCalls'
  | 'cliRuns'
  | 'inputTokens'
  | 'outputTokens'
  | 'costUsd'
  | 'approvals'
> {
  const root = facts.jobs.find((j) => j.id === facts.rootId);
  const ends = facts.jobs.map((j) => j.updatedMs ?? j.createdMs);
  const replies = [...facts.llmCalls, ...facts.cliRuns].map((c) => c.createdMs);
  const firstReply = replies.length > 0 ? Math.min(...replies) : null;

  const answered = facts.llmCalls.filter((l) => l.error === null);
  const inputTokens = sumOrNull([
    ...answered.map((l) => l.inputTokens),
    ...facts.cliRuns.map((c) =>
      c.inputTokens === null || c.cachedTokens === null
        ? null
        : c.inputTokens + c.cachedTokens + (c.cacheCreationTokens ?? 0),
    ),
  ]);
  const outputTokens = sumOrNull([
    ...answered.map((l) => l.outputTokens),
    ...facts.cliRuns.map((c) => c.outputTokens),
  ]);
  const billed = [
    ...answered.map((l) => l.costUsd),
    ...facts.cliRuns.filter((c) => c.source !== 'subscription').map((c) => c.costUsd),
  ];
  const onlySubscription = billed.length === 0 && facts.cliRuns.length > 0;
  const cost = onlySubscription ? null : sumOrNull(billed);

  return {
    durationMs: root ? Math.round(Math.max(...ends) - root.createdMs) : null,
    firstModelReplyMs: root && firstReply !== null ? Math.round(firstReply - root.createdMs) : null,
    jobs: facts.jobs.length,
    agents: facts.jobs.map((j) => j.agentSlug ?? '?'),
    models: [
      ...new Set([
        ...facts.llmCalls.map((l) => l.model),
        ...facts.cliRuns.flatMap((c) =>
          c.models.length > 0 ? c.models : [`${c.provider} CLI, model not reported`],
        ),
      ]),
    ],
    toolCalls: facts.toolCalls.length,
    llmCalls: facts.llmCalls.length,
    cliRuns: facts.cliRuns.length,
    inputTokens,
    outputTokens,
    costUsd: cost === null ? null : Number(cost.toFixed(4)),
    approvals: facts.approvals.length,
  };
}

/** Attend que le propriétaire ait fini. Rend null quand la stack est libre, sinon la raison du renoncement. */
export async function waitForIdle(deps: TrialDeps, o: TrialOptions): Promise<string | null> {
  const t0 = deps.now();
  for (;;) {
    const why = busyReason(await deps.foreign(), deps.now(), o.chatQuietMs);
    if (why === null) return null;
    const waited = deps.now() - t0;
    if (waited >= o.idleWaitMs) {
      return `the stack was busy for ${Math.round(waited / 60_000)} min: ${why}`;
    }
    deps.log(`  waiting, the owner is working (${why})`);
    await deps.sleep(o.idlePollMs);
  }
}

/**
 * Un essai complet : attendre la stack libre, préparer, lancer, surveiller,
 * annuler si besoin, juger. Rend TOUJOURS une ligne ; n'en écrit aucune.
 */
export async function runTrial(
  s: AnyScenario,
  deps: TrialDeps,
  o: TrialOptions,
): Promise<TrialLine> {
  const busy = await waitForIdle(deps, o);
  if (busy !== null) {
    return { ...emptyLine(s, o, deps.now()), verdict: 'skipped', reasons: [busy] };
  }

  // Lire l'espace, vérifier les prérequis, préparer : tout ce qui lève ici
  // (un classeur ouvert dans Excel verrouille son fichier sous Windows) devient
  // UNE ligne `error` avec sa raison. Un rejet emporterait les scénarios suivants.
  try {
    const envBefore = await deps.env(deps.now());
    const missing = s.requires?.(envBefore) ?? [];
    if (missing.length > 0) {
      return { ...emptyLine(s, o, deps.now()), verdict: 'red', reasons: missing };
    }
    s.prepare?.(envBefore);
  } catch (e) {
    return {
      ...emptyLine(s, o, deps.now()),
      verdict: 'error',
      reasons: [`the trial could not be prepared: ${String(e instanceof Error ? e.message : e)}`],
    };
  }

  const startedMs = deps.now();
  let session: { jobId: string; close(): Promise<void> };
  try {
    session = await deps.start(s.instruction, benchCaller(s));
  } catch (e) {
    return {
      ...emptyLine(s, o, startedMs),
      verdict: 'error',
      reasons: [String(e instanceof Error ? e.message : e)],
    };
  }
  const rootId = session.jobId;
  let entityId: string | null = null;

  let cancelled = false;
  const benchReasons: string[] = [];
  const cancel = async (why: string): Promise<void> => {
    if (entityId === null) {
      // L'entité n'est connue qu'après la première lecture ; la relire ici
      // plutôt que de laisser vivre un arbre qu'on ne sait pas nommer.
      entityId = (await deps.read(rootId)).entityId;
    }
    if (entityId === null)
      throw new Error(`workflow_cannot_cancel: job ${rootId} has no workspace`);
    await deps.cancel(entityId, rootId);
    cancelled = true;
    deps.log(`  cancelled the run (${why})`);
  };

  try {
    for (;;) {
      const facts = await deps.read(rootId);
      entityId = facts.entityId;
      const asking = pendingApprovals(facts);
      if (asking.length > 0) {
        await cancel(`it asked: ${asking.map((a) => `${a.kind} ${a.toolName}`).join(', ')}`);
        break;
      }
      if (liveJobs(facts).length === 0) break;
      if (deps.now() - startedMs > s.timeoutMs) {
        benchReasons.push(`timed out after ${Math.round(s.timeoutMs / 60_000)} min`);
        await cancel('timeout');
        break;
      }
      await deps.sleep(o.pollMs);
    }
  } catch (e) {
    benchReasons.push(`the bench lost the run: ${String(e instanceof Error ? e.message : e)}`);
  } finally {
    // Ceinture et bretelles : quoi qu'il soit arrivé plus haut, rien ne reste vivant.
    try {
      const after = await deps.read(rootId);
      entityId = after.entityId;
      if (after.jobs.some((j) => isLive(j.status)) || pendingApprovals(after).length > 0) {
        await cancel('still live at the end of the trial');
      }
    } catch (e) {
      benchReasons.push(
        `could not verify the run was stopped: ${String(e instanceof Error ? e.message : e)}`,
      );
    }
    await session.close();
  }

  let facts: TreeFacts;
  try {
    facts = await deps.read(rootId);
  } catch (e) {
    return {
      ...emptyLine(s, o, startedMs),
      rootJobId: rootId,
      cancelled,
      verdict: 'error',
      reasons: [
        ...benchReasons,
        `could not read the run: ${String(e instanceof Error ? e.message : e)}`,
      ],
    };
  }
  let judged: string[];
  try {
    judged = s.judge(facts, await s.observe(facts, await deps.env(startedMs)));
  } catch (e) {
    judged = [`the judge failed: ${String(e instanceof Error ? e.message : e)}`];
  }
  const reasons = [...benchReasons, ...judged];
  return {
    ...emptyLine(s, o, startedMs),
    ...measure(facts),
    rootJobId: rootId,
    cancelled,
    verdict: reasons.length === 0 ? 'green' : 'red',
    reasons,
  };
}
