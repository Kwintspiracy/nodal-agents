// run-rows.ts — les LIGNES du dossier MCP (18/09/2026).
//
// Le dossier MCP est le seul qui ne liste pas des conversations : un run lancé
// depuis dehors n'en a pas. Ses lignes sont donc bâties ici, et pas dans
// `conversation-rows.ts`, parce que les trois faits qui les composent ne
// viennent pas des mêmes colonnes :
//
//   - le TITRE est la tâche demandée, pas un titre qu'on a écrit ni qu'une IA
//     a renommé. C'est la seule phrase que la machine à l'autre bout a laissée ;
//   - l'HEURE est celle du DÉPART du run. Une conversation se date de son
//     dernier mot ; un run, lui, ne reçoit pas de réponse — il s'exécute ;
//   - ce qui ATTEND la personne se rattache au job de TÊTE, pas à une
//     conversation : une question posée par un délégué remonte à la ligne du
//     run qui l'a lancé (`rootJobId`, lib/actions.ts).
//
// Elles rendent le MÊME modèle que les autres dossiers (`ConversationRowModel`)
// et le même composant les dessine : deux formes de ligne dans la même boîte de
// réception auraient divergé au premier correctif.
//
// ⚠️ LE POINT VERT SE LIT SUR LE STATUT DU RUN, et rien d'autre. Un délégué qui
// tourne laisse son parent en `awaiting_delegation`, un statut vivant : la
// ligne de tête s'allume donc déjà, sans avoir à remonter la descendance.

import { redactSecretsInText } from '@nodal-agents/shared';
import { plainText } from '@/components/Markdown.tsx';
import { truncate } from '@/lib/format-time';
import { RUNNING_JOB_STATUSES } from '@/lib/chat-folders.ts';
import type { ExternalRunRow } from '@/lib/conversation-actions.ts';
import {
  conversationTimeLabel,
  type ConversationRowModel,
  type RowWaiting,
} from './conversation-rows.ts';

/** La même borne que le titre d'une conversation : le CSS coupe le reste. */
const TITLE_MAX = 120;

/** Une demande en attente, rattachée au run de tête qui la porte. */
export type WaitingOnRun = {
  /** Le job de TÊTE de la chaîne d'où vient la demande. `null` → aucune ligne. */
  rootJobId: string | null;
  /** `approval` ou `question`, lu sur la colonne. */
  kind: string;
};

export type RunRowsInput = {
  runs: readonly ExternalRunRow[];
  /** Les demandes en attente, toutes provenances confondues. */
  waiting?: readonly WaitingOnRun[];
  /** L'instant de référence, pour que le test ne dépende pas de l'heure. */
  now?: Date;
};

/**
 * Ce qu'un run attend de la personne, quand plusieurs demandes s'y empilent.
 * Une QUESTION passe avant une APPROBATION, la même règle que les lignes de
 * conversation : elle est adressée à la personne, l'approbation est une porte
 * qu'elle peut laisser fermée.
 */
function strongestWaiting(kinds: readonly string[]): RowWaiting {
  if (kinds.includes('question')) return 'question';
  if (kinds.includes('approval')) return 'approval';
  return null;
}

/**
 * Le titre d'un run : la première ligne lisible de sa tâche, MASQUÉE.
 *
 * Trois gestes, dans cet ordre, et l'ordre est la moitié du sujet :
 *
 *   1. `plainText` aplatit le markdown — une tâche écrite en gras s'afficherait
 *      sinon avec ses astérisques, et surtout un `**sk-…**` ne serait reconnu
 *      par aucun motif de rédaction ;
 *   2. `redactSecretsInText` masque (SECRET-001, Reviewer C sur #179). Ce titre
 *      EST la tâche que quelqu'un a postée à `/api/agent` : une clé collée
 *      dedans s'affichait en clair dans la liste, sur une ligne que personne
 *      n'a besoin d'ouvrir pour la lire ;
 *   3. `truncate` coupe EN DERNIER — couper d'abord laisserait passer les 120
 *      premiers signes d'une clé, ce qui en est l'essentiel.
 *
 * La liste des conversations masque par la même règle et pour la même raison,
 * à son propre bord de lecture (`firstLine`, lib/conversation-actions.ts) :
 * elle coupe les siens à 60 signes AVANT que cette ligne ne les voie.
 *
 * Une tâche vide rend « Untitled run » : un titre vide se lirait comme un
 * défaut d'affichage.
 */
export function runTitle(task: string): string {
  const line = redactSecretsInText(plainText(task));
  return line === '' ? 'Untitled run' : truncate(line, TITLE_MAX);
}

/** Un run avance-t-il encore ? Les mêmes statuts que le point vert des dossiers. */
export function runIsRunning(status: string | null): boolean {
  return status !== null && RUNNING_JOB_STATUSES.includes(status);
}

/**
 * Un run attend-il une réponse SANS qu'aucune demande ne le dise ?
 *
 * `awaiting_approval` est le seul statut vivant que le point vert exclut. Il
 * est traité comme une attente : sinon un run arrêté sur une approbation
 * expirée s'afficherait éteint, exactement comme un run terminé.
 */
function statusWaiting(status: string | null): RowWaiting {
  if (status === 'awaiting_approval') return 'approval';
  return null;
}

/**
 * Les lignes du dossier MCP, dans l'ordre reçu — le plus récent d'abord, celui
 * de la lecture.
 */
export function runRows(input: RunRowsInput): ConversationRowModel[] {
  const now = input.now ?? new Date();

  const byRun = new Map<string, string[]>();
  for (const w of input.waiting ?? []) {
    // Une demande dont la chaîne n'a pas pu être remontée ne se pose sur AUCUNE
    // ligne : lui en choisir une serait inventer sa provenance (invariant #4).
    if (w.rootJobId === null || w.rootJobId === '') continue;
    const seen = byRun.get(w.rootJobId);
    if (seen) seen.push(w.kind);
    else byRun.set(w.rootJobId, [w.kind]);
  }

  return input.runs.map((r) => ({
    id: r.id,
    key: r.id,
    // La ligne ouvre la page du RUN, pas un fil : il n'y en a pas.
    href: `/jobs/${r.id}`,
    // AUCUN agent, comme dans « Nodal chats » : c'est le titre qui distingue
    // un run d'un autre, et l'avatar répété prendrait la moitié de la ligne.
    agent: null,
    chatName: runTitle(r.task),
    // PAS d'aperçu : un run n'a pas de « dernier mot », il a un résultat, et
    // celui-ci se lit sur sa page.
    preview: null,
    time: conversationTimeLabel(r.createdAt, now),
    waiting: strongestWaiting(byRun.get(r.id) ?? []) ?? statusWaiting(r.status),
    running: runIsRunning(r.status),
  }));
}

/**
 * Combien de ces runs tournent — le chiffre de la phrase sous le titre.
 *
 * Il se lit sur les LIGNES affichées, pas sur le compte du menu : les deux
 * portent le même nom mais pas la même portée, le menu comptant aussi ce qui
 * dépasse la page chargée.
 */
export function runningCount(runs: readonly ExternalRunRow[]): number {
  return runs.filter((r) => runIsRunning(r.status)).length;
}

// `runIsDeletable` vit dans `lib/external-runs.ts` : l'action serveur en a
// besoin elle aussi, et une règle qui est une GARDE ne se recopie pas.
