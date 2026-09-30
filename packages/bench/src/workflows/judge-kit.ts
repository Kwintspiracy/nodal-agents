// workflows/judge-kit.ts — les lectures que partagent les juges.
//
// Fonctions pures sur la photo d'un essai (`TreeFacts`). Aucune n'interroge le
// modèle ni ne croit ce qu'il affirme : une délégation est un job enfant, une
// source est une adresse RENDUE par un outil de recherche ou de lecture web qui
// a réussi (jamais une adresse que le modèle a lui-même écrite), un envoi est
// une sortie d'outil qui dit `ok`.

import type { JobFact, ToolCallFact, TreeFacts } from './facts';

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
 * Les outils qui RAMÈNENT du web : chercher, puis lire une page. Les noms sont
 * ceux que les lignes `tool_calls` portent réellement — builtin `web_search`,
 * connecteur Tavily, serveur MCP fetch (`fetch_html`, `fetch_txt`…), et les
 * outils internes d'une CLI (`cli:WebSearch`, `cli:WebFetch`).
 */
const WEB_SEARCH = /^(web_?search|tavily_search)$/i;
const PAGE_READER =
  /^(web_?fetch|fetch(_[a-z]+)?|tavily_extract|tavily_crawl|read_web_page|get_page_images|scrape[a-z_]*)$/i;

export function isWebRetrieval(c: ToolCallFact): boolean {
  const n = bareToolName(c.toolName);
  return WEB_SEARCH.test(n) || PAGE_READER.test(n);
}

export function isPageReader(c: ToolCallFact): boolean {
  return PAGE_READER.test(bareToolName(c.toolName));
}

/**
 * Le seuil d'une page LUE : 1 000 caractères de texte, hors adresses et blancs.
 * Mesuré sur les essais réels du 30/09 : la plus courte page lue fait 2 941
 * caractères (tavily_extract), un fichier récupéré par fetch 3 857, la plupart
 * 8 000 à 15 000. Un message d'échec (« Request to https://… timed out after
 * 60000ms », « Failed to fetch … - status code 404 ») en fait moins de 100. Le
 * seuil est placé loin des deux.
 */
export const PAGE_MIN_CHARS = 1000;

/** Les caractères d'un texte qui ne sont ni une adresse ni un blanc. */
function contentChars(text: string): number {
  return text.replace(URL_RE, '').replace(/\s+/g, '').length;
}

/**
 * La sortie dit-elle l'échec ? `{ outcome: 'error' }` (toute exception d'un
 * outil, via `executeTool`), `ok: false`, `isError`, un champ `error`, ou
 * l'enveloppe `<tool_use_error>` (runtime CLI).
 */
function failureStated(output: string, parsed: unknown): boolean {
  if (output.trimStart().startsWith('<tool_use_error>')) return true;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const r = parsed as Record<string, unknown>;
  if (r['outcome'] === 'error' || r['ok'] === false) return true;
  if (r['isError'] === true || r['is_error'] === true) return true;
  return typeof r['error'] === 'string' && r['error'] !== '';
}

/** Le texte d'une sortie non structurée : une chaîne (JSON ou brute), ou les blocs texte d'une liste. */
function plainText(output: string, parsed: unknown): string | null {
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) {
    return parsed
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join('\n');
  }
  // Pas du JSON : le texte tel que le runtime CLI l'écrit.
  return parsed === null ? output : null;
}

/** La seule adresse que l'appel demandait (`url`, ou `urls` d'un élément) ; sinon null. */
function requestedUrl(c: ToolCallFact): string | null {
  const i = parseJson(c.input) as { url?: unknown; urls?: unknown } | null;
  const one =
    typeof i?.url === 'string'
      ? i.url
      : Array.isArray(i?.urls) && i.urls.length === 1
        ? i.urls[0]
        : null;
  return typeof one === 'string' ? normalizeUrl(one) : null;
}

/** Les adresses pour lesquelles CET appel a rendu du contenu réel. */
function urlsReadBy(c: ToolCallFact): string[] {
  const output = c.output ?? '';
  if (output.trim() === '') return [];
  const parsed = parseJson(output);
  if (failureStated(output, parsed)) return [];
  const search = WEB_SEARCH.test(bareToolName(c.toolName));
  const min = search ? 1 : PAGE_MIN_CHARS;

  // Un résultat structuré : chaque entrée porte son adresse et son texte.
  const results = (parsed as { results?: unknown } | null)?.results;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (!Array.isArray(results)) return [];
    const out: string[] = [];
    for (const r of results as Array<Record<string, unknown>>) {
      if (!r || typeof r['url'] !== 'string') continue;
      const text = [r['snippet'], r['content'], r['rawContent'], r['raw_content'], r['text']].find(
        (t): t is string => typeof t === 'string',
      );
      const u = normalizeUrl(r['url']);
      if (u && text !== undefined && contentChars(text) >= min) out.push(u);
    }
    return out;
  }

  // Une page rendue en texte (fetch MCP, CLI) : elle vaut pour l'adresse demandée,
  // et seulement pour une page (une recherche en texte n'attribue rien).
  if (search) return [];
  const text = plainText(output, parsed);
  const u = requestedUrl(c);
  return u && text !== null && contentChars(text) >= PAGE_MIN_CHARS ? [u] : [];
}

/**
 * Les adresses que l'essai a réellement LUES sur le web : celles pour
 * lesquelles un outil web a rendu du CONTENU — un résultat de recherche qui
 * porte l'adresse avec un extrait non vide, ou une page d'au moins
 * `PAGE_MIN_CHARS` caractères (hors adresses et blancs) rendue pour cette
 * adresse. Le critère ne dépend d'aucun drapeau de succès : les outils n'en
 * donnent pas de fiable (une erreur de fetch MCP arrive en simple chaîne, une
 * ligne CLI ne porte pas l'`is_error`, #643) ; un échec, lui, n'a pas de contenu.
 * Jamais l'entrée d'un outil, jamais la sortie d'un autre outil — relire une
 * note qu'on vient d'écrire rend les liens qu'on y a mis, pas une source.
 */
export function readUrls(
  facts: TreeFacts,
  keep: (c: ToolCallFact) => boolean = isWebRetrieval,
): Set<string> {
  const read = new Set<string>();
  for (const c of facts.toolCalls) {
    if (!keep(c)) continue;
    for (const u of urlsReadBy(c)) read.add(u);
  }
  return read;
}

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
