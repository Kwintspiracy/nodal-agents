// workflows/judge-kit.ts — les lectures que partagent les juges.
//
// Fonctions pures sur la photo d'un essai (`TreeFacts`). Aucune n'interroge le
// modèle ni ne croit ce qu'il affirme : une délégation est un job enfant, un
// envoi est une sortie d'outil qui dit `ok`. Qu'une source citée ait été LUE
// n'est pas jugé ici : aucune ligne de la base ne le dit de façon fiable (#648).

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
 * Depuis que l'adaptateur garde le résultat ENTIER (`packages/adapters/mcp/src/
 * result.ts`), la sortie est `{ content: [...blocs], structuredContent? }` et
 * la forme machine du serveur est sous `structuredContent`. Les lignes écrites
 * avant gardaient ce `structuredContent` seul, à la racine : les essais réels
 * enregistrés (fixtures) et toute base existante en portent. Les deux formes
 * sont des données déjà écrites, chacune lue telle qu'elle a été écrite.
 *
 * Un serveur peut aussi ne rien mettre dans `structuredContent` et écrire sa
 * forme machine en JSON dans un bloc texte — ce que la spec recommande pour les
 * clients qui ne lisent que `content` (et une ligne de l'ancien adaptateur, qui
 * gardait ce texte seul). Elle est lue aussi : le premier bloc texte qui est un
 * objet JSON. Sinon le juge dirait « aucune demande » sur un essai juste.
 */
export function mcpStructured(s: string | null): Record<string, unknown> | null {
  const record = jsonObject(parseJson(s));
  if (!record) return null;
  if (!Array.isArray(record['content'])) return record;
  const structured = jsonObject(record['structuredContent']);
  if (structured) return structured;
  for (const block of record['content'] as unknown[]) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type !== 'text') continue;
    const fromText = jsonObject(b.text);
    if (fromText) return fromText;
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
