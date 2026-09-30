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
 * L'appel a-t-il rendu quelque chose ? Une sortie vide n'a rien rendu ; une
 * sortie qui dit l'échec — `{ outcome: 'error' }` (le chemin d'erreur de
 * `executeTool`), `ok: false`, `isError`, ou un champ `error` — non plus.
 * Une ligne `cli:*` ne porte aucun drapeau d'échec : sa sortie est lue telle
 * quelle.
 */
export function succeeded(c: ToolCallFact): boolean {
  if (c.output === null || c.output.trim() === '') return false;
  const o = parseJson(c.output);
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return true;
  const r = o as Record<string, unknown>;
  if (r['outcome'] === 'error' || r['ok'] === false) return false;
  if (r['isError'] === true || r['is_error'] === true) return false;
  return !(typeof r['error'] === 'string' && r['error'] !== '');
}

/** Les parties d'une sortie qui disent ce qui a ÉCHOUÉ (`failedResults` de Tavily) : jamais une preuve. */
const FAILURE_KEYS = new Set(['failedResults', 'failed_results', 'errors', 'error']);

/** Les adresses qu'une sortie a rendues, hors des parties qui listent les échecs. */
function urlsReturnedBy(c: ToolCallFact): string[] {
  const o = parseJson(c.output);
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return urlsIn(c.output);
  const kept = Object.fromEntries(
    Object.entries(o as Record<string, unknown>).filter(([k]) => !FAILURE_KEYS.has(k)),
  );
  return urlsIn(JSON.stringify(kept));
}

/**
 * Les adresses que l'essai a réellement VUES sur le web : celles que rendent
 * les outils de récupération web qui ont réussi. Jamais l'entrée d'un outil
 * (le modèle l'écrit), jamais la sortie d'un autre outil — relire une note
 * qu'on vient d'écrire rend les liens qu'on y a mis, pas une source.
 */
export function retrievedUrls(
  facts: TreeFacts,
  keep: (c: ToolCallFact) => boolean = isWebRetrieval,
): Set<string> {
  const seen = new Set<string>();
  for (const c of facts.toolCalls) {
    if (!keep(c) || !succeeded(c)) continue;
    for (const u of urlsReturnedBy(c)) seen.add(u);
  }
  return seen;
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
