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

import { runIsRunning, runTitle } from '@/lib/external-runs.ts';
import type { ExternalRunRow } from '@/lib/conversation-actions.ts';
import {
  conversationTimeLabel,
  type ConversationRowModel,
  type RowWaiting,
} from './conversation-rows.ts';

// `runTitle` et `runIsRunning` vivent dans `lib/external-runs.ts` depuis le
// 18/09/2026 : le sous-menu d'un dossier de la barre latérale nomme les mêmes
// runs et allume leur point par les mêmes règles, et sa lecture est une action
// serveur. Réexportés pour que rien ne change à l'usage.
export { runIsRunning, runTitle };

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
    // Sous `/chat`, pas `/jobs` : ouvrir un run depuis Work garde la barre
    // latérale sur Work (`/jobs` est une route de Scheduled ; Quentin, 24/09).
    href: `/chat/runs/${r.id}`,
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
    // JAMAIS non lu (#209). Un run venu de dehors n'a pas de conversation, et
    // le marqueur de lecture se pose sur une conversation : il n'y a rien à
    // marquer, et rien à comparer. `false` dit « rien à signaler », ce qui est
    // la vérité ; l'état de lecture d'un run est un autre sujet, hors du
    // périmètre de #209.
    unread: false,
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
