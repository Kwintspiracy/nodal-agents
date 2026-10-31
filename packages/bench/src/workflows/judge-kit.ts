// workflows/judge-kit.ts — les lectures que partagent les juges.
//
// Fonctions pures sur la photo d'un essai (`TreeFacts`). Aucune n'interroge le
// modèle ni ne croit ce qu'il affirme : une délégation est un job enfant, un
// envoi est une sortie d'outil qui dit `ok`. Qu'une source citée ait été LUE
// n'est pas jugé ici : aucune ligne de la base ne le dit de façon fiable (#648).
// Qu'un lien ou un fait ait été VU dans la sortie d'un outil web, si : c'est
// une ligne `tool_calls` (`citedLinks`, `factsNotSeenOnTheWeb`).
//
// Les règles de CHEMIN (décision 1 du 17/10 : un outil du produit disponible
// doit servir) sont écrites ici une fois et s'appliquent à tout scénario qui
// déclare `productTools`, par runTrial, jamais dans un juge particulier.

import { DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import type { FileReadFact, FileWriteFact, JobFact, ToolCallFact, TreeFacts } from './facts';
import type {
  AnyScenario,
  CitedLink,
  FileState,
  PathJob,
  ProductFileState,
  ScenarioEnv,
  UnverifiedCheck,
} from './types';

/** Le job de tête de l'essai. */
export function rootJob(facts: TreeFacts): JobFact | undefined {
  return facts.jobs.find((j) => j.id === facts.rootId);
}

/** Les jobs nés d'une délégation (tout job de l'arbre qui n'est pas la tête). */
export function delegatedJobs(facts: TreeFacts): JobFact[] {
  return facts.jobs.filter((j) => j.id !== facts.rootId);
}

/**
 * Une demande qui appelle UNE délégation, faite une fois (#886) : la tête qui
 * confie le même travail à un second membre de l'équipe, son premier compte
 * rendu reçu, le refait. Lu sur les jobs enfants de la tête, jamais sur ce
 * qu'elle écrit.
 */
export function delegatedOnce(facts: TreeFacts): string[] {
  const direct = facts.jobs.filter((j) => j.parentJobId === facts.rootId);
  if (direct.length <= 1) return [];
  return [
    `the root delegated ${direct.length} times for one request (${direct.map((j) => j.agentSlug ?? j.id.slice(0, 8)).join(', ')}): the work was repeated`,
  ];
}

/** Les appels d'un outil, par son nom (le préfixe d'un connecteur `x__` compris). */
export function callsOf(facts: TreeFacts, name: string | RegExp): ToolCallFact[] {
  return facts.toolCalls.filter((c) =>
    typeof name === 'string'
      ? c.toolName === name || c.toolName.endsWith(`__${name}`)
      : name.test(c.toolName),
  );
}

export function parseJson(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/** An object, or a string that is the JSON of one; null for anything else. */
function jsonObject(v: unknown): Record<string, unknown> | null {
  const o = typeof v === 'string' ? parseJson(v) : v;
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
}

const URL_RE = /https?:\/\/[^\s<>"'`\])}|\\]+/gi;

/**
 * Une adresse sous sa forme comparable : sans la ponctuation qui la suit dans
 * une phrase, sans fragment, sans `www.`, sans barre finale, en minuscules pour
 * l'hôte. Deux écritures d'une même page doivent tomber sur la même clé.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.replace(/[.,;:!?*_~]+$/, '');
  try {
    const u = new URL(trimmed);
    u.hash = '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** Les adresses distinctes d'un texte, normalisées. Les échappements JSON (`\/`) sont défaits d'abord. */
export function urlsIn(text: string | null): string[] {
  if (!text) return [];
  const plain = text.replace(/\\\//g, '/');
  const out = new Set<string>();
  for (const m of plain.matchAll(URL_RE)) {
    const n = normalizeUrl(m[0]);
    if (n) out.add(n);
  }
  return [...out];
}

/** Le nom d'un outil sans son préfixe de connecteur (`x__`) ni celui des outils internes d'une CLI (`cli:`). */
export function bareToolName(name: string): string {
  const unprefixed = name.replace(/^cli:/, '');
  const i = unprefixed.lastIndexOf('__');
  return i === -1 ? unprefixed : unprefixed.slice(i + 2);
}

/**
 * Les outils qui vont sur le web : chercher, lire une page, parcourir un site.
 * Les noms sont ceux que les lignes `tool_calls` portent réellement — builtin
 * `web_search`, connecteurs Tavily, Firecrawl et Apify, serveur MCP fetch
 * (`fetch_html`, `fetch_txt`…), outils internes d'une CLI (`cli:WebSearch`,
 * `cli:WebFetch`). Un APPEL, rien de plus : ce qu'il a rendu n'est pas jugé
 * (« sources read », non vérifié, #648).
 */
const WEB_TOOL =
  /^(web_?search|web_?fetch|fetch(_[a-z]+)?|tavily_[a-z]+|firecrawl_[a-z_]+|apify_(web_browse|run_actor)|read_web_page|get_page_images|scrape[a-z_]*)$/i;

export function isWebTool(c: ToolCallFact): boolean {
  return WEB_TOOL.test(bareToolName(c.toolName));
}

/** Ce que lit `commonReasons`, dit pour Bench Studio. */
export const JUDGED_ROOT_COMPLETED = 'agent_jobs: the root job of the trial ended completed';
export const JUDGED_NOBODY_ASKED =
  'approval_requests: the tree raised no approval and no question (the bench never answers one)';
export const JUDGED_COMMON = [JUDGED_ROOT_COMPLETED, JUDGED_NOBODY_ASKED] as const;
/** Ce que lit `channelSends`. */
export const JUDGED_NO_CHANNEL_SEND =
  'tool_calls and job_deliveries: no send tool called, no reply delivered to Telegram, Discord, Slack or WhatsApp';

/**
 * Les raisons communes à tous les scénarios : la tête a fini `completed`, et
 * personne n'a été sollicité. Une approbation ou une question levée par un
 * essai est un ROUGE : un workflow ordinaire qui s'arrête pour demander est
 * exactement la panne que le banc doit voir.
 */
export function commonReasons(facts: TreeFacts): string[] {
  const reasons: string[] = [];
  const root = rootJob(facts);
  if (!root) reasons.push('the root job is missing');
  else if (root.status !== 'completed') {
    reasons.push(
      `root ended ${root.status ?? 'without a status'}${root.error ? `: ${root.error.slice(0, 200)}` : ''}`,
    );
  }
  return [...reasons, ...nobodyAsked(facts)];
}

/**
 * Personne n'a été sollicité : ni approbation, ni question, ni formulaire. La
 * moitié de `commonReasons`, pour les scénarios dont la tête a le droit de NE
 * PAS finir `completed` (un blocage expliqué est la bonne fin d'une demande
 * impossible).
 */
export function nobodyAsked(facts: TreeFacts): string[] {
  const reasons: string[] = [];
  const approvals = facts.approvals.filter((a) => a.kind !== 'question');
  const questions = facts.approvals.filter((a) => a.kind === 'question');
  if (approvals.length > 0) {
    reasons.push(`asked an approval (${approvals.map((a) => a.toolName).join(', ')})`);
  }
  if (questions.length > 0) reasons.push(`asked the owner a question (${questions.length})`);
  return reasons;
}

/** Nombre sans ambiguïté dans un texte : `277.6`, `277,6` ou `277.60` valent 277.6. */
export function textHasNumber(text: string | null, value: number, decimals: number): boolean {
  if (!text) return false;
  const target = value.toFixed(decimals);
  for (const m of text.matchAll(/-?\d[\d   ]*(?:[.,]\d+)?/g)) {
    const n = Number(m[0].replace(/[   ]/g, '').replace(',', '.'));
    if (Number.isFinite(n) && n.toFixed(decimals) === target) return true;
  }
  return false;
}

/**
 * Ce qui est parti vers un canal de messagerie (Telegram, Discord, Slack,
 * WhatsApp) pendant l'essai : un appel d'un outil d'envoi (la liste unique du
 * produit, `DELIVERY_TOOL_NAMES`) ou une livraison de réponse consignée dans
 * `job_deliveries`. Une demande partie par MCP reçoit sa réponse comme résultat
 * du job, jamais sur le canal du propriétaire (#649).
 */
export function channelSends(facts: TreeFacts): string[] {
  const reasons: string[] = [];
  const delivery = new Set<string>(DELIVERY_TOOL_NAMES);
  const sends = facts.toolCalls.filter((c) => delivery.has(bareToolName(c.toolName)));
  if (sends.length > 0) {
    reasons.push(
      `a send tool was called (${[...new Set(sends.map((c) => bareToolName(c.toolName)))].join(', ')})`,
    );
  }
  if (facts.deliveries.length > 0) {
    reasons.push(
      `a reply was delivered to a channel (${facts.deliveries.map((d) => `${d.channel} ${d.outcome}`).join(', ')})`,
    );
  }
  return reasons;
}

/**
 * Le job a fini sur un blocage EXPLIQUÉ : statut `failed`, et son dernier
 * `return_result` dit `blocked` avec une raison. C'est, dans le contrat
 * d'aujourd'hui (`return-result.ts`), la seule fin qui dit « l'action demandée
 * n'a pas été faite » : un `failed` sur une erreur (délai, plafond anti-boucle)
 * n'en est pas une, un `completed` non plus.
 *
 * L'appel est lu dans le transcript du job (`returnResults`), pas dans
 * `tool_calls` : `return_result` est un signal de la boucle, il n'y laisse
 * aucune ligne. La colonne `error` d'un blocage porte la première phrase de la
 * raison (`shortBlockReason`), du texte libre : la lire pour reconnaître un
 * blocage serait deviner.
 */
export function endedBlocked(facts: TreeFacts, job: JobFact): boolean {
  if (job.status !== 'failed') return false;
  const calls = facts.returnResults.filter((c) => c.jobId === job.id);
  const last = calls[calls.length - 1];
  if (!last) return false;
  const input = jsonObject(parseJson(last.input));
  return (
    input?.['status'] === 'blocked' &&
    typeof input['reason'] === 'string' &&
    input['reason'].trim() !== ''
  );
}

/** La fin d'un job, en clair, pour une raison de rouge. */
export function describeEnd(job: JobFact): string {
  return `${job.status ?? 'no status'}${job.error ? ` (${job.error.slice(0, 160)})` : ''}`;
}

// ─── sources read : non vérifié ──────────────────────────────────────────────

/**
 * « Une source citée a réellement été lue » n'est PAS jugé. Quatre passes de
 * revue de #634 ont trouvé quatre fuites dans le juge qui le devinait à partir
 * des sorties d'outils (une entrée prise pour une lecture, un échec CLI en
 * texte, un échec MCP sérialisé en chaîne, puis Firecrawl/Apify invisibles et
 * une page 404 prise pour du contenu). Décision de Quentin, 30/09 : le contrôle
 * sort des juges jusqu'à ce que la plateforme enregistre chaque lecture web
 * (#648), et il est dit sur chaque ligne, jamais tu.
 */
export const SOURCES_READ: UnverifiedCheck = {
  check: 'sources read',
  state: 'not verified',
  reason:
    'Nothing in the database records which web addresses a run really read; guessing it from tool outputs leaked four times.',
  ticket: '#648',
};

// ─── commandes ───────────────────────────────────────────────────────────────

/** Un outil qui exécute une commande, quel que soit le runtime (produit, CLI). */
export const COMMAND_TOOL = /(^|__)(run_command|run_skill_script|bash|shell|execute_command)$/i;
/** Une commande qui lance un script. */
export const SCRIPT_RUNNER = /\b(python3?|py|node|deno|bun)\b/i;

/** Les appels d'un outil de commande dont l'entrée correspond à `pattern`. */
export function commandRuns(facts: TreeFacts, pattern: RegExp): ToolCallFact[] {
  return facts.toolCalls.filter(
    (c) => COMMAND_TOOL.test(bareToolName(c.toolName)) && pattern.test(c.input ?? ''),
  );
}

// ─── réponses ────────────────────────────────────────────────────────────────

/** La réponse finale du job de tête, ou une chaîne vide. */
export function answerOf(facts: TreeFacts): string {
  return rootJob(facts)?.result ?? '';
}

/** Un fait attendu dans un texte : ce qui le reconnaît, et ce que le rouge dira s'il manque. */
export interface ExpectedFact {
  readonly holds: (text: string) => boolean;
  readonly says: string;
}

/** Un fait reconnu par un motif. */
export function matches(pattern: RegExp, says: string): ExpectedFact {
  return { holds: (t) => pattern.test(t), says };
}

/** Un nombre, quelle que soit son écriture (`604 800`, `397,8`, `397.80`). */
export function hasNumber(value: number, decimals: number, says: string): ExpectedFact {
  return { holds: (t) => textHasNumber(t, value, decimals), says };
}

/** Les faits absents d'un texte, chacun en une raison de rouge (`where` : « the answer », « the report »…). */
export function missingFacts(
  text: string,
  facts: readonly ExpectedFact[],
  where: string,
): string[] {
  return facts.filter((f) => !f.holds(text)).map((f) => `${where} does not ${f.says}`);
}

/** Le job de tête a fait le travail lui-même : une délégation est un rouge, nommé (`what` : ce qui a été délégué). */
export function noDelegation(facts: TreeFacts, what = 'a direct question'): string[] {
  const d = delegatedJobs(facts);
  return d.length === 0
    ? []
    : [`delegated ${what} (${d.map((j) => j.agentSlug ?? j.id.slice(0, 8)).join(', ')})`];
}

/** Un job de l'arbre, quel qu'il soit, a appelé un outil web. */
export function treeCalledTheWeb(facts: TreeFacts): boolean {
  return facts.toolCalls.some(isWebTool);
}

/** Les hôtes distincts des adresses d'un texte : deux pages d'un même site comptent pour un. */
export function hostsIn(text: string | null): string[] {
  return [...new Set(urlsIn(text).map((u) => u.split('/')[0]!))];
}

// ─── le chemin ───────────────────────────────────────────────────────────────

/**
 * Le chemin de l'arbre, job par job dans l'ordre de leur création : l'agent,
 * le job qui l'a délégué, et les outils appelés, par leur nom et dans l'ordre.
 * Un appel sans job connu de l'arbre est rangé sous un job `no job`, jamais
 * perdu.
 */
export function toolPath(facts: TreeFacts): PathJob[] {
  const ids = new Set(facts.jobs.map((j) => j.id));
  const path: PathJob[] = facts.jobs.map((j) => ({
    job: j.id.slice(0, 8),
    agent: j.agentSlug,
    parent: j.parentJobId === null ? null : j.parentJobId.slice(0, 8),
    tools: facts.toolCalls.filter((c) => c.jobId === j.id).map((c) => c.toolName),
  }));
  const orphans = facts.toolCalls.filter((c) => c.jobId === null || !ids.has(c.jobId));
  if (orphans.length > 0)
    path.push({ job: 'no job', agent: null, parent: null, tools: orphans.map((c) => c.toolName) });
  return path;
}

/** Les agents des jobs délégués, dans l'ordre de leur création. */
export function delegatedAgents(facts: TreeFacts): string[] {
  return delegatedJobs(facts).map((j) => j.agentSlug ?? j.id.slice(0, 8));
}

/** Le job de tête a appelé un outil web lui-même. */
export function rootCalledTheWeb(facts: TreeFacts): boolean {
  return facts.toolCalls.some((c) => c.jobId === facts.rootId && isWebTool(c));
}

/** Un job délégué a appelé un outil web. Ce que cet appel a rendu n'est pas jugé ici. */
export function delegateCalledTheWeb(facts: TreeFacts): boolean {
  const kids = new Set(delegatedJobs(facts).map((j) => j.id));
  return facts.toolCalls.some((c) => c.jobId !== null && kids.has(c.jobId) && isWebTool(c));
}

// ─── vu sur le web (#648, la partie mesurable) ───────────────────────────────

/**
 * Le texte d'une sortie d'outil, chaînes JSON défaites : une sortie JSON est
 * lue par ses valeurs texte (un « é » échappé y redevient un « é »), toute
 * autre sortie telle quelle.
 */
function outputText(output: string | null): string {
  if (output === null) return '';
  const parsed = parseJson(output);
  if (parsed === null || typeof parsed !== 'object') return output;
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(parsed);
  return out.join('\n');
}

/**
 * Les adresses VUES dans l'arbre : celles qu'une sortie d'outil web porte, sans
 * celles que ce même appel avait reçues en entrée. Une page demandée et
 * introuvable (« 404 https://x ») ne rend donc pas son adresse « vue » :
 * l'appel ne fait que la répéter. C'est la fuite n°4 de #634, fermée par la
 * forme de la règle et non par un cas particulier.
 */
export function urlsSeenOnTheWeb(facts: TreeFacts): Set<string> {
  const seen = new Set<string>();
  for (const c of facts.toolCalls.filter(isWebTool)) {
    const asked = new Set(urlsIn(c.input));
    for (const u of urlsIn(c.output)) if (!asked.has(u)) seen.add(u);
  }
  return seen;
}

/** Chaque lien d'un texte, classé vu ou non vu (voir `urlsSeenOnTheWeb`). */
export function citedLinks(facts: TreeFacts, text: string | null): CitedLink[] {
  const seen = urlsSeenOnTheWeb(facts);
  return urlsIn(text).map((url) => ({ url, seen: seen.has(url) }));
}

/** La raison du rouge quand des liens cités n'ont été vus dans aucune sortie d'outil web. */
export function unseenLinkReasons(links: readonly CitedLink[], where: string): string[] {
  const unseen = links.filter((l) => !l.seen).map((l) => l.url);
  return unseen.length === 0
    ? []
    : [
        `${where} cites ${unseen.length} link(s) seen in no web tool output of the run: ${unseen.slice(0, 5).join(', ')}${unseen.length > 5 ? ', …' : ''}`,
      ];
}

/**
 * Les faits attendus qu'AUCUNE sortie d'outil web de l'arbre ne porte : la
 * preuve qu'un fait vient du web et non de la mémoire du modèle.
 */
export function factsNotSeenOnTheWeb(
  facts: TreeFacts,
  expected: readonly ExpectedFact[],
): string[] {
  const web = facts.toolCalls
    .filter(isWebTool)
    .map((c) => outputText(c.output))
    .join('\n');
  return expected
    .filter((f) => !f.holds(web))
    .map(
      (f) =>
        `no web tool output of the run holds the fact (${f.says}): it may come from the model's memory`,
    );
}

// ─── décision 1 : un outil du produit disponible doit servir ─────────────────
//
// Deux versions de cette règle devinaient l'écriture : la première à la
// simple MENTION du fichier par une commande (revue de #777, passe 1 : un
// alibi passait vert, une commande qui ne faisait que lire passait rouge), la
// seconde à la DATE du fichier (passe 2 : une sous-chaîne de l'entrée prise
// pour un chemin, une fenêtre d'une seconde invisible, un « dernier » appel
// choisi sur l'heure). Elle ne devine plus : elle LIT ce que la plateforme
// enregistre de chaque écriture (`tool_call_writes`, #779, #780) et suit la
// CHAÎNE D'EMPREINTES d'un livrable dans l'ordre `seq` :
//
//   - l'état de départ est celui que le banc a préparé (la fixture posée,
//     sinon aucun fichier) ;
//   - chaque écriture enregistrée part de l'état laissé par la précédente
//     (sinon, quelque chose qui n'a rien enregistré a écrit entre les deux) ;
//   - chaque écriture qui change le fichier est celle d'un outil attendu, et
//     son état après est prouvé par les OCTETS QU'IL A ÉCRITS (`written`) ;
//     une relecture (`read`) n'est pas une preuve : « not recorded » ;
//   - l'état final du disque est celui de la dernière écriture (sinon, quelque
//     chose qui n'a rien enregistré a écrit après).
//
// Une commande, un harnais ou un outil MCP qui écrit le livrable ne laisse
// aucune ligne : la chaîne se rompt, et c'est rouge, quel que soit son nom. Une
// commande qui ne fait que LIRE ne change rien : la chaîne tient. Un script qui
// écrit le contenu AVANT un dernier appel de l'outil du produit rompt la
// chaîne aussi : l'état avant de cet appel n'est plus celui de la précédente.
//
// Un fichier à LIRE suit la même idée : la règle ne reconstruit pas après coup
// le fichier qu'un appel désignait (revue de #777, passes 3 et 4 : une copie
// sous un dossier dont le chemin finit pareil, des dossiers d'agent relus au
// moment du jugement sans le dossier du job). Elle LIT ce que la plateforme a
// enregistré au moment de la lecture (`tool_call_reads`, #783) : le chemin
// réel ouvert et l'empreinte des octets lus. La lecture est celle du fichier
// posé quand un outil attendu a lu, au chemin réel où le banc l'a posé, les
// octets de la fixture :
//
//   - une copie identique ailleurs a la bonne empreinte et un autre chemin :
//     rouge ;
//   - le fichier posé, changé avant d'être lu, a le bon chemin et une autre
//     empreinte : rouge ;
//   - aucune ligne : « not recorded », rouge, jamais vert.
//
// Un outil MCP (`request_print`) ouvre le fichier dans son propre processus :
// la plateforme n'enregistre aucune lecture, et un scénario ne peut pas
// l'exiger (#784) : le fichier imprimé se juge sur l'enregistrement de
// l'imprimante du banc (#794, printer/), qui a reçu les octets.

/** Le début de la raison du rouge, le même pour tous les scénarios. */
export const PRODUCT_TOOL_NOT_USED = 'product tool available, not used';

const teamHasTool = (teamTools: readonly string[], bare: string): boolean =>
  teamTools.some((t) => t === bare || t.endsWith(`__${bare}`));

/** Les outils du produit du scénario que l'équipe a ; vide quand le scénario n'en déclare pas. */
export function availableProductTools(
  s: AnyScenario,
  env: Pick<ScenarioEnv, 'teamTools'>,
): string[] {
  return (s.productTools?.tools ?? []).filter((t) => teamHasTool(env.teamTools, t));
}

/**
 * Avant tout lancement : un scénario qui déclare des outils du produit et dont
 * AUCUN n'est dans les outils de l'équipe est sauté, avec cette raison.
 */
export function productToolGate(s: AnyScenario, env: Pick<ScenarioEnv, 'teamTools'>): string[] {
  if (!s.productTools) return [];
  return availableProductTools(s, env).length > 0
    ? []
    : [
        `no agent of this workspace has the product tool this scenario is about (${s.productTools.tools.join(', ')})`,
      ];
}

const sameState = (a: { kind: string; sha256?: string | null }, b: FileState): boolean =>
  a.kind === b.kind && (a.kind !== 'file' || (b.kind === 'file' && a.sha256 === b.sha256));

const showState = (st: FileState): string =>
  st.kind === 'file' ? `sha-256 ${st.sha256.slice(0, 12)}` : st.kind;

const beforeOf = (w: FileWriteFact): FileState =>
  w.beforeKind === 'file' ? { kind: 'file', sha256: w.beforeSha256 ?? '' } : { kind: w.beforeKind };
const afterOf = (w: FileWriteFact): FileState =>
  w.afterKind === 'file' ? { kind: 'file', sha256: w.afterSha256 ?? '' } : { kind: w.afterKind };

/**
 * Après l'essai, la règle de chemin (voir l'en-tête de la section). `files` :
 * les livrables tels que le banc les connaît hors de la base
 * (`productFileStates`). Un scénario sans outil déclaré, ou dont aucun n'est
 * disponible (sauté avant), ne reçoit aucune raison d'ici.
 */
export function productToolReasons(
  s: AnyScenario,
  facts: TreeFacts,
  env: Pick<ScenarioEnv, 'teamTools'>,
  files: readonly ProductFileState[],
): string[] {
  const available = availableProductTools(s, env);
  if (available.length === 0 || !s.productTools) return [];
  const isExpected = (toolName: string): boolean => available.includes(bareToolName(toolName));
  const { writes, reads } = s.productTools;
  if (writes.length === 0 && reads.length === 0)
    return facts.toolCalls.some((c) => isExpected(c.toolName))
      ? []
      : [`${PRODUCT_TOOL_NOT_USED}: none of ${available.join(', ')} was called`];
  const r: string[] = [];
  for (const rel of reads) {
    const file = files.find((f) => f.rel === rel);
    if (!file) {
      r.push(
        `${PRODUCT_TOOL_NOT_USED}: the bench did not prepare ${rel}, so its read cannot be judged`,
      );
      continue;
    }
    r.push(...readReasons(rel, file, facts.reads, isExpected, available));
  }
  for (const rel of writes) {
    const file = files.find((f) => f.rel === rel);
    if (!file) {
      r.push(
        `${PRODUCT_TOOL_NOT_USED}: the bench did not read ${rel} on disk, so its writes cannot be followed`,
      );
      continue;
    }
    r.push(...chainReasons(rel, file, facts.writes, isExpected, available));
  }
  return r;
}

/** La lecture d'un fichier posé : son chemin réel ET l'empreinte de la fixture (voir l'en-tête). */
function readReasons(
  rel: string,
  file: ProductFileState,
  allReads: readonly FileReadFact[],
  isExpected: (toolName: string) => boolean,
  available: readonly string[],
): string[] {
  const posed = file.initial;
  if (posed.kind !== 'file')
    return [
      `${PRODUCT_TOOL_NOT_USED}: the bench posed no fixture at ${rel}, so a read of it cannot be judged`,
    ];
  const byTool = allReads.filter((x) => isExpected(x.toolName));
  const atPosed = byTool.filter((x) => x.path === file.posedPath);
  if (atPosed.some((x) => x.sha256 === posed.sha256)) return [];
  const tools = available.join(', ');
  const first = atPosed[0];
  if (first)
    return [
      `${PRODUCT_TOOL_NOT_USED}: ${rel} was read by ${bareToolName(first.toolName)} (seq ${first.seq}), not in the state the bench posed (read ${showState({ kind: 'file', sha256: first.sha256 })}, posed ${showState(posed)})`,
    ];
  const copy = byTool.find((x) => x.sha256 === posed.sha256);
  return [
    copy
      ? `${PRODUCT_TOOL_NOT_USED}: no call of ${tools} reads ${rel}; ${bareToolName(copy.toolName)} (seq ${copy.seq}) read an identical copy at another path`
      : `${PRODUCT_TOOL_NOT_USED}: no call of ${tools} reads ${rel} (no read of it is recorded in tool_call_reads: not recorded)`,
  ];
}

/** La chaîne d'empreintes d'un livrable, de l'état préparé à l'état final (voir l'en-tête). */
function chainReasons(
  rel: string,
  file: ProductFileState,
  allWrites: readonly FileWriteFact[],
  isExpected: (toolName: string) => boolean,
  available: readonly string[],
): string[] {
  // Dans l'ordre `seq`, quel que soit l'ordre où les lignes arrivent : deux
  // appels parallèles ont le même instant, jamais le même `seq`.
  const chain = allWrites
    .filter((w) => file.realPaths.includes(w.path))
    .sort((a, b) => a.seq - b.seq);
  const r: string[] = [];
  if (!chain.some((w) => isExpected(w.toolName) && w.afterSource === 'written'))
    r.push(
      `${PRODUCT_TOOL_NOT_USED}: no write of ${rel} by ${available.join(', ')} is recorded with the bytes it wrote`,
    );
  let state: FileState = file.initial;
  let previous = 'the bench prepared it';
  for (const w of chain) {
    const before = beforeOf(w);
    const after = afterOf(w);
    const who = `${bareToolName(w.toolName)} (seq ${w.seq})`;
    if (!sameState(before, state))
      r.push(
        `${PRODUCT_TOOL_NOT_USED}: ${rel} was changed between ${previous} and ${who} by something that left no record (it was ${showState(state)}, then ${showState(before)})`,
      );
    const changed = !sameState(after, before);
    if (changed && !isExpected(w.toolName))
      r.push(
        `${PRODUCT_TOOL_NOT_USED}: ${rel} was written by ${who}, not one of ${available.join(', ')}`,
      );
    else if (changed && w.afterSource !== 'written')
      r.push(
        `${PRODUCT_TOOL_NOT_USED}: the write of ${rel} by ${who} is not recorded with the bytes it wrote (a re-read of the disk, never a proof)`,
      );
    state = after;
    previous = who;
  }
  if (!sameState(state, file.final))
    r.push(
      `${PRODUCT_TOOL_NOT_USED}: ${rel} was changed after ${previous} by something that left no record (expected ${showState(state)}, on disk ${showState(file.final)})`,
    );
  return r;
}

/** Les contrôles qu'un scénario ne vérifie pas : ceux qu'il déclare (la ligne d'essai et le catalogue les lisent ici). */
export function unverifiedOf(s: AnyScenario): UnverifiedCheck[] {
  return [...(s.unverified ?? [])];
}

/** Ce que les règles de chemin lisent pour ce scénario, dit pour Bench Studio. */
export function productToolJudgedBy(s: AnyScenario): string[] {
  if (!s.productTools) return [];
  const { tools, writes, reads } = s.productTools;
  const base = (rel: string) => rel.split('/').pop();
  return [
    `tool_calls: the product tools are ${tools.join(', ')}; with none of them in the team's tools, the trial is skipped; otherwise a breach is red: "${PRODUCT_TOOL_NOT_USED}"`,
    ...(writes.length === 0 && reads.length === 0
      ? ['tool_calls: the tree calls at least one of them']
      : []),
    ...writes.map(
      (rel) =>
        `tool_call_writes: the hash chain of ${base(rel)}, in seq order, goes from the state the bench prepared to the file on disk; every write that changes it is one of them, proven by the bytes it wrote (a re-read or a missing row reads as not recorded)`,
    ),
    ...reads.map(
      (rel) =>
        `tool_call_reads: one of them read ${base(rel)} at the real path where the bench posed it (${rel} in the shared folder), with the sha-256 of the fixture; an identical copy elsewhere, a file changed before the read, or no row (not recorded) is red`,
    ),
  ];
}
