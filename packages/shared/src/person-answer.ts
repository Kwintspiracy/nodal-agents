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
  ELICITATION_ACTIONS_META_KEY,
  ELICITATION_CLOSED_BY,
  elicitationActionLabels,
  readElicitationActions,
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

function resolvedWhen(row: PersonAnswerRow): string {
  if (row.resolvedAt === null) {
    // Les deux portes qui ferment une question posent son heure (transitions.ts) :
    // une ligne fermée sans heure est un défaut, dit, jamais une heure devinée.
    throw new Error(
      `person answer: approval request ${row.id} is ${row.status} without resolved_at`,
    );
  }
  return when(row.resolvedAt);
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

function filledForm(response: unknown): string | null {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return null;
  if (Object.keys(response).length === 0) return null;
  return `filled the form with: ${JSON.stringify(response)}`;
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
    const form = row.status === 'approved' ? filledForm(row.response) : null;
    if (form !== null) acts.push(form);
    if (row.notes !== null && row.notes.trim() !== '') {
      acts.push(`wrote: ${JSON.stringify(row.notes.trim())}`);
    }
    const said =
      acts.length === 1
        ? acts[0]!
        : `${acts.slice(0, -1).join(', ')}, and ${acts[acts.length - 1]}`;
    return `${asked} The person answered it themselves on ${resolvedWhen(row)}: ${said}.`;
  }
  if (row.status === 'expired') {
    const why =
      (row.resolvedBy !== null ? CLOSED_WITHOUT_ANSWER[row.resolvedBy] : undefined) ??
      `it was closed (${row.resolvedBy ?? 'no reason recorded'})`;
    return `${asked} Nobody answered it: ${why} on ${resolvedWhen(row)}.`;
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
