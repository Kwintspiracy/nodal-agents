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

import { join } from 'node:path';
import { benchDeliverables, findInRoots } from './disk';
import { fileHash, fixturePath, prepareTrial, sharedRoot } from './fixtures';
import type { TreeFacts } from './facts';
import { isLive, liveJobs, pendingApprovals } from './facts';
import { cheminConstate, DELIVERY_TOOL_NAMES, PURPOSE_KEY } from '@nodal-agents/tools';
import {
  answerOf,
  channelSends,
  citedLinks,
  delegatedAgents,
  parseJson,
  productToolGate,
  productToolReasons,
  toolPath,
  unverifiedOf,
} from './judge-kit';
import { isOutboundTool, missingNeeds } from './needs';
import { scenarioToolsFingerprint } from './scenario-tools';
import { isBenchPrinterTool, type BenchPrinterState } from '../printer/identity';
import { rotateRecords } from '../printer/record';
import { redactHome } from './redact';
import type { ForeignActivity } from './stack';
import { noSubjectReason, pickSubject, requestWithSubject, type ResearchSubject } from './subjects';
import type {
  AnyScenario,
  FileState,
  ModelUse,
  ProductFileState,
  ScenarioEnv,
  TrialLine,
} from './types';

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
  /** Ce que la ligne porte d'une campagne (voir `TrialLine.campaign`). */
  readonly campaign?: string | null;
  readonly configFingerprint?: string | null;
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
    campaign: o.campaign ?? null,
    configFingerprint: o.configFingerprint ?? null,
    scenarioToolsFingerprint: scenarioToolsFingerprint(s.tools),
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
 * Une seule règle pour tout outil sortant (`isOutboundTool` : un verbe sortant,
 * impression comprise, ou un canal, fermé par défaut), quel que soit le
 * `sends` du scénario : il est rouge, nommé dans la raison. La seule
 * exemption est la livraison que `sends` permet :
 *   - `nothing` : aucune. Une livraison de réponse ou un outil d'envoi du
 *     produit est rouge aussi (`channelSends`) ;
 *   - `owner` : UNE chose sortante, la livraison du PRODUIT au chat du
 *     propriétaire (revue de #777, passe 9 : une impression passait verte
 *     sous `owner`). Sans cible, le produit livre au propriétaire de la
 *     conversation ; une livraison qui NOMME une cible (un champ de
 *     destination de son schéma, `DELIVERY_TARGET_FIELDS`) est rouge, quelle
 *     que soit sa valeur : les outils livrent à toute conversation approuvée,
 *     celle d'un membre comprise (passe 11 : un texte cherché par motif
 *     laissait passer `chatId: '1234567'`). Un champ que le banc ne connaît
 *     pas est rouge aussi : il pourrait nommer une cible.
 * L'imprimante du banc (#794) est exemptée comme un outil du produit : sur
 * l'identité de son SERVEUR, jamais sur un nom d'outil seul. L'exemption n'existe
 * que si l'espace l'a ATTACHÉE (`benchPrinter.kind === 'attached'` : sa
 * déclaration entière est celle du banc, `benchPrinterState`) ET que l'outil est
 * un des siens. Elle n'imprime rien ; un `request_print` d'un autre serveur, ou
 * d'un serveur qui prétend l'être, reste sortant.
 * L'exemption se décide sur l'IDENTITÉ de l'outil, jamais sur un nom qui lui
 * ressemble (passe 10) : un outil de livraison du produit, à son nom EXACT,
 * tel que le runner le range dans `tool_calls` (sans préfixe :
 * `DELIVERY_TOOL_NAMES`). Un outil MCP ou de CLI du même nom nu
 * (`x__send_image`, `cli:send_image`) n'est pas le sien : il est sortant. Un
 * envoi de courrier non plus : ce n'est pas le chat du propriétaire, et son
 * destinataire ne se vérifie pas ; fermé par défaut, il est rouge.
 * Un scénario `test-account:` n'est jamais lancé (aucun compte de test n'est
 * branché, `destinationGate`) : rien n'est jugé ici pour lui.
 */
export function destinationReasons(
  s: AnyScenario,
  facts: TreeFacts,
  benchPrinter: BenchPrinterState = { kind: 'absent' },
): string[] {
  if (s.sends !== 'nothing' && s.sends !== 'owner') return [];
  const delivery = new Set<string>(DELIVERY_TOOL_NAMES);
  /** Un outil de livraison du produit, à son nom exact : jamais un préfixe retiré. */
  const isProductDelivery = (toolName: string): boolean => delivery.has(toolName);
  const outbound = facts.toolCalls
    .filter(
      (c) =>
        isOutboundTool(c.toolName) &&
        !isProductDelivery(c.toolName) &&
        !(benchPrinter.kind === 'attached' && isBenchPrinterTool(c.toolName)),
    )
    .map((c) => c.toolName);
  const outboundReasons =
    outbound.length > 0
      ? [`an outbound tool was called (${[...new Set(outbound)].join(', ')})`]
      : [];
  if (s.sends === 'nothing') return [...channelSends(facts), ...outboundReasons];
  const targetReasons = facts.toolCalls
    .filter((c) => isProductDelivery(c.toolName))
    .flatMap((c) => deliveryTargetReasons(c.toolName, c.input));
  return [...new Set(targetReasons), ...outboundReasons];
}

/**
 * Les champs d'une livraison du produit qui en choisissent la DESTINATION,
 * lus dans les schémas des outils de livraison (@nodal-agents/tools,
 * communication/) : `chatId` (une conversation) et `channel` (une autre
 * plateforme). Sans eux, le produit livre à la conversation du job.
 */
export const DELIVERY_TARGET_FIELDS = ['chatId', 'channel'] as const;
/**
 * Les champs de leur CONTENU, et la raison que la plateforme ajoute à toute
 * demande (`PURPOSE_KEY`). trial.test.ts compare ces deux listes aux schémas
 * réels : un champ nouveau d'un outil de livraison y échoue.
 */
export const DELIVERY_CONTENT_FIELDS = [
  'source',
  'filename',
  'caption',
  'text',
  PURPOSE_KEY,
] as const;

/** Pourquoi une livraison du produit ne va pas, ou pas sûrement, au chat du propriétaire. */
function deliveryTargetReasons(toolName: string, input: string | null): string[] {
  const parsed = parseJson(input);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return [
      `a product delivery whose input cannot be read (${toolName}): sends: owner cannot tell where it went`,
    ];
  const fields = parsed as Record<string, unknown>;
  const targets = DELIVERY_TARGET_FIELDS.filter(
    (f) => fields[f] !== undefined && fields[f] !== null && fields[f] !== '',
  ).map((f) => `${f}=${String(fields[f])}`);
  const known = new Set<string>([...DELIVERY_TARGET_FIELDS, ...DELIVERY_CONTENT_FIELDS]);
  const unknown = Object.keys(fields).filter((k) => !known.has(k));
  return [
    ...(targets.length > 0
      ? [
          `a product delivery names an explicit target (${toolName}: ${targets.join(', ')}): sends: owner allows only the owner's own chat`,
        ]
      : []),
    ...(unknown.length > 0
      ? [
          `a product delivery carries a field the bench does not know (${toolName}: ${unknown.join(', ')}): it may name a target, so sends: owner refuses it`,
        ]
      : []),
  ];
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
  env: Pick<ScenarioEnv, 'teamTools' | 'benchPrinter'>,
  files: readonly ProductFileState[],
): string[] {
  return [
    ...new Set([
      ...s.judge(facts, observed),
      ...destinationReasons(s, facts, env.benchPrinter),
      ...productToolReasons(s, facts, env, files),
    ]),
  ];
}

/** L'état d'un fichier sur le disque : absent, son empreinte sha-256, ou illisible. */
function stateOf(path: string | null): FileState {
  if (path === null) return { kind: 'absent' };
  try {
    return { kind: 'file', sha256: fileHash(path) };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * Les fichiers d'un scénario (`productTools.writes` et `reads`), tels que le banc les
 * connaît hors de la base : leurs chemins réels possibles, un par dossier de
 * travail, résolus comme la plateforme les range (`cheminConstate`, le chemin
 * des lignes `tool_call_writes` et `tool_call_reads`) ; le chemin réel où le
 * banc pose la fixture (le dossier partagé) ; l'état préparé (la fixture que
 * le banc pose à ce chemin, sinon absent, `prepareTrial` effaçant les
 * sorties) ; et l'état final, celui du plus récent parmi les dossiers de
 * travail.
 */
export async function productFileStates(
  s: AnyScenario,
  roots: readonly string[],
): Promise<ProductFileState[]> {
  const out: ProductFileState[] = [];
  const pt = s.productTools;
  for (const rel of [...(pt?.writes ?? []), ...(pt?.reads ?? [])]) {
    const realPaths = await Promise.all(roots.map((root) => cheminConstate(join(root, rel))));
    const fixture = (s.fixtures ?? []).find((f) => f.to === rel);
    out.push({
      rel,
      realPaths,
      posedPath: await cheminConstate(join(sharedRoot(roots), rel)),
      initial: fixture ? stateOf(fixturePath(fixture.from)) : { kind: 'absent' },
      final: stateOf(findInRoots(roots, rel, 0)[0]?.path ?? null),
    });
  }
  return out;
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
    // Un essai ne se juge que sur ce qu'il a créé : les demandes que les essais
    // d'avant ont laissées dans le dossier de l'imprimante du banc sont mises de
    // côté AVANT que la demande ne parte (printer/record.ts, `rotateRecords`).
    if ((s.needs ?? []).includes('bench-printer') && envBefore.benchPrinter.kind === 'attached')
      rotateRecords(envBefore.benchPrinter.recordsDir, `${s.id}-${deps.now()}`);
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

  // La fin de l'essai : une demande reçue après n'est plus de lui.
  const endedMs = deps.now();
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
      endedMs,
      ...(subject ? { subject } : {}),
    };
    deliverables = benchDeliverables(envAfter.workspaceRoots, startedMs);
    const observed = await s.observe(facts, envAfter);
    if (s.cites) cited = s.cites(facts, observed);
    // Un envoi parti ailleurs que là où le scénario le déclare, ou un outil du
    // produit contourné, interdit le vert quel que soit le juge du scénario.
    judged = trialReasons(
      s,
      facts,
      observed,
      envAfter,
      await productFileStates(s, envAfter.workspaceRoots),
    );
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
