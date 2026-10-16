// workflows/judge-kit.ts — les lectures que partagent les juges.
//
// Fonctions pures sur la photo d'un essai (`TreeFacts`). Aucune n'interroge le
// modèle ni ne croit ce qu'il affirme : une délégation est un job enfant, un
// envoi est une sortie d'outil qui dit `ok`. Qu'une source citée ait été LUE
// n'est pas jugé ici : aucune ligne de la base ne le dit de façon fiable (#648).

import { MCP_TOOL_OUTPUT_FORMAT } from '@nodal-agents/shared';
import { DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import type { JobFact, ToolCallFact, TreeFacts } from './facts';
import type { UnverifiedCheck } from './types';

/** Le job de tête de l'essai. */
export function rootJob(facts: TreeFacts): JobFact | undefined {
  return facts.jobs.find((j) => j.id === facts.rootId);
}

/** Les jobs nés d'une délégation (tout job de l'arbre qui n'est pas la tête). */
export function delegatedJobs(facts: TreeFacts): JobFact[] {
  return facts.jobs.filter((j) => j.id !== facts.rootId);
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

/**
 * Le résultat structuré d'un outil MCP, tel que sa ligne `tool_calls` le garde.
 *
 * Deux formes de ligne, distinguées par une MARQUE et non par une forme :
 *  - l'enveloppe de l'adaptateur (`packages/adapters/mcp/src/result.ts`), dont
 *    `format` vaut `MCP_TOOL_OUTPUT_FORMAT` : la forme machine du serveur est
 *    sous `structuredContent`, sinon sous `toolResult` (protocole 2024-10-07),
 *    sinon écrite en JSON dans un bloc texte (ce que la spec recommande aux
 *    serveurs pour les clients qui ne lisent que `content`) ;
 *  - toute ligne SANS cette marque, écrite avant elle : la charge du serveur à
 *    la racine — même quand elle porte elle-même un tableau `content` (une page
 *    Notion, une liste CRM). Les essais réels enregistrés (fixtures) et toute
 *    base existante en portent.
 *
 * Un bloc texte se lit par `jsonInText` : la règle y est dite.
 */
export function mcpStructured(s: string | null): Record<string, unknown> | null {
  const record = jsonObject(parseJson(s));
  if (!record) return null;
  if (record['format'] !== MCP_TOOL_OUTPUT_FORMAT) return record;
  const payload = jsonObject(record['structuredContent']) ?? jsonObject(record['toolResult']);
  if (payload) return payload;
  const content = Array.isArray(record['content']) ? (record['content'] as unknown[]) : [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    const fromText = jsonInText(b.text);
    if (fromText) return fromText;
  }
  return null;
}

/**
 * L'objet JSON qu'un bloc texte porte, selon UNE règle : le bloc SE TERMINE
 * (blancs de fin ignorés) par un objet JSON dont l'accolade ouvre une ligne —
 * seuls des blancs la précèdent sur sa ligne. Le bloc entier qui est un objet
 * JSON, blancs de tête compris, en est le premier cas ; « phrase.\n{ … } » le
 * second. Une accolade au milieu d'une phrase n'ouvre jamais rien, et rien ne
 * doit suivre l'objet : un texte qui cite du JSON en passant n'est pas une
 * charge.
 */
function jsonInText(text: string): Record<string, unknown> | null {
  for (const line of text.matchAll(/^[ \t]*\{/gm)) {
    const found = jsonObject(text.slice((line.index ?? 0) + line[0].length - 1).trim());
    if (found) return found;
  }
  return null;
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

/** Le job de tête a répondu lui-même : une délégation est un rouge, nommé. */
export function noDelegation(facts: TreeFacts): string[] {
  const d = delegatedJobs(facts);
  return d.length === 0
    ? []
    : [`delegated a direct question (${d.map((j) => j.agentSlug ?? j.id.slice(0, 8)).join(', ')})`];
}

/** Un job de l'arbre, quel qu'il soit, a appelé un outil web. */
export function treeCalledTheWeb(facts: TreeFacts): boolean {
  return facts.toolCalls.some(isWebTool);
}

/** Les hôtes distincts des adresses d'un texte : deux pages d'un même site comptent pour un. */
export function hostsIn(text: string | null): string[] {
  return [...new Set(urlsIn(text).map((u) => u.split('/')[0]!))];
}
