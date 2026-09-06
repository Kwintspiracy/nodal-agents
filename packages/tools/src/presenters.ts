// presenters.ts — les briques dont un outil se sert pour écrire son `present()`.
//
// Chaque fonction produit UNE charge utile conforme à `@nodal-agents/shared`
// (`tool-cards.ts`) et applique les plafonds : un outil qui rend 10 000
// lignes en montre 50 et dit `total: 10000, truncated: true`. Les outils ne
// coupent jamais eux-mêmes ; ils passent leur sortie entière, c'est ici qu'on
// mesure — et ce qui a été coupé se DIT (revue passe 14 : un extrait coupé
// annonçait `truncated: false`).

import {
  CARD_CELL_MAX,
  CARD_EXCERPT_MAX,
  CARD_ITEMS_MAX,
  CARD_LABEL_MAX,
  CARD_ROWS_MAX,
  CARD_TEXT_MAX,
} from '@nodal-agents/shared';
import type { CardPayloadFor, TableEntry } from '@nodal-agents/shared';

/** Coupe à `max` caractères en le disant (« … »). Une chaîne courte est rendue intacte. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

/** La fin d'un texte — pour une sortie de terminal, la fin porte le verdict. */
export function tail(value: string, max: number): string {
  if (value.length <= max) return value;
  return '…' + value.slice(value.length - (max - 1));
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Une réponse ou un accusé. Sortie objet → JSON lisible, plafonné — et dit coupé s'il l'est. */
export function textCard(value: unknown): CardPayloadFor<'text'> {
  const full = stringify(value);
  return {
    card: 'text',
    text: clip(full, CARD_TEXT_MAX),
    ...(full.length > CARD_TEXT_MAX ? { truncated: true } : {}),
  };
}

/**
 * La raison d'un échec, sur une carte `text` marquée `failure: true`. Un outil
 * dont la sortie est `{ ok: false, reason }` la rend ainsi : la ligne garde la
 * carte DÉCLARÉE (`files`, `table`…), la charge dit pourquoi il n'y a rien à
 * dessiner. C'est la SEULE charge `text` qu'une carte structurée accepte
 * (`presentToolResult`) — un succès ne peut pas se cacher derrière du texte.
 */
export function failureText(reason: string): CardPayloadFor<'text'> {
  return {
    card: 'text',
    text: clip(reason, CARD_TEXT_MAX),
    failure: true,
    ...(reason.length > CARD_TEXT_MAX ? { truncated: true } : {}),
  };
}

export function readCard(a: {
  path: string | null;
  text: string;
  truncated?: boolean;
  sections?: number;
}): CardPayloadFor<'read'> {
  return {
    card: 'read',
    path: a.path === null ? null : clip(a.path, CARD_LABEL_MAX),
    excerpt: clip(a.text, CARD_EXCERPT_MAX),
    chars: a.text.length,
    // Coupé par l'outil (il n'a pas tout lu) OU par nous (l'extrait est plus court que le texte).
    truncated: (a.truncated ?? false) || a.text.length > CARD_EXCERPT_MAX,
    ...(a.sections !== undefined ? { sections: a.sections } : {}),
  };
}

export function searchCard(a: {
  query: string;
  hits: ReadonlyArray<{ title: string; ref?: string; snippet?: string }>;
  /** Nombre réel de correspondances quand l'outil en sait plus qu'il n'en rend. */
  total?: number;
  truncated?: boolean;
}): CardPayloadFor<'search'> {
  const shown = a.hits.slice(0, CARD_ITEMS_MAX).map((h) => ({
    title: clip(h.title, CARD_LABEL_MAX),
    ...(h.ref !== undefined ? { ref: clip(h.ref, CARD_LABEL_MAX) } : {}),
    ...(h.snippet !== undefined ? { snippet: clip(h.snippet, CARD_LABEL_MAX) } : {}),
  }));
  const total = a.total ?? a.hits.length;
  return {
    card: 'search',
    query: clip(a.query, CARD_LABEL_MAX),
    hits: shown,
    total,
    truncated: (a.truncated ?? false) || shown.length < a.hits.length,
  };
}

export type FileEntry = {
  path: string;
  action: 'created' | 'modified' | 'written' | 'listed';
  bytes?: number;
  detail?: string;
  /** P12 — les premières lignes de ce que le fichier contient maintenant. */
  preview?: TableEntry;
  /** P12 — `projectKey(chemin absolu)`, la clé de l'état de vérification. */
  deliverableKey?: string;
};

export function filesCard(
  files: ReadonlyArray<FileEntry>,
  opts: { total?: number; truncated?: boolean } = {},
): CardPayloadFor<'files'> {
  const shown = files.slice(0, CARD_ITEMS_MAX).map((f) => ({
    path: clip(f.path, CARD_LABEL_MAX),
    action: f.action,
    ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
    ...(f.detail !== undefined ? { detail: clip(f.detail, CARD_LABEL_MAX) } : {}),
    ...(f.preview !== undefined ? { preview: f.preview } : {}),
    ...(f.deliverableKey !== undefined
      ? { deliverableKey: clip(f.deliverableKey, CARD_LABEL_MAX) }
      : {}),
  }));
  return {
    card: 'files',
    files: shown,
    total: opts.total ?? files.length,
    truncated: (opts.truncated ?? false) || shown.length < files.length,
  };
}

/** Un fichier écrit ou modifié — le cas le plus fréquent, en une ligne. */
export function writtenFile(
  path: string,
  action: 'created' | 'modified' | 'written',
  extra: { bytes?: number; detail?: string; preview?: TableEntry; deliverableKey?: string } = {},
): CardPayloadFor<'files'> {
  return filesCard([{ path, action, ...extra }]);
}

type Cell = string | number | null;

/** Une cellule plafonnée, et si elle l'a été. */
function cell(v: unknown): [Cell, boolean] {
  if (v === null || v === undefined) return [null, false];
  if (typeof v === 'number') return [v, false];
  if (v instanceof Date) return [v.toISOString(), false];
  const s = typeof v === 'string' ? v : stringify(v);
  return [clip(s, CARD_CELL_MAX), s.length > CARD_CELL_MAX];
}

export type TableEntryInput = {
  name?: string;
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  /**
   * `columns` : les colonnes données SONT l'en-tête. `unknown` : personne ne
   * sait si la première ligne est un en-tête (un classeur lu tel quel) — le
   * rendu ne le devinera pas, il le demandera ou le dira.
   */
  header?: 'columns' | 'unknown';
  total?: number;
  truncated?: boolean;
};

/**
 * UNE table plafonnée. Extraite de `tableCard` (P12) parce que l'APERÇU d'un
 * fichier écrit porte la même forme : un aperçu ne peut pas peser plus qu'une
 * table, et il se dessine par le même composant.
 */
export function tableEntry(t: TableEntryInput): TableEntry {
  // Coupé quelque part — une cellule OU un intitulé de colonne (revue passe
  // 15 : les colonnes étaient coupées sans que `clipped` le dise).
  let clipped = t.columns.some((c) => c.length > CARD_CELL_MAX);
  const shown = t.rows.slice(0, CARD_ROWS_MAX).map((r) =>
    r.map((v) => {
      const [c, wasClipped] = cell(v);
      if (wasClipped) clipped = true;
      return c;
    }),
  );
  const total = t.total ?? t.rows.length;
  return {
    ...(t.name !== undefined ? { name: clip(t.name, CARD_LABEL_MAX) } : {}),
    columns: t.columns.map((c) => clip(c, CARD_CELL_MAX)),
    header: t.header ?? (t.columns.length > 0 ? 'columns' : 'unknown'),
    rows: shown,
    total,
    // Coupé ici (on a plafonné), coupé avant (l'appelant le dit), ou coupé
    // AVANT MÊME l'appel : un appelant qui plafonne lui-même passe des `rows`
    // déjà courtes et un `total` plus grand — sans cette troisième condition
    // (P12), la carte annonçait « complet » sur un aperçu tronqué.
    truncated: (t.truncated ?? false) || shown.length < t.rows.length || shown.length < total,
    clipped,
  };
}

export function tableCard(tables: ReadonlyArray<TableEntryInput>): CardPayloadFor<'table'> {
  return { card: 'table', tables: tables.map(tableEntry) };
}

/**
 * Des enregistrements homogènes (`{ id, fact, … }[]`) en table : les colonnes
 * sont les clés du premier enregistrement, dans son ordre — et sont l'en-tête.
 */
export function recordsTable(
  records: ReadonlyArray<Record<string, unknown>>,
  opts: { name?: string; columns?: ReadonlyArray<string> } = {},
): CardPayloadFor<'table'> {
  const columns = opts.columns ?? (records[0] ? Object.keys(records[0]) : []);
  return tableCard([
    {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      columns,
      header: 'columns',
      rows: records.map((r) => columns.map((c) => r[c])),
    },
  ]);
}

export function terminalCard(a: {
  command: string;
  exitCode: number | null;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  cwd?: string;
}): CardPayloadFor<'terminal'> {
  return {
    card: 'terminal',
    command: clip(a.command, CARD_EXCERPT_MAX),
    exitCode: a.exitCode,
    timedOut: a.timedOut ?? false,
    stdoutTail: tail(a.stdout, CARD_EXCERPT_MAX),
    stdoutTruncated: a.stdout.length > CARD_EXCERPT_MAX,
    stderrTail: tail(a.stderr, CARD_EXCERPT_MAX),
    stderrTruncated: a.stderr.length > CARD_EXCERPT_MAX,
    ...(a.cwd !== undefined ? { cwd: clip(a.cwd, CARD_LABEL_MAX) } : {}),
  };
}

export function sentCard(a: {
  channel: string;
  kind: CardPayloadFor<'sent'>['kind'];
  target?: string;
  filename?: string;
  bytes?: number;
}): CardPayloadFor<'sent'> {
  return {
    card: 'sent',
    channel: clip(a.channel, CARD_LABEL_MAX),
    kind: a.kind,
    ...(a.target !== undefined ? { target: clip(a.target, CARD_LABEL_MAX) } : {}),
    ...(a.filename !== undefined ? { filename: clip(a.filename, CARD_LABEL_MAX) } : {}),
    ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
  };
}

export function checksCard(a: {
  verdict: 'pass' | 'fail';
  summary: string;
  items: ReadonlyArray<{ label: string; ok: boolean; ref?: string; severity?: string }>;
}): CardPayloadFor<'checks'> {
  return {
    card: 'checks',
    verdict: a.verdict,
    summary: clip(a.summary, CARD_TEXT_MAX),
    items: a.items.slice(0, CARD_ITEMS_MAX).map((i) => ({
      label: clip(i.label, CARD_LABEL_MAX),
      ok: i.ok,
      ...(i.ref !== undefined ? { ref: clip(i.ref, CARD_LABEL_MAX) } : {}),
      ...(i.severity !== undefined ? { severity: clip(i.severity, CARD_LABEL_MAX) } : {}),
    })),
    total: a.items.length,
  };
}

export function delegationCard(a: {
  to: string;
  task: string;
  ok: boolean;
  resultText?: string | null;
  error?: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
}): CardPayloadFor<'delegation'> {
  return {
    card: 'delegation',
    to: clip(a.to, CARD_LABEL_MAX),
    task: clip(a.task, CARD_EXCERPT_MAX),
    ok: a.ok,
    resultText: a.resultText == null ? null : clip(a.resultText, CARD_TEXT_MAX),
    error: a.error == null ? null : clip(a.error, CARD_LABEL_MAX),
    durationMs: a.durationMs ?? null,
    costUsd: a.costUsd ?? null,
    ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
  };
}

/**
 * Ce qu'un outil dit de ce qu'il a fait, en `clé=valeur` — pour le `detail`
 * d'un fichier écrit (« rows_appended=3 · sheet=Data »). `ok`, `path` et
 * `preview` sont déjà portés ailleurs sur la carte, ils ne sont pas répétés :
 * `preview` (P12) est un objet, il rendrait « preview=[object Object] » dans
 * une ligne censée tenir en un coup d'œil.
 */
export function detailOf(
  output: Record<string, unknown>,
  omit: ReadonlyArray<string> = [],
): string {
  const skip = new Set(['ok', 'path', 'preview', ...omit]);
  return Object.entries(output)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' · ');
}
