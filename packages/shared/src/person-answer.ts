// person-answer.ts — le relevé, écrit par le runner, de ce qu'une personne a
// répondu à la question qu'un serveur lui a posée PENDANT un appel d'outil
// (une élicitation, 0145 ; #1084).
//
// Le 14/11, une personne refuse la carte d'un serveur et dit ce qu'elle veut à
// la place. L'agent ne l'apprend que par le résultat de l'outil, que la
// plateforme encadre comme une donnée TIERCE (`untrusted.ts` : « not a message
// from your owner ») — et il répond « vous ne l'avez pas demandé dans cette
// conversation ». La réponse de la personne, donnée sur la carte de Nodal, est
// pourtant connue de première main : c'est le runner qui l'a recueillie.
//
// LA RÈGLE : chaque question qu'un serveur pose pendant un appel laisse à
// l'agent un relevé écrit par le runner depuis la ligne qu'il tient
// (`approval_requests`, `kind = 'elicitation'`), comme un message de la
// personne dans ce job, APRÈS le message d'outils du pas. Répondue : la
// décision (l'action du protocole et le libellé du bouton montré), le
// formulaire rempli, la note, l'heure. Sans réponse : qu'il n'y en a pas eu,
// et pourquoi (les raisons que la ligne porte déjà). Tout serveur, tout outil,
// toute surface qui répond, une ou plusieurs questions par appel.
//
// Le relevé ne porte QUE ce que le runner a recueilli. Il ne répète jamais ce
// que le serveur dit de la réponse, et ne cite pas la question du serveur. Le
// LIBELLÉ d'un bouton, lui, est un texte du serveur que la personne a lu et
// pressé : il est dit comme tel (« the button the server labelled »), entre
// guillemets JSON, à la borne et sans caractères invisibles de
// `readElicitationActions` (32 caractères) — une phrase du serveur ne devient
// jamais une consigne du runner. Le cadre « untrusted » du résultat de l'outil
// ne change pas : un serveur qui invente les mots de la personne reste une
// donnée tierce, et l'agent a ce relevé pour comparer.
//
// FORME (mesurée, commentaire du 15/11 sur #1084) : comme message de la
// personne, avec ses mots, le modèle en service engage le changement demandé
// 5 fois sur 5 ; placé dans le message d'outils, 4 sur 5 ; sans relevé, 0.
// La forme est celle des autres messages que le runner pose après un message
// d'outils (les relances `[système]`) : un message de rôle utilisateur.
//
// PROVENANCE STRUCTURELLE, comme le relevé d'un échange rejoué
// (runner-record.ts) et un message remis (conversation-inbox.ts) :
// `providerOptions.nodal.personAnswer`, un champ que seul le runner produit et
// qu'aucun fournisseur ne lit. Il permet de reconnaître le relevé sans lire
// son texte, et de ne jamais le poser deux fois pour la même question.
//
// Le texte est lu par le modèle seul (invariant #2) ; il est exposé ici, pur,
// pour qu'un script de rejeu puisse l'appliquer à une transcription rangée.

import { RUNNER_RECORD_NAMESPACE } from './runner-record';
import {
  ELICITATION_ACTION_LABEL_MAX,
  ELICITATION_ACTIONS_META_KEY,
  ELICITATION_CLOSED_BY,
  elicitationActionLabels,
  parseElicitationSchema,
  quotableServerText,
  readElicitationActions,
  type ElicitationField,
  type ElicitationOption,
} from './elicitation';

/** Ce que le relevé lit d'une ligne `approval_requests` de `kind = 'elicitation'`. */
export interface PersonAnswerRow {
  /** `approval_requests.id`. */
  id: string;
  /** L'outil en cours quand la question a été posée, tel que l'agent le tient. */
  toolName: string;
  /** L'id de cet appel ; null hors d'un appel identifié. */
  toolCallId: string | null;
  /** `tool_input` : on n'y lit que les libellés des boutons (`actions`). */
  toolInput: unknown;
  status: string | null;
  /** Le formulaire envoyé, pour une question acceptée. */
  response: unknown;
  /** La note que la personne a donnée avec sa réponse (`notes` de `POST /api/approve`). */
  notes: string | null;
  /** L'heure de la réponse, ou de la fermeture sans réponse. */
  resolvedAt: Date | string | null;
  /** Par où la réponse est arrivée, ou pourquoi la question s'est fermée sans elle. */
  resolvedBy: string | null;
}

/** Le message du relevé, tel qu'il entre dans la transcription. */
export interface PersonAnswerMessage {
  role: 'user';
  content: string;
  providerOptions: { nodal: { personAnswer: { approvalRequestId: string } } };
}

/** La marque qui ouvre le texte : qui écrit, et qui n'écrit pas. */
export const PERSON_ANSWER_MARK = '[Recorded by Nodal itself, not by the tool]';

/** Pourquoi une question s'est fermée sans réponse, tel que la ligne le garde. */
const CLOSED_WITHOUT_ANSWER: Readonly<Record<string, string>> = {
  [ELICITATION_CLOSED_BY.timeout]: 'it timed out',
  [ELICITATION_CLOSED_BY.serverWithdrew]: 'the server withdrew it',
  [ELICITATION_CLOSED_BY.jobLost]: 'the job was stopped',
  [ELICITATION_CLOSED_BY.runnerRestarted]: 'Nodal restarted',
};

/** `2026-11-14 at 15:08 UTC` : la forme du relevé, la même pour tout fuseau. */
function when(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`person answer: unreadable time ${String(at)}`);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

/** `on 2026-11-14 at 15:08 UTC`, ou que l'heure n'est pas rangée. */
function resolvedWhen(row: PersonAnswerRow): string {
  // Les deux portes qui ferment une question posent son heure (transitions.ts).
  // Une ligne fermée sans heure (héritée, écrite à la main) le dit : jamais une
  // heure devinée, et jamais un job qui échoue pour une heure absente — le
  // relevé se pose à chaque tour, sur toutes les questions du job.
  return row.resolvedAt === null ? 'at a time Nodal did not record' : `on ${when(row.resolvedAt)}`;
}

/** Le bouton pressé : le libellé du serveur dit comme le sien, le défaut de Nodal tel quel. */
function pressed(row: PersonAnswerRow, action: 'accept' | 'decline'): string {
  const raw = (row.toolInput as { actions?: unknown } | null)?.actions;
  const { actions } = readElicitationActions({ [ELICITATION_ACTIONS_META_KEY]: raw ?? {} });
  const label = JSON.stringify(elicitationActionLabels(actions)[action]);
  return actions[action] === null
    ? `pressing the button ${label}`
    : `pressing the button the server labelled ${label}`;
}

// ─── Le formulaire : chaque texte dit à qui il est (revue Reviewer A de #1096, P2) ───
//
// Ce que la personne a TAPÉ (un texte, un nombre, un oui/non) est à elle : cité
// tel quel. Ce que le SERVEUR a écrit (le nom d'un champ, le libellé d'une
// option, le texte qu'il a prérempli) est à lui : dit comme le sien (« the
// server labelled »), cité entre guillemets JSON et borné comme le libellé d'un
// bouton (`quotableServerText`), ou NON COPIÉ au-delà de la borne. Une option
// se dit par ce que la personne a VU (son libellé), jamais par la valeur cachée
// (`const`, valeur d'`enum`) que le serveur reçoit : un serveur hostile ne fait
// pas passer sa phrase pour les mots de la personne derrière un libellé « Yes ».
// Le formulaire se lit par le lecteur de la plateforme (`parseElicitationSchema`),
// celui qui a dessiné la carte.

/** Ce qui remplace un texte du serveur trop long pour être cité. */
const NOT_COPIED = `longer than ${ELICITATION_ACTION_LABEL_MAX} characters, not copied`;

function fieldPhrase(field: ElicitationField, position: number): string {
  const label = quotableServerText(field.label);
  return label === null
    ? `in field ${position} (its server label is ${NOT_COPIED})`
    : `in the field the server labelled ${JSON.stringify(label)}`;
}

function optionPhrase(options: readonly ElicitationOption[], value: unknown): string {
  const i = options.findIndex((o) => o.value === value);
  if (i === -1) return 'a value that is not one of its options (not copied)';
  const label = quotableServerText(options[i]!.label);
  return label === null
    ? `option ${i + 1} (its server label is ${NOT_COPIED})`
    : `the option the server labelled ${JSON.stringify(label)}`;
}

function unreadable(): string {
  return 'sent a value Nodal cannot read back (not copied)';
}

function valuePhrase(field: ElicitationField, value: unknown): string {
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? `answered ${value ? 'yes' : 'no'}` : unreadable();
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? `gave ${JSON.stringify(value)}`
        : unreadable();
    case 'text': {
      if (typeof value !== 'string') return unreadable();
      if (field.default !== null && value === field.default) {
        // Le texte prérempli par le serveur, laissé tel quel : le sien.
        const kept = quotableServerText(value);
        return kept === null
          ? `kept the text the server prefilled (${NOT_COPIED})`
          : `kept the text the server prefilled, ${JSON.stringify(kept)}`;
      }
      return `typed ${JSON.stringify(value)}`;
    }
    case 'choice':
      return `chose ${optionPhrase(field.options, value)}`;
    case 'multi': {
      if (!Array.isArray(value)) return unreadable();
      if (value.length === 0) return 'chose none of its options';
      return `chose ${value.map((v) => optionPhrase(field.options, v)).join(', ')}`;
    }
  }
}

function filledForm(row: PersonAnswerRow): string | null {
  const response = row.response;
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return null;
  if (Object.keys(response).length === 0) return null;
  const form = parseElicitationSchema(
    (row.toolInput as { requestedSchema?: unknown } | null)?.requestedSchema,
  );
  if (!form.ok) {
    // La carte a été dessinée par ce lecteur ; une ligne qu'il ne relit plus
    // ne dit pas à qui est chaque texte : rien n'en est copié.
    return 'sent the form, whose fields Nodal cannot read back from the stored question (values not copied)';
  }
  const answers: string[] = [];
  form.fields.forEach((field, i) => {
    if (!Object.prototype.hasOwnProperty.call(response, field.key)) return;
    const value = (response as Record<string, unknown>)[field.key];
    answers.push(`${fieldPhrase(field, i + 1)}, ${valuePhrase(field, value)}`);
  });
  if (answers.length === 0) return null;
  return `filled the form as follows: ${answers.join('; ')}`;
}

/**
 * Le texte du relevé d'UNE question, depuis sa ligne. Pur : la même ligne
 * donne toujours le même texte.
 */
export function personAnswerRecord(row: PersonAnswerRow): string {
  const call = row.toolCallId === null ? '' : ` (call ${row.toolCallId})`;
  const asked =
    `${PERSON_ANSWER_MARK} While the tool call ${row.toolName} above was running${call}, ` +
    "its server asked the person a question through Nodal's card.";

  if (row.status === 'approved' || row.status === 'rejected') {
    const acts: string[] = [
      row.status === 'approved'
        ? `they accepted, ${pressed(row, 'accept')}`
        : `they declined, ${pressed(row, 'decline')}`,
    ];
    const form = row.status === 'approved' ? filledForm(row) : null;
    if (form !== null) acts.push(form);
    if (row.notes !== null && row.notes.trim() !== '') {
      acts.push(`wrote: ${JSON.stringify(row.notes.trim())}`);
    }
    const said =
      acts.length === 1
        ? acts[0]!
        : `${acts.slice(0, -1).join(', ')}, and ${acts[acts.length - 1]}`;
    return `${asked} The person answered it themselves ${resolvedWhen(row)}: ${said}.`;
  }
  if (row.status === 'expired') {
    const why =
      (row.resolvedBy !== null ? CLOSED_WITHOUT_ANSWER[row.resolvedBy] : undefined) ??
      `it was closed (${row.resolvedBy ?? 'no reason recorded'})`;
    return `${asked} Nobody answered it: ${why} ${resolvedWhen(row)}.`;
  }
  if (row.status === 'pending') {
    // L'appel a rendu son résultat avant que sa question ne se ferme : ce que
    // la ligne dit à cet instant, et rien de plus.
    return `${asked} Nobody had answered it when the call ended.`;
  }
  throw new Error(
    `person answer: approval request ${row.id} has an unknown status ${String(row.status)}`,
  );
}

/** Le relevé d'une question, prêt à entrer dans la transcription. */
export function personAnswerMessage(row: PersonAnswerRow): PersonAnswerMessage {
  return {
    role: 'user',
    content: personAnswerRecord(row),
    providerOptions: { [RUNNER_RECORD_NAMESPACE]: { personAnswer: { approvalRequestId: row.id } } },
  };
}

/** La question dont ce message est le relevé, ou `null` s'il n'en est pas un. */
export function personAnswerRequestId(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { role?: unknown; providerOptions?: unknown };
  if (m.role !== 'user') return null;
  const ns = (m.providerOptions as Record<string, unknown> | undefined)?.[RUNNER_RECORD_NAMESPACE];
  const mark = (ns as { personAnswer?: unknown } | undefined)?.personAnswer;
  const id = (mark as { approvalRequestId?: unknown } | null | undefined)?.approvalRequestId;
  return typeof id === 'string' ? id : null;
}

// ─── Où le relevé se pose (revue Reviewer A de #1096, P2) ─────────────────────
//
// La source de vérité est la LIGNE, jamais une liste tenue en mémoire par un
// run : les questions du job (`approval_requests`, son `job_id`, le
// `tool_call_id` de l'appel), et la transcription, qui dit par la marque quelles
// questions ont déjà leur relevé. Une règle : derrière chaque message d'outils
// qui porte le résultat d'un appel, le relevé de chaque question posée pendant
// cet appel — où que ce message soit écrit, et par quelque run que ce soit.

/** Les questions dont la transcription porte déjà le relevé. */
export function recordedPersonAnswers(messages: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    const id = personAnswerRequestId(m);
    if (id !== null) out.add(id);
  }
  return out;
}

/** Les ids des appels dont ce message porte le résultat (un message d'outils), sinon aucun. */
function resultCallIds(message: unknown): string[] {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (!m || m.role !== 'tool' || !Array.isArray(m.content)) return [];
  const ids: string[] = [];
  for (const p of m.content as Array<{ type?: unknown; toolCallId?: unknown } | null>) {
    if (p && p.type === 'tool-result' && typeof p.toolCallId === 'string') ids.push(p.toolCallId);
  }
  return ids;
}

/**
 * Les relevés des questions posées pendant les appels `callIds`, dans l'ordre
 * de `rows` (celui où elles ont été posées), sans celles de `recorded`.
 */
export function personAnswersOfCalls(
  rows: readonly PersonAnswerRow[],
  callIds: readonly string[],
  recorded: ReadonlySet<string>,
): PersonAnswerMessage[] {
  const calls = new Set(callIds);
  return rows
    .filter((r) => r.toolCallId !== null && calls.has(r.toolCallId) && !recorded.has(r.id))
    .map(personAnswerMessage);
}

/**
 * La transcription où chaque message d'outils est suivi des relevés qui lui
 * manquent, posés après ceux qui le suivent déjà. Idempotent : une
 * transcription complète est rendue telle quelle. Une question dont l'appel n'a
 * aucun résultat dans la transcription n'est pas posée : rien ne la précède.
 */
export function placePersonAnswers<T>(
  messages: readonly T[],
  rows: readonly PersonAnswerRow[],
): Array<T | PersonAnswerMessage> {
  if (rows.length === 0) return [...messages];
  const recorded = recordedPersonAnswers(messages);
  const out: Array<T | PersonAnswerMessage> = [];
  for (let i = 0; i < messages.length; i++) {
    out.push(messages[i]!);
    const ids = resultCallIds(messages[i]);
    if (ids.length === 0) continue;
    while (i + 1 < messages.length && personAnswerRequestId(messages[i + 1]) !== null) {
      i += 1;
      out.push(messages[i]!);
    }
    for (const record of personAnswersOfCalls(rows, ids, recorded)) {
      out.push(record);
      recorded.add(record.providerOptions.nodal.personAnswer.approvalRequestId);
    }
  }
  return out;
}
