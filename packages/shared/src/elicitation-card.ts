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
  elicitationActionLabels,
  initialElicitationValues,
  setOwnValue,
  validateElicitationContent,
  type ElicitationActions,
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
 * Le brouillon de départ : les valeurs de départ de toute surface
 * (`initialElicitationValues`), la même règle que le formulaire du web.
 */
export function initialElicitationDraft(fields: readonly ElicitationField[]): ElicitationDraft {
  return { values: initialElicitationValues(fields), awaiting: null };
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
    else setOwnValue(values, key, value);
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
      const held = Object.prototype.hasOwnProperty.call(draft.values, field.key)
        ? draft.values[field.key]
        : undefined;
      const current = Array.isArray(held) ? held : [];
      const without = current.filter((v) => v !== option.value);
      // Dans l'ordre des options, pas dans l'ordre des taps. Une liste vidée
      // part vide : la personne a choisi « aucun », comme sur le web.
      const next = field.options
        .map((o) => o.value)
        .filter((v) => (v === option.value ? op.value : without.includes(v)));
      return set(field.key, next);
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
  /**
   * The field the reply was for, read when the reply arrived. A reply replayed
   * on a draft another gesture changed meanwhile (✏️ on another field) is
   * refused, never written into the field that waits NOW (review of #664,
   * pass 3). Absent: the field waiting in `draft`.
   */
  forField: string | null = draft.awaiting,
): TypedValueResult {
  if (draft.awaiting !== forField) {
    return {
      ok: false,
      draft,
      reason: 'the field waiting for your answer changed: check the card',
    };
  }
  const field = fields.find((f) => f.key === draft.awaiting);
  if (!field || (field.kind !== 'number' && field.kind !== 'text')) {
    return { ok: false, draft, reason: 'no field is waiting for a typed value' };
  }
  // Un texte est pris tel quel, ses espaces compris : la règle du formulaire
  // (`validateElicitationContent`) décide seule s'il convient. Seul un nombre
  // se lit sans eux.
  let value: ElicitationValue = text;
  if (field.kind === 'number') {
    const trimmed = text.trim();
    const n = trimmed === '' ? Number.NaN : Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(n)) return { ok: false, draft, reason: `${field.label} must be a number` };
    value = n;
  }
  const one: Record<string, ElicitationValue> = {};
  setOwnValue(one, field.key, value);
  const checked = validateElicitationContent([field], one);
  if (!checked.ok) {
    return {
      ok: false,
      draft,
      reason: checked.errors.map((e) => `${field.label} ${e.reason}`).join('; '),
    };
  }
  const values = { ...draft.values };
  setOwnValue(values, field.key, value);
  return { ok: true, draft: { values, awaiting: null }, field: field.label };
}

// ─── La carte ─────────────────────────────────────────────────────────────────

/**
 * Un texte tiers (la question d'un serveur) cité ligne par ligne : chaque ligne
 * commence par « │ », aucune ne peut se faire passer pour une ligne de la carte
 * ni fermer une citation (revue de #664, passe 3). Partagé avec le renvoi au
 * dashboard (notify.ts), qui cite la même question.
 */
export function quoteThirdPartyText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `│ ${line}`)
    .join('\n');
}

/** Ce qu'un canal peut porter. Absent : rien ne borne. */
export interface ElicitationCardLimits {
  maxRows?: number;
  maxPerRow?: number;
  /** Boutons au plus sur une carte (Telegram : 100). */
  maxButtons?: number;
  /**
   * Le plus long texte d'un message sur ce canal. Une carte est UN message :
   * elle ne se découpe pas comme un texte.
   */
  maxTextChars?: number;
}

/** Boutons par rangée, au plus : au-delà, Telegram tronque les libellés sur mobile. */
const PER_ROW = 3;

function shown(field: ElicitationField, value: ElicitationValue | undefined): string {
  if (value === undefined) return field.required ? '— (required)' : '—';
  if (Array.isArray(value) && value.length === 0) return 'none';
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
 * La carte : la question citée (texte tiers, telle quelle) et les valeurs du
 * brouillon dans le texte ; sous lui, le bouton d'accord et le refus EN TÊTE
 * — visibles sans défilement, aux mots du serveur (`nodal/actions` :
 * « Print »), sinon « ✅ Confirm » / « Decline », jamais « Send » —, puis une
 * rangée de boutons par champ — chaque bouton nommé par son champ, pour
 * qu'aucun « Yes » ne soit ambigu — et les « ✏️ » des champs à taper.
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
  /** Les libellés que le serveur donne aux deux boutons (la ligne les porte). */
  actions?: ElicitationActions | null;
}): RenderedElicitationCard {
  const { approvalRequestId: id, fields, draft } = args;
  if (fields.length > 99) return { ok: false, reason: 'the form has more than 99 fields' };
  const perRow = Math.min(args.limits?.maxPerRow ?? PER_ROW, PER_ROW);
  const btn = (label: string, op: ElicitationOp): ElicitationCardButton => ({
    label,
    callbackData: elicitationCallbackData(id, op),
  });

  const labels = elicitationActionLabels(args.actions);
  const rows: ElicitationCardButton[][] = [
    [
      btn(labels.accept, { op: 'send', revision: elicitationDraftRevision(draft.values) }),
      btn(labels.decline, { op: 'decline' }),
    ],
  ];
  const typed: ElicitationCardButton[] = [];
  fields.forEach((f, i) => {
    const value = Object.prototype.hasOwnProperty.call(draft.values, f.key)
      ? draft.values[f.key]
      : undefined;
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
  const buttonCount = rows.reduce((n, row) => n + row.length, 0);
  const maxButtons = args.limits?.maxButtons;
  if (maxButtons !== undefined && buttonCount > maxButtons) {
    return {
      ok: false,
      reason: `the form needs ${buttonCount} buttons and this channel shows at most ${maxButtons}`,
    };
  }

  // Each field with its value, and its description under it: what the
  // dashboard shows next to the field, the card shows too.
  const lines = fields.map(
    (f) =>
      `${f.label}: ${shown(f, Object.prototype.hasOwnProperty.call(draft.values, f.key) ? draft.values[f.key] : undefined)}` +
      (f.description ? `\n  ${f.description}` : ''),
  );
  const waiting = fields.find((f) => f.key === draft.awaiting);
  const text =
    `❓ The MCP server "${args.server}" asks:\n\n` +
    `${quoteThirdPartyText(args.message)}\n\n` +
    (args.imageCount > 0
      ? `${args.imageCount === 1 ? 'The image above comes' : `The ${args.imageCount} images above come`} with the question.\n\n`
      : '') +
    lines.join('\n') +
    '\n\n' +
    (waiting
      ? `✏️ Reply to this message with ${waiting.label}: ${typedHint(waiting)}.`
      : `Set the values with the buttons, then tap ${labels.accept}. ` +
        'You can also answer from the dashboard.');
  const maxText = args.limits?.maxTextChars;
  if (maxText !== undefined && text.length > maxText) {
    return {
      ok: false,
      reason: `the card needs ${text.length} characters and this channel shows at most ${maxText} in one message`,
    };
  }
  return { ok: true, text, buttons: rows };
}
