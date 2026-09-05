// presenters.ts — les briques dont un outil se sert pour écrire son `present()`.
//
// Chaque fonction produit UNE charge utile conforme à `@nodal-agents/shared`
// (`tool-cards.ts`) et applique les plafonds : un outil qui rend 10 000
// lignes en montre 50 et dit `total: 10000, truncated: true`. Les outils ne
// coupent jamais eux-mêmes ; ils passent leur sortie entière, c'est ici qu'on
// mesure.

import {
  CARD_CELL_MAX,
  CARD_EXCERPT_MAX,
  CARD_ITEMS_MAX,
  CARD_LABEL_MAX,
  CARD_ROWS_MAX,
  CARD_TEXT_MAX,
} from '@nodal-agents/shared';
import type { CardPayloadFor } from '@nodal-agents/shared';

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

/** Une réponse ou un accusé. Sortie objet → JSON lisible, plafonné. */
export function textCard(value: unknown): CardPayloadFor<'text'> {
  return { card: 'text', text: clip(stringify(value), CARD_TEXT_MAX) };
}

/**
 * La raison d'un échec, sur une carte `text`. Un outil dont la sortie est
 * `{ ok: false, reason }` la rend ainsi : la ligne garde la carte DÉCLARÉE
 * (`files`, `table`…), la charge utile dit pourquoi il n'y a rien à dessiner.
 */
export function failureText(reason: string): CardPayloadFor<'text'> {
  return { card: 'text', text: clip(reason, CARD_TEXT_MAX) };
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
    truncated: a.truncated ?? false,
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
  extra: { bytes?: number; detail?: string } = {},
): CardPayloadFor<'files'> {
  return filesCard([{ path, action, ...extra }]);
}

type Cell = string | number | null;

function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return clip(v, CARD_CELL_MAX);
  if (v instanceof Date) return v.toISOString();
  return clip(stringify(v), CARD_CELL_MAX);
}

export function tableCard(
  tables: ReadonlyArray<{
    name?: string;
    columns: ReadonlyArray<string>;
    rows: ReadonlyArray<ReadonlyArray<unknown>>;
    total?: number;
    truncated?: boolean;
  }>,
): CardPayloadFor<'table'> {
  return {
    card: 'table',
    tables: tables.map((t) => {
      const shown = t.rows.slice(0, CARD_ROWS_MAX).map((r) => r.map(cell));
      return {
        ...(t.name !== undefined ? { name: clip(t.name, CARD_LABEL_MAX) } : {}),
        columns: t.columns.map((c) => clip(c, CARD_CELL_MAX)),
        rows: shown,
        total: t.total ?? t.rows.length,
        truncated: (t.truncated ?? false) || shown.length < t.rows.length,
      };
    }),
  };
}

/**
 * Des enregistrements homogènes (`{ id, fact, … }[]`) en table : les colonnes
 * sont les clés du premier enregistrement, dans son ordre.
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
    stderrTail: tail(a.stderr, CARD_EXCERPT_MAX),
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
 * d'un fichier écrit (« rows_appended=3 · sheet=Data »). `ok` et `path` sont
 * déjà portés ailleurs sur la carte, ils ne sont pas répétés.
 */
export function detailOf(
  output: Record<string, unknown>,
  omit: ReadonlyArray<string> = [],
): string {
  const skip = new Set(['ok', 'path', ...omit]);
  return Object.entries(output)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' · ');
}
