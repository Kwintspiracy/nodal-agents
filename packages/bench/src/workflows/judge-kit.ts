// workflows/judge-kit.ts — les lectures que partagent les juges.
//
// Fonctions pures sur la photo d'un essai (`TreeFacts`). Aucune n'interroge le
// modèle ni ne croit ce qu'il affirme : une délégation est un job enfant, un
// envoi est une sortie d'outil qui dit `ok`. Qu'une source citée ait été LUE
// n'est pas jugé ici : aucune ligne de la base ne le dit de façon fiable (#648).

import { MCP_TOOL_OUTPUT_FORMAT } from '@nodal-agents/shared';
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
