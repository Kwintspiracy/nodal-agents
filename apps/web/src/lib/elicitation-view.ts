// elicitation-view.ts — ce que l'écran sait d'une QUESTION posée par un serveur
// MCP pendant un de ses appels (élicitation, migration 0145), et comment son
// formulaire passe de l'écran à la réponse.
//
// Sans directive : le fil (rendu serveur), la page Approvals et la carte
// (cliente) lisent le même type et les mêmes deux fonctions. La validation, elle,
// vit dans `@nodal-agents/shared` (`validateElicitationContent`) : le runner la
// refait, et c'est lui qui décide.

import {
  ELICITATION_CLOSED_BY,
  initialElicitationValues,
  readElicitationToolInput,
  setOwnValue,
  type ElicitationActions,
  type ElicitationField,
  type ElicitationValue,
} from '@nodal-agents/shared';

/** Une image jointe à la question, SANS ses octets : la carte la lit par la route. */
export type ElicitationAttachmentView = {
  position: number;
  mimeType: string;
  caption: string | null;
};

/** Une élicitation telle que la carte la dessine, en attente ou tranchée. */
export type ElicitationView = {
  approvalRequestId: string;
  status: string;
  /** Le slug du serveur MCP qui demande. */
  server: string;
  /** Sa question, telle quelle : texte tiers, montré comme une donnée citée. */
  message: string;
  /** Le formulaire demandé, brut (`tool_input.requestedSchema`). */
  requestedSchema: unknown;
  /** Les libellés que le serveur donne à ses boutons (`nodal/actions`) ; null : le défaut. */
  actions: ElicitationActions;
  /** Ce qui a été envoyé, sur une question répondue. */
  response: Record<string, unknown> | null;
  resolvedBy: string | null;
  expiresAt: Date | null;
  attachments: ElicitationAttachmentView[];
};

/**
 * La ligne `approval_requests` d'une élicitation, en vue. null quand son
 * `tool_input` ne se lit pas : la carte ne dessine pas une question qu'elle ne
 * sait pas citer (invariant #4), la page Approvals la garde en brut.
 */
export function toElicitationView(row: {
  id: string;
  status: string | null;
  toolInput: unknown;
  response: unknown;
  resolvedBy: string | null;
  expiresAt: Date | null;
  attachments: readonly ElicitationAttachmentView[];
}): ElicitationView | null {
  const input = readElicitationToolInput(row.toolInput);
  if (!input) return null;
  return {
    approvalRequestId: row.id,
    status: row.status ?? 'pending',
    server: input.server,
    message: input.message,
    requestedSchema: input.requestedSchema,
    actions: input.actions,
    response:
      typeof row.response === 'object' && row.response !== null && !Array.isArray(row.response)
        ? (row.response as Record<string, unknown>)
        : null,
    resolvedBy: row.resolvedBy,
    expiresAt: row.expiresAt,
    attachments: [...row.attachments].sort((a, b) => a.position - b.position),
  };
}

/** L'adresse d'une image jointe — la route vérifie la session et l'entité. */
export function attachmentHref(approvalRequestId: string, position: number): string {
  return `/api/approvals/${encodeURIComponent(approvalRequestId)}/attachments/${position}`;
}

// ─── Le formulaire ────────────────────────────────────────────────────────────

/**
 * La valeur d'un champ PENDANT la saisie. Un nombre reste du texte tant que la
 * personne tape : « 1. » ou « - » ne sont pas encore des nombres, et les
 * convertir à chaque frappe les effacerait.
 *
 * `null` : la personne n'a rien donné, et rien ne part. C'est un état à part,
 * jamais une valeur du schéma : `""` est une réponse texte valide, une option
 * peut valoir `""`, et `false` dit non (revue Codex passe 2 de #660).
 */
export type ElicitationFormValue = string | boolean | string[] | null;

export type ElicitationFormState = Record<string, ElicitationFormValue>;

/**
 * L'état de départ : les valeurs de départ de toute surface
 * (`initialElicitationValues`, la règle que les cartes des canaux suivent
 * aussi), un nombre en texte pendant la saisie, `null` pour un champ non posé.
 */
export function initialFormState(fields: readonly ElicitationField[]): ElicitationFormState {
  const values = initialElicitationValues(fields);
  const state: ElicitationFormState = {};
  for (const f of fields) {
    const v = Object.prototype.hasOwnProperty.call(values, f.key) ? values[f.key] : undefined;
    setOwnValue(state, f.key, v === undefined ? null : typeof v === 'number' ? String(v) : v);
  }
  return state;
}

/**
 * La saisie, en réponse à envoyer. Un champ sans valeur (`null`) n'est PAS
 * envoyé : s'il est obligatoire, la validation le dit (« is required ») au lieu
 * qu'on invente une valeur. Un texte part tel que la personne l'a laissé, vide
 * compris. Un nombre vide n'en est pas un : il ne part pas. Un nombre
 * illisible part tel quel, pour que la validation dise « must be a number »
 * plutôt que de l'effacer.
 */
export function formStateToContent(
  fields: readonly ElicitationField[],
  state: ElicitationFormState,
): Record<string, ElicitationValue> {
  const content: Record<string, ElicitationValue> = {};
  for (const f of fields) {
    // Propriétés PROPRES seulement : un champ s'appelle `__proto__` aussi bien.
    const v = Object.prototype.hasOwnProperty.call(state, f.key) ? state[f.key] : undefined;
    if (v === undefined || v === null) continue;
    if (f.kind === 'boolean') {
      if (typeof v === 'boolean') setOwnValue(content, f.key, v);
      continue;
    }
    if (f.kind === 'multi') {
      if (Array.isArray(v)) setOwnValue(content, f.key, v);
      continue;
    }
    if (typeof v !== 'string') continue;
    if (f.kind === 'number') {
      if (v.trim() === '') continue;
      const n = Number(v.trim());
      setOwnValue(content, f.key, Number.isFinite(n) ? n : v);
      continue;
    }
    setOwnValue(content, f.key, v);
  }
  return content;
}

/** Une valeur répondue, en une ligne lisible, avec les libellés des options. */
export function describeAnswerValue(field: ElicitationField | undefined, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.map((v) => describeAnswerValue(field, v)).join(', ');
  }
  if (typeof value === 'string' && field && (field.kind === 'choice' || field.kind === 'multi')) {
    return field.options.find((o) => o.value === value)?.label ?? value;
  }
  return String(value);
}

/**
 * Pourquoi une question n'a pas reçu de réponse. `expired` couvre chaque
 * chemin du runner (ELICITATION_CLOSED_BY, la liste partagée), et la personne
 * doit savoir lequel : le temps a passé, le run s'est arrêté (annulé, ou son
 * runner a redémarré), ou le serveur a retiré sa question.
 */
export function expiredReason(resolvedBy: string | null): string {
  switch (resolvedBy) {
    case ELICITATION_CLOSED_BY.jobLost:
    case ELICITATION_CLOSED_BY.runnerRestarted:
      return 'Closed: the run stopped before an answer';
    case ELICITATION_CLOSED_BY.serverWithdrew:
      return 'Withdrawn by the server';
    case 'system:ttl_expired':
    case ELICITATION_CLOSED_BY.timeout:
      return 'Expired: no answer in time';
    default:
      return 'Expired: no answer was sent';
  }
}
