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
//   4. Un scénario dont un besoin manque (pas de ComfyUI, pas d'imprimante, un
//      agent qui sait envoyer un e-mail) est SAUTÉ avec cette raison, sans
//      lancer de job (`needs.ts`) : ni rouge, rien n'a été essayé ; ni tu, la
//      ligne `skipped` le dit. De même quand aucun outil du produit qu'il
//      déclare n'est dans l'équipe, ou qu'aucun sujet calibré n'existe pour
//      lui (`subjects.ts`, #776).
//
// Chaque ligne garde aussi le CHEMIN de l'essai (les outils de chaque job, par
// nom et dans l'ordre, et les délégations) et classe les liens du texte cité :
// vus ou non dans une sortie d'outil web (#648, la partie mesurable).

import { benchDeliverables, findInRoots } from './disk';
import { prepareTrial } from './fixtures';
import type { TreeFacts } from './facts';
import { isLive, liveJobs, pendingApprovals } from './facts';
import { DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import {
  answerOf,
  bareToolName,
  channelSends,
  citedLinks,
  delegatedAgents,
  productToolGate,
  productToolReasons,
  toolPath,
  unverifiedOf,
} from './judge-kit';
import { isMailSender, isOutboundTool, missingNeeds } from './needs';
import { recipientIds } from './recipients';
import { redactHome } from './redact';
import type { ForeignActivity } from './stack';
import { noSubjectReason, pickSubject, requestWithSubject, type ResearchSubject } from './subjects';
import type { AnyScenario, ModelUse, ProductFileState, ScenarioEnv, TrialLine } from './types';

/** La réponse finale gardée sur la ligne : assez pour la lire, pas un rapport entier. */
export const ANSWER_MAX = 1200;

/**
 * Ce que CHAQUE ligne mesure, quel que soit le scénario (anglais : la carte du
 * Studio). Une mesure n'est pas un verdict : seules les règles d'un scénario
 * (son juge, ses outils du produit, sa destination) rendent un essai rouge.
 */
export const MEASURED_ON_EVERY_TRIAL = [
  'The path: the tools each job called, by name and in order, and the teammates delegated to',
  'The questions asked and the approvals requested',
  'Each link cited: seen or not in a web tool output of the run (#648)',
  'The duration and the time to the first model reply',
  'The model calls, the tokens and the cost; the model asked for and the one that answered',
] as const;

export interface TrialDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Envoie la demande par le chemin MCP de l'utilisateur. */
  start(instruction: string, caller: string): Promise<{ jobId: string; close(): Promise<void> }>;
  read(rootId: string): Promise<TreeFacts>;
  cancel(entityId: string, rootId: string): Promise<unknown>;
  foreign(): Promise<ForeignActivity>;
  env(startedMs: number): Promise<ScenarioEnv>;
  /** Le modèle configuré de l'agent racine, lu au début de l'essai. */
  rootModel(): Promise<string | null>;
  /** Les sujets de recherche calibrés (`readResearchSubjects`) ; un fichier mal formé lève. */
  subjects(): readonly ResearchSubject[];
  log(line: string): void;
  /** Où en est l'essai, pour qui le suit en direct (Bench Studio). Facultatif. */
  progress?(event: TrialProgress): void;
}

/** Une étape d'un essai, telle que runTrial la traverse. */
export type TrialProgress =
  | { readonly step: 'waiting'; readonly why: string }
  | { readonly step: 'preparing' }
  | { readonly step: 'started'; readonly rootJobId: string }
  | {
      readonly step: 'running';
      readonly rootJobId: string;
      readonly jobs: number;
      readonly liveJobs: number;
      readonly toolCalls: number;
      readonly elapsedMs: number;
    }
  | { readonly step: 'judging'; readonly rootJobId: string }
  | { readonly step: 'done'; readonly verdict: TrialLine['verdict'] };

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
  /** Le modèle que la matrice impose ; null : les agents sur leurs propres modèles. */
  readonly modelUnderTest: string | null;
  /** `--allow-owner-sends` : seul ce drapeau laisse partir un scénario qui envoie au propriétaire. */
  readonly allowOwnerSends: boolean;
}

export const DEFAULT_TRIAL_OPTIONS: Omit<
  TrialOptions,
  'trigger' | 'nodalVersion' | 'stackCommit' | 'modelUnderTest' | 'allowOwnerSends'
> = {
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
  rootModel: string | null = null,
): Omit<TrialLine, 'verdict' | 'reasons'> {
  return {
    scenario: s.id,
    scenarioVersion: s.version,
    title: s.title,
    green: s.green,
    set: s.set,
    activity: s.activity,
    needs: [...(s.needs ?? [])],
    sends: s.sends,
    modelUnderTest: o.modelUnderTest,
    rootModel,
    nodalVersion: o.nodalVersion,
    stackCommit: o.stackCommit,
    trigger: o.trigger,
    startedAt: new Date(startedMs).toISOString(),
    unverified: unverifiedOf(s),
    durationMs: null,
    firstModelReplyMs: null,
    jobs: 0,
    agents: [],
    models: [],
    toolCalls: 0,
    path: [],
    delegatedTo: [],
    links: [],
    subject: null,
    llmCalls: 0,
    cliRuns: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    approvals: 0,
    rootJobId: null,
    cancelled: false,
    modelUse: [],
    deliverables: [],
    answer: null,
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

/** L'entrée d'un tour de CLI, ramenée à la sémantique des appels d'API (cache compris). */
function cliInput(c: TreeFacts['cliRuns'][number]): number | null {
  return c.inputTokens === null || c.cachedTokens === null
    ? null
    : c.inputTokens + c.cachedTokens + (c.cacheCreationTokens ?? 0);
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
 * sans rapporter ses jetons rend la mesure ABSENTE (null), jamais zéro. Les
 * lectures et écritures de cache sont aussi dites à part (`cachedTokens`,
 * `cacheWriteTokens`) : elles sont comprises dans l'entrée, pas en plus.
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
  | 'path'
  | 'delegatedTo'
  | 'llmCalls'
  | 'cliRuns'
  | 'inputTokens'
  | 'cachedTokens'
  | 'cacheWriteTokens'
  | 'outputTokens'
  | 'costUsd'
  | 'approvals'
  | 'modelUse'
> {
  const root = facts.jobs.find((j) => j.id === facts.rootId);
  const ends = facts.jobs.map((j) => j.updatedMs ?? j.createdMs);
  const replies = [...facts.llmCalls, ...facts.cliRuns].map((c) => c.createdMs);
  const firstReply = replies.length > 0 ? Math.min(...replies) : null;

  const answered = facts.llmCalls.filter((l) => l.error === null);
  const inputTokens = sumOrNull([
    ...answered.map((l) => l.inputTokens),
    ...facts.cliRuns.map(cliInput),
  ]);
  const outputTokens = sumOrNull([
    ...answered.map((l) => l.outputTokens),
    ...facts.cliRuns.map((c) => c.outputTokens),
  ]);
  const cachedTokens = sumOrNull([
    ...answered.map((l) => l.cachedTokens),
    ...facts.cliRuns.map((c) => c.cachedTokens),
  ]);
  const cacheWriteTokens = sumOrNull([
    ...answered.map((l) => l.cacheCreationTokens),
    ...facts.cliRuns.map((c) => c.cacheCreationTokens),
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
    path: toolPath(facts),
    delegatedTo: delegatedAgents(facts),
    llmCalls: facts.llmCalls.length,
    cliRuns: facts.cliRuns.length,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens,
    costUsd: cost === null ? null : Number(cost.toFixed(4)),
    approvals: facts.approvals.length,
    modelUse: modelUse(facts),
  };
}

type ModelKey = Omit<
  ModelUse,
  'calls' | 'inputTokens' | 'cachedTokens' | 'outputTokens' | 'costUsd'
>;
interface Consumption {
  readonly input: number | null;
  readonly cached: number | null;
  readonly output: number | null;
  readonly cost: number | null;
}

/**
 * Les modèles de chaque job : un groupe par job et par combinaison demandé /
 * effectif / fournisseur / effort / secours, dans l'ordre des appels. Un appel
 * d'API qui a échoué compte comme appel (il a été fait) mais pas dans les
 * jetons ni le coût, comme `measure`. Une valeur absente d'un appel rend le
 * total du groupe absent (null), jamais sous-estimé. Le coût d'un tour de CLI
 * sous abonnement n'est pas facturé : absent.
 */
export function modelUse(facts: TreeFacts): ModelUse[] {
  const agentOf = new Map(facts.jobs.map((j) => [j.id, j.agentSlug]));
  const groups = new Map<string, { key: ModelKey; calls: number; used: Consumption[] }>();
  const add = (key: ModelKey, used: Consumption | null): void => {
    const k = JSON.stringify(key);
    const g = groups.get(k) ?? { key, calls: 0, used: [] };
    g.calls++;
    if (used) g.used.push(used);
    groups.set(k, g);
  };
  const ofJob = (jobId: string | null) => ({
    job: (jobId ?? 'no job').slice(0, 8),
    agent: jobId === null ? null : (agentOf.get(jobId) ?? null),
  });
  for (const l of facts.llmCalls) {
    add(
      {
        ...ofJob(l.jobId),
        via: 'api',
        requested: l.modelRequested,
        effective: l.model,
        provider: l.provider,
        reasoningEffort: l.reasoningEffort,
        failover: l.failover,
      },
      l.error === null
        ? { input: l.inputTokens, cached: l.cachedTokens, output: l.outputTokens, cost: l.costUsd }
        : null,
    );
  }
  for (const c of facts.cliRuns) {
    add(
      {
        ...ofJob(c.jobId),
        via: 'cli',
        requested: c.modelRequested,
        effective:
          c.models.length > 0 ? c.models.join(' + ') : `${c.provider} CLI, model not reported`,
        provider: c.provider,
        reasoningEffort: null,
        failover: null,
      },
      {
        input: cliInput(c),
        cached: c.cachedTokens,
        output: c.outputTokens,
        cost: c.source === 'subscription' ? null : c.costUsd,
      },
    );
  }
  return [...groups.values()].map((g) => {
    const cost = sumOrNull(g.used.map((u) => u.cost));
    return {
      ...g.key,
      calls: g.calls,
      inputTokens: sumOrNull(g.used.map((u) => u.input)),
      cachedTokens: sumOrNull(g.used.map((u) => u.cached)),
      outputTokens: sumOrNull(g.used.map((u) => u.output)),
      costUsd: cost === null ? null : Number(cost.toFixed(4)),
    };
  });
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
    deps.progress?.({ step: 'waiting', why });
    await deps.sleep(o.idlePollMs);
  }
}

/**
 * Avant tout lancement : un scénario qui envoie au propriétaire ne part
 * qu'avec `--allow-owner-sends` ; un scénario qui envoie à un compte de test
 * ne part pas tant qu'aucun compte de test n'est branché.
 */
export function destinationGate(
  s: AnyScenario,
  o: Pick<TrialOptions, 'allowOwnerSends'>,
): string[] {
  if (s.sends === 'owner' && !o.allowOwnerSends)
    return [
      "this scenario sends to the owner's own account (sends: owner): it runs only with --allow-owner-sends",
    ];
  if (s.sends.startsWith('test-account:'))
    return [
      `this scenario sends to the test account "${s.sends.slice('test-account:'.length)}", and no test account is wired yet`,
    ];
  return [];
}

/**
 * Après l'essai : ce qui est réellement parti contre la destination déclarée.
 * `nothing` : aucune livraison de réponse, aucun outil d'envoi du produit, et
 * — fermé par défaut — aucun outil dont le nom porte un verbe sortant ou vise
 * un canal (`isOutboundTool`), nommé dans la raison. `owner` : l'envoi va au
 * chat par défaut du propriétaire ; un envoi qui nomme un destinataire
 * explicite est refusé.
 */
export function destinationReasons(s: AnyScenario, facts: TreeFacts): string[] {
  if (s.sends === 'nothing') {
    const delivery = new Set<string>(DELIVERY_TOOL_NAMES);
    const outbound = facts.toolCalls
      .filter((c) => isOutboundTool(c.toolName) && !delivery.has(bareToolName(c.toolName)))
      .map((c) => c.toolName);
    return [
      ...channelSends(facts),
      ...(outbound.length > 0
        ? [`an outbound tool was called (${[...new Set(outbound)].join(', ')})`]
        : []),
    ];
  }
  if (s.sends === 'owner') {
    const delivery = new Set<string>(DELIVERY_TOOL_NAMES);
    const named = facts.toolCalls
      .filter((c) => delivery.has(bareToolName(c.toolName)) || isMailSender(c.toolName))
      .flatMap((c) => recipientIds(c.input ?? ''));
    return named.length > 0
      ? [
          `a send names a recipient other than the owner (${[...new Set(named)].join(', ')}): sends: owner allows only the owner's own chat`,
        ]
      : [];
  }
  return [];
}

/**
 * Tout ce qui rend un essai rouge, une fois l'arbre fini : le juge du
 * scénario, la destination des envois, et la règle de chemin des outils du
 * produit. La même composition pour runTrial et pour les tests (harness.ts) ;
 * une raison déjà dite n'est pas répétée.
 */
export function trialReasons(
  s: AnyScenario,
  facts: TreeFacts,
  observed: unknown,
  env: Pick<ScenarioEnv, 'teamTools' | 'workspaceRoots'>,
): string[] {
  return [
    ...new Set([
      ...s.judge(facts, observed),
      ...destinationReasons(s, facts),
      ...productToolReasons(s, facts, env, productFileStates(s, env.workspaceRoots)),
    ]),
  ];
}

/**
 * Les livrables d'un scénario (`productTools.writes`) tels que le disque les
 * montre : la date du plus récent de chaque chemin parmi les dossiers de
 * travail, null quand il n'existe nulle part.
 */
export function productFileStates(s: AnyScenario, roots: readonly string[]): ProductFileState[] {
  return (s.productTools?.writes ?? []).map((rel) => ({
    rel,
    mtimeMs: findInRoots(roots, rel, 0)[0]?.mtimeMs ?? null,
  }));
}

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

/**
 * Un essai complet : attendre la stack libre, vérifier les besoins, préparer,
 * lancer, surveiller, annuler si besoin, juger. Rend TOUJOURS une ligne ;
 * n'en écrit aucune. Chaque étape est signalée à `deps.progress`, la fin
 * comprise, quelle que soit la sortie.
 */
export async function runTrial(
  s: AnyScenario,
  deps: TrialDeps,
  o: TrialOptions,
): Promise<TrialLine> {
  const line = await runTrialSteps(s, deps, o);
  deps.progress?.({ step: 'done', verdict: line.verdict });
  return line;
}

async function runTrialSteps(s: AnyScenario, deps: TrialDeps, o: TrialOptions): Promise<TrialLine> {
  const busy = await waitForIdle(deps, o);
  if (busy !== null) {
    return { ...emptyLine(s, o, deps.now()), verdict: 'skipped', reasons: [busy] };
  }

  // Lire l'espace, vérifier les besoins, préparer : tout ce qui lève ici
  // (un classeur ouvert dans Excel verrouille son fichier sous Windows) devient
  // UNE ligne `error` avec sa raison. Un rejet emporterait les scénarios suivants.
  let rootModel: string | null = null;
  let subject: ResearchSubject | null = null;
  let request = s.instruction;
  try {
    rootModel = await deps.rootModel();
    const envBefore = await deps.env(deps.now());
    let missing = [...destinationGate(s, o), ...missingNeeds(s.needs ?? [], envBefore)];
    // Les outils du produit ensuite, une fois les besoins là : une imprimante
    // absente se dit par son besoin, pas deux fois.
    if (missing.length === 0) missing = productToolGate(s, envBefore);
    if (missing.length === 0 && s.subject) {
      subject = pickSubject(s.subject, deps.subjects());
      if (subject === null) missing = [noSubjectReason(s.subject)];
      else request = requestWithSubject(s.instruction, subject);
    }
    if (missing.length > 0) {
      return { ...emptyLine(s, o, deps.now(), rootModel), verdict: 'skipped', reasons: missing };
    }
    deps.progress?.({ step: 'preparing' });
    prepareTrial(s, envBefore.workspaceRoots);
  } catch (e) {
    return {
      ...emptyLine(s, o, deps.now(), rootModel),
      verdict: 'error',
      reasons: [`the trial could not be prepared: ${String(e instanceof Error ? e.message : e)}`],
    };
  }

  const startedMs = deps.now();
  let session: { jobId: string; close(): Promise<void> };
  try {
    session = await deps.start(request, benchCaller(s));
  } catch (e) {
    return {
      ...emptyLine(s, o, startedMs, rootModel),
      verdict: 'error',
      reasons: [String(e instanceof Error ? e.message : e)],
    };
  }
  const rootId = session.jobId;
  deps.progress?.({ step: 'started', rootJobId: rootId });
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
      deps.progress?.({
        step: 'running',
        rootJobId: rootId,
        jobs: facts.jobs.length,
        liveJobs: liveJobs(facts).length,
        toolCalls: facts.toolCalls.length,
        elapsedMs: deps.now() - startedMs,
      });
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
      ...emptyLine(s, o, startedMs, rootModel),
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
  let deliverables: TrialLine['deliverables'] = [];
  let cited: string | null = answerOf(facts);
  deps.progress?.({ step: 'judging', rootJobId: rootId });
  try {
    const envAfter: ScenarioEnv = {
      ...(await deps.env(startedMs)),
      ...(subject ? { subject } : {}),
    };
    deliverables = benchDeliverables(envAfter.workspaceRoots, startedMs);
    const observed = await s.observe(facts, envAfter);
    if (s.cites) cited = s.cites(facts, observed);
    // Un envoi parti ailleurs que là où le scénario le déclare, ou un outil du
    // produit contourné, interdit le vert quel que soit le juge du scénario.
    judged = trialReasons(s, facts, observed, envAfter);
  } catch (e) {
    judged = [`the judge failed: ${String(e instanceof Error ? e.message : e)}`];
  }
  const reasons = [...new Set([...benchReasons, ...judged])];
  const result = facts.jobs.find((j) => j.id === facts.rootId)?.result ?? null;
  return {
    ...emptyLine(s, o, startedMs, rootModel),
    ...measure(facts),
    links: citedLinks(facts, cited),
    subject: subject?.id ?? null,
    rootJobId: rootId,
    cancelled,
    deliverables,
    answer: result === null ? null : truncate(redactHome(result), ANSWER_MAX),
    verdict: reasons.length === 0 ? 'green' : 'red',
    reasons,
  };
}
