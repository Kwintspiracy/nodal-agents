// elicitation-card.ts — la question d'un serveur MCP (0145) répondue DEPUIS UN
// CANAL à boutons (Telegram, Discord, Slack) : la carte, la grammaire de ses
// boutons, le brouillon que chaque geste modifie, et la valeur tapée en réponse
// au message. Fonctions pures : le runner les appelle pour les trois canaux, et
// aucune ne sait sur quel canal elle tourne — le canal déclare seulement ce
// qu'il peut porter (`limits`).
//
// Le brouillon vit en base (`approval_requests.draft`, 0146), jamais en
// mémoire : un geste relit la ligne, applique UNE opération, réécrit la carte.
// Chaque bouton pose une valeur EXPLICITE (« Two-sided: Yes », jamais « basculer ») :
// une vieille carte rejouée ne défait rien. « Send » porte la révision des
// valeurs que la carte MONTRAIT : une carte périmée n'envoie pas autre chose
// que ce que la personne a lu.

import {
  validateElicitationContent,
  type ElicitationField,
  type ElicitationValue,
} from './elicitation';

/** Le préfixe des boutons d'une élicitation — distinct de `apr:` (approbations, questions). */
export const ELICITATION_CALLBACK_PREFIX = 'eli';

/** Ce que porte un bouton, une fois lu. Les index sont ceux des champs du formulaire et de leurs options. */
export type ElicitationOp =
  | { op: 'choice'; field: number; option: number }
  | { op: 'bool'; field: number; value: boolean }
  | { op: 'multi'; field: number; option: number; value: boolean }
  /** Le champ (nombre ou texte) attend la valeur tapée en réponse à la carte. */
  | { op: 'type'; field: number }
  | { op: 'send'; revision: string }
  | { op: 'decline' };

/** Le brouillon d'une élicitation répondue depuis un canal (`approval_requests.draft`). */
export interface ElicitationDraft {
  values: Record<string, ElicitationValue>;
  /** La clé du champ qui attend une valeur tapée en réponse à la carte ; null sinon. */
  awaiting: string | null;
}

/** Un bouton de la carte, sous la forme neutre que les adaptateurs de canal rendent. */
export interface ElicitationCardButton {
  label: string;
  callbackData: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Au plus deux chiffres : un formulaire plus grand ne tient de toute façon sur aucun canal. */
const INDEX = '(\\d{1,2})';
const OP_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => ElicitationOp]> = [
  [
    new RegExp(`^c\\.${INDEX}\\.${INDEX}$`),
    (m) => ({ op: 'choice', field: +m[1]!, option: +m[2]! }),
  ],
  [
    new RegExp(`^b\\.${INDEX}\\.([01])$`),
    (m) => ({ op: 'bool', field: +m[1]!, value: m[2] === '1' }),
  ],
  [
    new RegExp(`^m\\.${INDEX}\\.${INDEX}\\.([01])$`),
    (m) => ({ op: 'multi', field: +m[1]!, option: +m[2]!, value: m[3] === '1' }),
  ],
  [new RegExp(`^t\\.${INDEX}$`), (m) => ({ op: 'type', field: +m[1]! })],
  [/^s\.([0-9a-f]{8})$/, (m) => ({ op: 'send', revision: m[1]! })],
  [/^d$/, () => ({ op: 'decline' })],
];

/** Le `callback_data` d'un bouton : `eli:<uuid>:<op>`, 51 octets au plus. */
export function elicitationCallbackData(approvalRequestId: string, op: ElicitationOp): string {
  const tail = (() => {
    switch (op.op) {
      case 'choice':
        return `c.${op.field}.${op.option}`;
      case 'bool':
        return `b.${op.field}.${op.value ? 1 : 0}`;
      case 'multi':
        return `m.${op.field}.${op.option}.${op.value ? 1 : 0}`;
      case 'type':
        return `t.${op.field}`;
      case 'send':
        return `s.${op.revision}`;
      case 'decline':
        return 'd';
    }
  })();
  return `${ELICITATION_CALLBACK_PREFIX}:${approvalRequestId}:${tail}`;
}

/** Lit un `callback_data` ; null quand il n'est pas à nous ou ne se lit pas. */
export function parseElicitationCallbackData(
  data: string | undefined,
): { approvalRequestId: string; op: ElicitationOp } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== ELICITATION_CALLBACK_PREFIX) return null;
  const [, id, tail] = parts;
  if (!id || !UUID_RE.test(id) || !tail) return null;
  for (const [re, build] of OP_PATTERNS) {
    const m = re.exec(tail);
    if (m) return { approvalRequestId: id, op: build(m) };
  }
  return null;
}

/**
 * La révision des valeurs d'un brouillon : 8 chiffres hexadécimaux, stable
 * quel que soit l'ordre des clés (FNV-1a 32 bits sur le JSON trié). Ce n'est
 * pas une protection contre un adversaire — le bouton vient de la carte et le
 * tap de la conversation de la carte — mais contre une carte PÉRIMÉE.
 */
export function elicitationDraftRevision(values: Record<string, ElicitationValue>): string {
  const canonical = JSON.stringify(
    Object.keys(values)
      .sort()
      .map((k) => [k, values[k]]),
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Le brouillon de départ : les `default` du serveur quand ils sont valides. Un
 * interrupteur a toujours un état visible — celui qu'on montre est celui qu'on
 * envoie, comme sur le web.
 */
export function initialElicitationDraft(fields: readonly ElicitationField[]): ElicitationDraft {
  const values: Record<string, ElicitationValue> = {};
  for (const f of fields) {
    switch (f.kind) {
      case 'boolean':
        values[f.key] = f.default ?? false;
        break;
      case 'choice':
        if (f.default !== null && f.options.some((o) => o.value === f.default)) {
          values[f.key] = f.default;
        }
        break;
      case 'multi': {
        const kept = (f.default ?? []).filter((v) => f.options.some((o) => o.value === v));
        if (kept.length > 0) values[f.key] = kept;
        break;
      }
      case 'number':
      case 'text':
        if (f.default !== null) values[f.key] = f.default;
        break;
    }
  }
  return { values, awaiting: null };
}

/** Lit un brouillon stocké ; null quand la colonne ne porte pas cette forme. */
export function readElicitationDraft(raw: unknown): ElicitationDraft | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { values, awaiting } = raw as Record<string, unknown>;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return null;
  if (awaiting !== null && typeof awaiting !== 'string') return null;
  return { values: values as Record<string, ElicitationValue>, awaiting };
}

export type ElicitationOpResult =
  | { ok: true; draft: ElicitationDraft }
  | { ok: false; draft: ElicitationDraft; reason: string };

/**
 * Applique UN geste au brouillon. `send` et `decline` ne modifient rien ici :
 * ils sont tranchés par l'appelant (la résolution de la demande). Un bouton qui
 * ne désigne aucun champ ou option du formulaire est refusé, avec la raison :
 * jamais rattaché « au plus proche ».
 */
export function applyElicitationOp(
  fields: readonly ElicitationField[],
  draft: ElicitationDraft,
  op: ElicitationOp,
): ElicitationOpResult {
  if (op.op === 'send' || op.op === 'decline') return { ok: true, draft };
  const field = fields[op.field];
  const refuse = (reason: string): ElicitationOpResult => ({ ok: false, draft, reason });
  const set = (key: string, value: ElicitationValue | undefined): ElicitationOpResult => {
    const values = { ...draft.values };
    if (value === undefined) delete values[key];
    else values[key] = value;
    return { ok: true, draft: { values, awaiting: null } };
  };
  switch (op.op) {
    case 'choice': {
      if (!field || field.kind !== 'choice') return refuse('this button does not match the form');
      const option = field.options[op.option];
      if (!option) return refuse('this choice no longer exists');
      return set(field.key, option.value);
    }
    case 'bool':
      if (!field || field.kind !== 'boolean') return refuse('this button does not match the form');
      return set(field.key, op.value);
    case 'multi': {
      if (!field || field.kind !== 'multi') return refuse('this button does not match the form');
      const option = field.options[op.option];
      if (!option) return refuse('this choice no longer exists');
      const current = Array.isArray(draft.values[field.key])
        ? (draft.values[field.key] as string[])
        : [];
      const without = current.filter((v) => v !== option.value);
      // Dans l'ordre des options, pas dans l'ordre des taps.
      const next = field.options
        .map((o) => o.value)
        .filter((v) => (v === option.value ? op.value : without.includes(v)));
      return set(field.key, next.length > 0 ? next : undefined);
    }
    case 'type':
      if (!field || (field.kind !== 'number' && field.kind !== 'text')) {
        return refuse('this button does not match the form');
      }
      return { ok: true, draft: { values: draft.values, awaiting: field.key } };
  }
}

export type TypedValueResult =
  | { ok: true; draft: ElicitationDraft; field: string }
  | { ok: false; draft: ElicitationDraft; reason: string };

/**
 * La valeur tapée en réponse à la carte, pour le champ qui l'attend. Vérifiée
 * par la MÊME règle que le web et le runner (`validateElicitationContent`) :
 * refusée avec la raison, le champ reste en attente — jamais corrigée.
 */
export function applyTypedElicitationValue(
  fields: readonly ElicitationField[],
  draft: ElicitationDraft,
  text: string,
): TypedValueResult {
  const field = fields.find((f) => f.key === draft.awaiting);
  if (!field || (field.kind !== 'number' && field.kind !== 'text')) {
    return { ok: false, draft, reason: 'no field is waiting for a typed value' };
  }
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, draft, reason: `${field.label} needs a value` };
  let value: ElicitationValue = trimmed;
  if (field.kind === 'number') {
    const n = Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(n)) return { ok: false, draft, reason: `${field.label} must be a number` };
    value = n;
  }
  const checked = validateElicitationContent([field], { [field.key]: value });
  if (!checked.ok) {
    return {
      ok: false,
      draft,
      reason: checked.errors.map((e) => `${field.label} ${e.reason}`).join('; '),
    };
  }
  return {
    ok: true,
    draft: { values: { ...draft.values, [field.key]: value }, awaiting: null },
    field: field.label,
  };
}

// ─── La carte ─────────────────────────────────────────────────────────────────

/** Ce qu'un canal peut porter. Absent : rien ne borne. */
export interface ElicitationCardLimits {
  maxRows?: number;
  maxPerRow?: number;
}

/** Boutons par rangée, au plus : au-delà, Telegram tronque les libellés sur mobile. */
const PER_ROW = 3;

function shown(field: ElicitationField, value: ElicitationValue | undefined): string {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return field.required ? '— (required)' : '—';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field.kind === 'choice' || field.kind === 'multi') {
    const labels = (Array.isArray(value) ? value : [String(value)]).map(
      (v) => field.options.find((o) => o.value === v)?.label ?? v,
    );
    return labels.join(', ');
  }
  return String(value);
}

/** Ce que la personne doit taper, en une phrase. */
function typedHint(field: ElicitationField): string {
  if (field.kind === 'number') {
    const what = field.integer ? 'a whole number' : 'a number';
    if (field.minimum !== null && field.maximum !== null) {
      return `${what} from ${field.minimum} to ${field.maximum}`;
    }
    if (field.minimum !== null) return `${what} of at least ${field.minimum}`;
    if (field.maximum !== null) return `${what} of at most ${field.maximum}`;
    return what;
  }
  if (field.kind === 'text') {
    if (field.format === 'email') return 'an email address';
    if (field.format === 'uri') return 'a web address';
    if (field.format === 'date') return 'a date (YYYY-MM-DD)';
    if (field.format === 'date-time') return 'a date and time';
    if (field.maxLength !== null) return `text of at most ${field.maxLength} characters`;
    return 'text';
  }
  return 'a value';
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

export type RenderedElicitationCard =
  | { ok: true; text: string; buttons: ElicitationCardButton[][] }
  | { ok: false; reason: string };

/**
 * La carte : la question citée (texte tiers, telle quelle), les valeurs du
 * brouillon, puis une rangée de boutons par champ — chaque bouton nommé par
 * son champ, pour qu'aucun « Yes » ne soit ambigu —, les « ✏️ » des champs à
 * taper sur une rangée, et Send / Decline.
 *
 * Refusée avec la raison quand le canal ne peut pas la porter (`limits`) :
 * l'appelant le dit et renvoie au dashboard, il ne coupe jamais des champs.
 */
export function renderElicitationCard(args: {
  approvalRequestId: string;
  server: string;
  message: string;
  fields: readonly ElicitationField[];
  draft: ElicitationDraft;
  imageCount: number;
  limits?: ElicitationCardLimits;
}): RenderedElicitationCard {
  const { approvalRequestId: id, fields, draft } = args;
  if (fields.length > 99) return { ok: false, reason: 'the form has more than 99 fields' };
  const perRow = Math.min(args.limits?.maxPerRow ?? PER_ROW, PER_ROW);
  const btn = (label: string, op: ElicitationOp): ElicitationCardButton => ({
    label,
    callbackData: elicitationCallbackData(id, op),
  });

  const rows: ElicitationCardButton[][] = [];
  const typed: ElicitationCardButton[] = [];
  fields.forEach((f, i) => {
    const value = draft.values[f.key];
    switch (f.kind) {
      case 'choice':
        rows.push(
          ...chunk(
            f.options.map((o, j) =>
              btn(`${value === o.value ? '✓ ' : ''}${f.label}: ${o.label}`, {
                op: 'choice',
                field: i,
                option: j,
              }),
            ),
            perRow,
          ),
        );
        break;
      case 'boolean':
        rows.push([
          btn(`${value === true ? '✓ ' : ''}${f.label}: Yes`, {
            op: 'bool',
            field: i,
            value: true,
          }),
          btn(`${value === false ? '✓ ' : ''}${f.label}: No`, {
            op: 'bool',
            field: i,
            value: false,
          }),
        ]);
        break;
      case 'multi': {
        const picked = Array.isArray(value) ? value : [];
        rows.push(
          ...chunk(
            f.options.map((o, j) => {
              const on = picked.includes(o.value);
              return btn(`${on ? '☑' : '☐'} ${f.label}: ${o.label}`, {
                op: 'multi',
                field: i,
                option: j,
                value: !on,
              });
            }),
            perRow,
          ),
        );
        break;
      }
      case 'number':
      case 'text':
        typed.push(btn(`✏️ ${f.label}`, { op: 'type', field: i }));
        break;
    }
  });
  rows.push(...chunk(typed, perRow));
  rows.push([
    btn('✅ Send', { op: 'send', revision: elicitationDraftRevision(draft.values) }),
    btn('❌ Decline', { op: 'decline' }),
  ]);

  if (fields.some((f) => (f.kind === 'choice' || f.kind === 'multi') && f.options.length > 99)) {
    return { ok: false, reason: 'a field offers more than 99 choices' };
  }
  const maxRows = args.limits?.maxRows;
  if (maxRows !== undefined && rows.length > maxRows) {
    return {
      ok: false,
      reason: `the form needs ${rows.length} rows of buttons and this channel shows at most ${maxRows}`,
    };
  }

  const lines = fields.map((f) => `${f.label}: ${shown(f, draft.values[f.key])}`);
  const waiting = fields.find((f) => f.key === draft.awaiting);
  const text =
    `❓ The MCP server "${args.server}" asks:\n\n` +
    `« ${args.message} »\n\n` +
    (args.imageCount > 0
      ? `${args.imageCount === 1 ? 'The image above comes' : `The ${args.imageCount} images above come`} with the question.\n\n`
      : '') +
    lines.join('\n') +
    '\n\n' +
    (waiting
      ? `✏️ Reply to this message with ${waiting.label}: ${typedHint(waiting)}.`
      : 'Set the values with the buttons, then Send. You can also answer from the dashboard.');
  return { ok: true, text, buttons: rows };
}
