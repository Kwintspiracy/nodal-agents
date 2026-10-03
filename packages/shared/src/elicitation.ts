// elicitation.ts — ce qu'un serveur MCP demande à une personne PENDANT un de
// ses appels (`elicitation/create`, mode formulaire), lu une fois pour tous :
// le runner qui pose la question, la route qui reçoit la réponse, le web qui
// dessine le formulaire, et (PR suivante) les canaux qui le parcourent.
//
// Trois fonctions pures :
//   - `parseElicitationSchema` : le formulaire demandé, en champs que l'écran
//     sait dessiner. Un schéma hors du sous-ensemble du protocole est REFUSÉ
//     avec sa raison, jamais dessiné à moitié (invariant #4).
//   - `validateElicitationContent` : une réponse contre ce formulaire. La
//     personne voit l'erreur avant le serveur, qui revalide de son côté.
//   - `readElicitationAttachments` : les images jointes à la question, sous la
//     clé documentée `nodal/attachments` de `params._meta`. Une pièce invalide
//     est écartée avec sa raison, jamais la question.

/** La clé de `params._meta` sous laquelle un serveur joint des images à sa question. */
export const ELICITATION_ATTACHMENTS_META_KEY = 'nodal/attachments';

/**
 * La clé de `params._meta` sous laquelle un serveur nomme les deux boutons de
 * sa question : `{ accept?: string, decline?: string }`. « Print » dit ce que
 * le bouton FAIT ; « Send » ne disait rien (retour du propriétaire, 01/10).
 */
export const ELICITATION_ACTIONS_META_KEY = 'nodal/actions';

/** Caractères au plus d'un libellé de bouton : au-delà il est refusé, jamais coupé. */
export const ELICITATION_ACTION_LABEL_MAX = 32;

/** Les libellés quand le serveur n'en donne pas. Jamais « Send ». */
export const ELICITATION_DEFAULT_ACCEPT_LABEL = '✅ Confirm';
export const ELICITATION_DEFAULT_DECLINE_LABEL = 'Decline';

/** Types d'image acceptés en pièce jointe : ceux que le web et les canaux affichent tels quels. */
export const ELICITATION_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ElicitationAttachmentMimeType = (typeof ELICITATION_ATTACHMENT_MIME_TYPES)[number];

/** Nombre d'images au plus par question. Au-delà, les suivantes sont écartées et c'est dit. */
export const ELICITATION_ATTACHMENTS_MAX = 4;

/** Octets au plus par image (décodée). Sous la limite d'une photo Telegram (10 Mo). */
export const ELICITATION_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Caractères au plus d'une légende ; au-delà elle est tronquée, l'image gardée. */
export const ELICITATION_CAPTION_MAX = 300;

/** Une réponse texte libre ne dépasse pas cette longueur, quoi que le schéma autorise. */
export const ELICITATION_TEXT_MAX = 2000;

// ─── Le formulaire ────────────────────────────────────────────────────────────

/** Une option d'un choix : la valeur renvoyée au serveur, et ce que la personne lit. */
export interface ElicitationOption {
  value: string;
  label: string;
}

interface FieldBase {
  /** Le nom de la propriété, tel que le serveur l'attend dans la réponse. */
  key: string;
  /** `title` du schéma, sinon la clé. */
  label: string;
  description: string | null;
  required: boolean;
}

export type ElicitationField =
  | (FieldBase & { kind: 'boolean'; default: boolean | null })
  | (FieldBase & {
      kind: 'number';
      integer: boolean;
      minimum: number | null;
      maximum: number | null;
      default: number | null;
    })
  | (FieldBase & {
      kind: 'text';
      minLength: number | null;
      maxLength: number | null;
      format: 'email' | 'uri' | 'date' | 'date-time' | null;
      default: string | null;
    })
  | (FieldBase & { kind: 'choice'; options: ElicitationOption[]; default: string | null })
  | (FieldBase & {
      kind: 'multi';
      options: ElicitationOption[];
      minItems: number | null;
      maxItems: number | null;
      default: string[] | null;
    });

export type ElicitationValue = string | number | boolean | string[];

export type ParsedElicitationSchema =
  | { ok: true; fields: ElicitationField[] }
  | { ok: false; reason: string };

const TEXT_FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function optNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** Les options d'un `oneOf` / `anyOf` titré : `[{ const, title }]`. */
function titledOptions(v: unknown): ElicitationOption[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: ElicitationOption[] = [];
  for (const o of v) {
    if (!isRecord(o) || typeof o['const'] !== 'string') return null;
    out.push({
      value: o['const'],
      label: typeof o['title'] === 'string' && o['title'] !== '' ? o['title'] : o['const'],
    });
  }
  return out;
}

/** Les options d'un `enum`, avec les `enumNames` hérités quand ils sont là. */
function enumOptions(values: string[], names: unknown): ElicitationOption[] {
  const labels = stringArray(names);
  return values.map((value, i) => ({
    value,
    label: labels && typeof labels[i] === 'string' && labels[i] !== '' ? labels[i]! : value,
  }));
}

function parseField(
  key: string,
  raw: unknown,
  required: boolean,
): ElicitationField | { error: string } {
  if (!isRecord(raw)) return { error: `property "${key}" is not an object` };
  const base: FieldBase = {
    key,
    label: optString(raw['title']) ?? key,
    description: optString(raw['description']),
    required,
  };
  const type = raw['type'];

  if (type === 'boolean') {
    return {
      ...base,
      kind: 'boolean',
      default: typeof raw['default'] === 'boolean' ? raw['default'] : null,
    };
  }

  if (type === 'number' || type === 'integer') {
    const integer = type === 'integer';
    const minimum = optNumber(raw['minimum']);
    const maximum = optNumber(raw['maximum']);
    if (minimum !== null && maximum !== null && minimum > maximum) {
      return { error: `property "${key}" has minimum ${minimum} above maximum ${maximum}` };
    }
    if (integer && minimum !== null && maximum !== null && Math.ceil(minimum) > maximum) {
      return {
        error: `property "${key}" admits no whole number between ${minimum} and ${maximum}`,
      };
    }
    const def = optNumber(raw['default']);
    return { ...base, kind: 'number', integer, minimum, maximum, default: def };
  }

  if (type === 'string') {
    if (raw['enum'] !== undefined) {
      const values = stringArray(raw['enum']);
      if (!values || values.length === 0) {
        return { error: `property "${key}" has an enum that is not a non-empty list of strings` };
      }
      const def = typeof raw['default'] === 'string' ? raw['default'] : null;
      return {
        ...base,
        kind: 'choice',
        options: enumOptions(values, raw['enumNames']),
        default: def,
      };
    }
    if (raw['oneOf'] !== undefined) {
      const options = titledOptions(raw['oneOf']);
      if (!options)
        return { error: `property "${key}" has a oneOf that is not [{ const, title }]` };
      const def = typeof raw['default'] === 'string' ? raw['default'] : null;
      return { ...base, kind: 'choice', options, default: def };
    }
    const format = raw['format'];
    if (format !== undefined && !(typeof format === 'string' && TEXT_FORMATS.has(format))) {
      return { error: `property "${key}" has an unsupported string format "${String(format)}"` };
    }
    const minLength = optNumber(raw['minLength']);
    const maxLength = optNumber(raw['maxLength']);
    if (minLength !== null && maxLength !== null && minLength > maxLength) {
      return { error: `property "${key}" has minLength ${minLength} above maxLength ${maxLength}` };
    }
    if (minLength !== null && minLength > ELICITATION_TEXT_MAX) {
      return {
        error: `property "${key}" asks for at least ${minLength} characters, above the ${ELICITATION_TEXT_MAX} an answer may hold`,
      };
    }
    return {
      ...base,
      kind: 'text',
      minLength,
      maxLength,
      format: (format as 'email' | 'uri' | 'date' | 'date-time' | undefined) ?? null,
      default: typeof raw['default'] === 'string' ? raw['default'] : null,
    };
  }

  if (type === 'array') {
    const items = raw['items'];
    if (!isRecord(items)) return { error: `property "${key}" is an array without items` };
    let options: ElicitationOption[] | null = null;
    if (items['enum'] !== undefined) {
      const values = stringArray(items['enum']);
      options = values && values.length > 0 ? enumOptions(values, undefined) : null;
    } else if (items['anyOf'] !== undefined) {
      options = titledOptions(items['anyOf']);
    }
    if (!options) {
      return { error: `property "${key}" is an array whose items are not a list of choices` };
    }
    const minItems = optNumber(raw['minItems']);
    const maxItems = optNumber(raw['maxItems']);
    if (minItems !== null && maxItems !== null && minItems > maxItems) {
      return { error: `property "${key}" has minItems ${minItems} above maxItems ${maxItems}` };
    }
    if (minItems !== null && minItems > options.length) {
      return {
        error: `property "${key}" asks for at least ${minItems} choices out of ${options.length}`,
      };
    }
    return {
      ...base,
      kind: 'multi',
      options,
      minItems,
      maxItems,
      default: stringArray(raw['default']),
    };
  }

  return { error: `property "${key}" has an unsupported type "${String(type)}"` };
}

/**
 * Le formulaire qu'un serveur demande, en champs que l'écran sait dessiner.
 *
 * Le sous-ensemble du protocole (spec MCP, `requestedSchema`) : un objet plat
 * dont chaque propriété est un booléen, un nombre (`number`/`integer`, bornes
 * optionnelles), un texte (longueurs, `format` email/uri/date/date-time), un
 * choix (`enum`, `enum`+`enumNames`, `oneOf` titré) ou un choix multiple
 * (`array` d'`enum` ou d'`anyOf` titré). Tout le reste est refusé avec la
 * raison : un champ qu'on ne sait pas dessiner ne se remplace pas par un autre.
 * Un champ dont les bornes n'admettent aucune réponse que
 * `validateElicitationContent` accepte l'est aussi : dessiné, il attendrait une
 * personne qui ne pourrait jamais l'envoyer.
 */
export function parseElicitationSchema(raw: unknown): ParsedElicitationSchema {
  if (!isRecord(raw)) return { ok: false, reason: 'requestedSchema is not an object' };
  if (raw['type'] !== 'object') {
    return { ok: false, reason: 'requestedSchema.type is not "object"' };
  }
  const properties = raw['properties'];
  if (!isRecord(properties)) {
    return { ok: false, reason: 'requestedSchema.properties is not an object' };
  }
  const requiredList = raw['required'] === undefined ? [] : stringArray(raw['required']);
  if (requiredList === null) {
    return { ok: false, reason: 'requestedSchema.required is not a list of strings' };
  }
  for (const r of requiredList) {
    if (!Object.prototype.hasOwnProperty.call(properties, r)) {
      return { ok: false, reason: `required property "${r}" is not declared` };
    }
  }
  const fields: ElicitationField[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    const parsed = parseField(key, prop, requiredList.includes(key));
    if ('error' in parsed) return { ok: false, reason: parsed.error };
    fields.push(parsed);
  }
  return { ok: true, fields };
}

// ─── La réponse ───────────────────────────────────────────────────────────────

export interface ElicitationContentError {
  /** La clé du champ, ou `null` pour une erreur qui ne tient à aucun champ. */
  field: string | null;
  reason: string;
}

export type ValidatedElicitationContent =
  | { ok: true; content: Record<string, ElicitationValue> }
  | { ok: false; errors: ElicitationContentError[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// RFC 3339 (`full-date`, `date-time`), the formats JSON Schema names. Never
// `Date.parse`: it moves 2024-02-30 to March and reads a time without an offset
// as local time, so a server validating the format would refuse what we sent.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

/** A day that exists in the calendar. */
function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function isDateTime(value: string): boolean {
  const m = DATE_TIME_RE.exec(value);
  if (!m || !isCalendarDate(m[1]!)) return false;
  const [h, mi, s] = [Number(m[2]), Number(m[3]), Number(m[4])];
  // 60: the leap second RFC 3339 allows.
  if (h > 23 || mi > 59 || s > 60) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  return true;
}

function formatError(format: string, value: string): string | null {
  if (format === 'email' && !EMAIL_RE.test(value)) return 'is not an email address';
  if (format === 'uri') {
    try {
      new URL(value);
    } catch {
      return 'is not a URI';
    }
  }
  if (format === 'date' && !isCalendarDate(value)) return 'is not a date (YYYY-MM-DD)';
  if (format === 'date-time' && !isDateTime(value)) return 'is not a date-time';
  return null;
}

function checkValue(field: ElicitationField, value: unknown): string | null {
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (field.integer && !Number.isInteger(value)) return 'must be a whole number';
      if (field.minimum !== null && value < field.minimum)
        return `must be at least ${field.minimum}`;
      if (field.maximum !== null && value > field.maximum)
        return `must be at most ${field.maximum}`;
      return null;
    }
    case 'text': {
      if (typeof value !== 'string') return 'must be text';
      if (value.length > ELICITATION_TEXT_MAX) {
        return `must be at most ${ELICITATION_TEXT_MAX} characters`;
      }
      if (field.minLength !== null && value.length < field.minLength) {
        return `must be at least ${field.minLength} characters`;
      }
      if (field.maxLength !== null && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
      }
      return field.format ? formatError(field.format, value) : null;
    }
    case 'choice':
      return typeof value === 'string' && field.options.some((o) => o.value === value)
        ? null
        : 'is not one of the offered choices';
    case 'multi': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        return 'must be a list of choices';
      }
      if (!value.every((v) => field.options.some((o) => o.value === v))) {
        return 'contains a value that is not one of the offered choices';
      }
      if (new Set(value).size !== value.length) return 'contains the same choice twice';
      if (field.minItems !== null && value.length < field.minItems) {
        return `needs at least ${field.minItems} choices`;
      }
      if (field.maxItems !== null && value.length > field.maxItems) {
        return `allows at most ${field.maxItems} choices`;
      }
      return null;
    }
  }
}

/**
 * Une réponse contre le formulaire demandé. Refuse un champ obligatoire absent,
 * une valeur du mauvais type ou hors bornes, une option qui n'était pas offerte,
 * et toute clé que le formulaire ne déclare pas — rien n'est corrigé ni jeté en
 * silence : la personne lit pourquoi, champ par champ.
 *
 * `schema` : le `requestedSchema` brut (tel que la ligne le porte) ou des
 * champs déjà lus.
 */
export function validateElicitationContent(
  schema: unknown,
  content: unknown,
): ValidatedElicitationContent {
  const fields = Array.isArray(schema)
    ? (schema as ElicitationField[])
    : (() => {
        const parsed = parseElicitationSchema(schema);
        return parsed.ok ? parsed.fields : parsed.reason;
      })();
  if (typeof fields === 'string') {
    return { ok: false, errors: [{ field: null, reason: `unreadable form: ${fields}` }] };
  }
  if (!isRecord(content)) {
    return { ok: false, errors: [{ field: null, reason: 'the answer is not an object' }] };
  }
  const errors: ElicitationContentError[] = [];
  const out: Record<string, ElicitationValue> = {};
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(content)) {
    if (!known.has(key)) errors.push({ field: key, reason: 'is not a field of this form' });
  }
  for (const field of fields) {
    const has = Object.prototype.hasOwnProperty.call(content, field.key);
    const value = has ? content[field.key] : undefined;
    if (value === undefined || value === null) {
      if (field.required) errors.push({ field: field.key, reason: 'is required' });
      continue;
    }
    const problem = checkValue(field, value);
    if (problem) errors.push({ field: field.key, reason: problem });
    else out[field.key] = value as ElicitationValue;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, content: out };
}

/** Les erreurs d'une réponse, en une phrase lisible (« copies: must be at most 5 »). */
export function describeElicitationErrors(errors: readonly ElicitationContentError[]): string {
  return errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join('; ');
}

// ─── Les libellés des boutons ─────────────────────────────────────────────────

/** Les libellés que le serveur donne à ses deux boutons ; null : le libellé par défaut. */
export interface ElicitationActions {
  accept: string | null;
  decline: string | null;
}

export interface RejectedElicitationAction {
  /** Le bouton visé ; null quand c'est la clé entière qui ne se lit pas. */
  action: 'accept' | 'decline' | null;
  reason: string;
}

/**
 * Un libellé tiers, rendu affichable : les caractères de contrôle et de mise
 * en forme invisibles (retours à la ligne, inversions bidirectionnelles,
 * caractères de largeur nulle) sont retirés, les espaces resserrés. Un
 * libellé vide ensuite, ou trop long, est REFUSÉ avec la raison — jamais
 * coupé ni deviné.
 */
function neutralizeActionLabel(raw: unknown): { label: string } | { reason: string } {
  if (typeof raw !== 'string') return { reason: 'is not text' };
  const label = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (label === '') return { reason: 'is empty' };
  if ([...label].length > ELICITATION_ACTION_LABEL_MAX) {
    return { reason: `is longer than ${ELICITATION_ACTION_LABEL_MAX} characters` };
  }
  return { label };
}

/**
 * Les libellés de `params._meta["nodal/actions"]`, chacun vérifié à part : un
 * libellé refusé est rendu dans `rejected` avec sa raison (l'appelant le
 * journalise) et son bouton garde le libellé par défaut ; l'autre est gardé.
 */
export function readElicitationActions(meta: unknown): {
  actions: ElicitationActions;
  rejected: RejectedElicitationAction[];
} {
  const actions: ElicitationActions = { accept: null, decline: null };
  const rejected: RejectedElicitationAction[] = [];
  if (!isRecord(meta)) return { actions, rejected };
  const raw = meta[ELICITATION_ACTIONS_META_KEY];
  if (raw === undefined) return { actions, rejected };
  if (!isRecord(raw)) {
    rejected.push({ action: null, reason: `${ELICITATION_ACTIONS_META_KEY} is not an object` });
    return { actions, rejected };
  }
  for (const action of ['accept', 'decline'] as const) {
    if (raw[action] === undefined) continue;
    const read = neutralizeActionLabel(raw[action]);
    if ('label' in read) actions[action] = read.label;
    else rejected.push({ action, reason: read.reason });
  }
  return { actions, rejected };
}

/** Les deux libellés à afficher : ceux du serveur, sinon « ✅ Confirm » / « Decline ». */
export function elicitationActionLabels(actions: ElicitationActions | null | undefined): {
  accept: string;
  decline: string;
} {
  return {
    accept: actions?.accept ?? ELICITATION_DEFAULT_ACCEPT_LABEL,
    decline: actions?.decline ?? ELICITATION_DEFAULT_DECLINE_LABEL,
  };
}

// ─── La ligne ─────────────────────────────────────────────────────────────────

/** Ce qu'une ligne `kind = 'elicitation'` porte dans `tool_input`. */
export interface ElicitationToolInput {
  /** Le slug du serveur MCP qui demande. */
  server: string;
  /** Sa question, telle quelle. Texte tiers : affiché comme une donnée citée. */
  message: string;
  /** Le formulaire demandé, brut. */
  requestedSchema: unknown;
  /** Les libellés de ses boutons (`nodal/actions`), relus par la même règle. */
  actions: ElicitationActions;
}

/** Lit `tool_input` d'une élicitation ; null quand la ligne ne se lit pas. */
export function readElicitationToolInput(toolInput: unknown): ElicitationToolInput | null {
  if (!isRecord(toolInput)) return null;
  const { server, message, requestedSchema } = toolInput;
  if (typeof server !== 'string' || server === '') return null;
  if (typeof message !== 'string') return null;
  if (!isRecord(requestedSchema)) return null;
  // Relus par la règle de la lecture : une ligne écrite à la main, ou avant
  // un resserrement de la règle, n'affiche pas plus que ce qu'elle permet.
  const { actions } = readElicitationActions({
    [ELICITATION_ACTIONS_META_KEY]: toolInput['actions'] ?? {},
  });
  return { server, message, requestedSchema, actions };
}

// ─── Les images jointes ───────────────────────────────────────────────────────

export interface ElicitationAttachment {
  mimeType: ElicitationAttachmentMimeType;
  /** Base64, tel que reçu (sans préfixe `data:`). */
  data: string;
  /** Taille décodée, en octets. */
  byteSize: number;
  caption: string | null;
}

export interface RejectedElicitationAttachment {
  index: number;
  reason: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Les premiers octets attendus de chaque type, pour qu'un type déclaré soit un type réel. */
function matchesSignature(mime: ElicitationAttachmentMimeType, head: string): boolean {
  const b = (i: number) => head.charCodeAt(i);
  switch (mime) {
    case 'image/png':
      return b(0) === 0x89 && head.slice(1, 4) === 'PNG';
    case 'image/jpeg':
      return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
    case 'image/gif':
      return head.slice(0, 4) === 'GIF8';
    case 'image/webp':
      return head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP';
  }
}

function decodedByteSize(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Les images jointes à une question : `params._meta["nodal/attachments"]`, un
 * tableau de `{ mimeType, data (base64), caption? }`.
 *
 * Chaque pièce est vérifiée — type d'image accepté, base64 valide, octets qui
 * commencent comme le type annoncé, taille plafonnée — et le nombre plafonné.
 * Une pièce refusée est rendue dans `rejected` avec sa raison (l'appelant la
 * journalise) ; la question, elle, n'est jamais refusée pour une pièce jointe.
 */
export function readElicitationAttachments(meta: unknown): {
  attachments: ElicitationAttachment[];
  rejected: RejectedElicitationAttachment[];
} {
  const attachments: ElicitationAttachment[] = [];
  const rejected: RejectedElicitationAttachment[] = [];
  if (!isRecord(meta)) return { attachments, rejected };
  const raw = meta[ELICITATION_ATTACHMENTS_META_KEY];
  if (raw === undefined) return { attachments, rejected };
  if (!Array.isArray(raw)) {
    rejected.push({ index: -1, reason: `${ELICITATION_ATTACHMENTS_META_KEY} is not an array` });
    return { attachments, rejected };
  }
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const mime = item['mimeType'];
    if (
      typeof mime !== 'string' ||
      !(ELICITATION_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)
    ) {
      rejected.push({ index, reason: `mimeType "${String(mime)}" is not an accepted image type` });
      return;
    }
    const data = item['data'];
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length % 4 !== 0 ||
      !BASE64_RE.test(data)
    ) {
      rejected.push({ index, reason: 'data is not base64' });
      return;
    }
    const byteSize = decodedByteSize(data);
    if (byteSize > ELICITATION_ATTACHMENT_MAX_BYTES) {
      rejected.push({
        index,
        reason: `${byteSize} bytes, above the ${ELICITATION_ATTACHMENT_MAX_BYTES}-byte limit`,
      });
      return;
    }
    let head: string;
    try {
      head = atob(data.slice(0, 16));
    } catch {
      rejected.push({ index, reason: 'data is not base64' });
      return;
    }
    const mimeType = mime as ElicitationAttachmentMimeType;
    if (!matchesSignature(mimeType, head)) {
      rejected.push({ index, reason: `data does not start like a ${mimeType} file` });
      return;
    }
    if (attachments.length >= ELICITATION_ATTACHMENTS_MAX) {
      rejected.push({ index, reason: `more than ${ELICITATION_ATTACHMENTS_MAX} images` });
      return;
    }
    const caption = optString(item['caption']);
    attachments.push({
      mimeType,
      data,
      byteSize,
      caption:
        caption === null
          ? null
          : caption.length > ELICITATION_CAPTION_MAX
            ? `${caption.slice(0, ELICITATION_CAPTION_MAX)}…`
            : caption,
    });
  });
  return { attachments, rejected };
}
