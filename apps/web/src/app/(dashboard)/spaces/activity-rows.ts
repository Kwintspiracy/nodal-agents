// activity-rows.ts — LES LIGNES de l'onglet Conversations d'un projet (#143).
//
// Une seule liste, deux sortes de lignes, parce que deux choses différentes se
// sont passées dans ce dossier :
//
//   UNE CONVERSATION — quelqu'un a parlé à un agent. La ligne dit la dernière
//     phrase, combien de sessions sont parties de là, et ce qui attend ; elle
//     ouvre le fil, où les sessions se déplient comme aujourd'hui.
//   UNE SESSION SANS CONVERSATION — un run parti du CLI, du serveur MCP ou
//     d'un harnais. Il n'a pas de fil : la ligne ouvre la page du run. C'est
//     exactement ce que l'onglet Code listait, et il ne disparaît pas avec lui.
//
// Les deux rendent le MÊME modèle (`ConversationRowModel`) et le même composant
// les dessine — comme le dossier MCP le fait déjà pour ses runs. Deux formes de
// ligne dans la même boîte auraient divergé au premier correctif.
//
// Ce module est PUR : il ne lit ni base ni disque, et c'est ce qui permet de
// prouver ce que chaque ligne DIT sans monter un navigateur.

import { truncate } from '@/lib/format-time';
import type { ProjectActivityConversation, ProjectActivitySession } from '@/lib/project-actions.ts';
import {
  conversationTimeLabel,
  type ConversationRowModel,
  type RowWaiting,
} from '@/app/(dashboard)/chat/conversation-rows.ts';

const TITLE_MAX = 60;

/** Une demande en attente, rattachée à ce qui la porte. */
export type ActivityWaiting = {
  /** La conversation d'où vient la demande. `null` → aucune ligne de fil. */
  conversationId: string | null;
  /** Le job de TÊTE de la chaîne. `null` → aucune ligne de run. */
  rootJobId: string | null;
  /** `approval` ou `question`, lu sur la colonne. */
  kind: string;
};

export type ActivityRowsInput = {
  conversations: readonly ProjectActivityConversation[];
  sessions: readonly ProjectActivitySession[];
  waiting?: readonly ActivityWaiting[];
  /** L'instant de référence, pour que le test ne dépende pas de l'heure. */
  now?: Date;
};

/**
 * Une QUESTION passe avant une APPROBATION : elle est adressée à la personne,
 * l'approbation est une porte qu'elle peut laisser fermée. Un `kind` que le
 * produit ne connaît pas ne devient PAS une pastille au hasard.
 */
function strongestWaiting(kinds: readonly string[]): RowWaiting {
  if (kinds.includes('question')) return 'question';
  if (kinds.includes('approval')) return 'approval';
  return null;
}

/**
 * `awaiting_approval` est le seul statut vivant que le point vert exclut : il
 * se lit comme une attente, sinon un run arrêté sur une approbation expirée
 * s'afficherait éteint, exactement comme un run terminé.
 */
function statusWaiting(status: string | null): RowWaiting {
  return status === 'awaiting_approval' ? 'approval' : null;
}

/** Un run qui avance encore — les statuts VIVANTS de `agent_jobs`. */
export function jobIsRunning(status: string | null): boolean {
  return status === 'pending' || status === 'processing' || status === 'awaiting_delegation';
}

/** D'où la demande est partie, en deux mots. */
function originLabel(origin: string): string {
  if (origin === 'mcp') return 'from MCP';
  if (origin === 'api') return 'from the API';
  if (origin === 'cron') return 'from an automation';
  if (origin === 'internal') return 'from another agent';
  if (origin === 'dashboard') return 'from the dashboard';
  if (origin === 'cli') return 'from the CLI';
  return `from ${origin}`;
}

/**
 * Le nom d'un harnais, tel qu'il s'écrit. `null` quand aucune ligne `cli_runs`
 * ne le dit : la ligne écrit « Session », jamais un nom de produit deviné
 * (invariant #4).
 */
function providerLabel(provider: string | null): string | null {
  if (provider === 'claude') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  if (provider === null || provider === '') return null;
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

/**
 * Le TITRE d'une ligne de session : « Claude Code session · from the CLI ».
 *
 * Sans harnais connu, « Session · from MCP » — la provenance est lue sur la
 * colonne `channel`, elle, et elle ne manque jamais.
 */
export function sessionTitle(session: { provider: string | null; origin: string }): string {
  const harnais = providerLabel(session.provider);
  return `${harnais ? `${harnais} session` : 'Session'} · ${originLabel(session.origin)}`;
}

/** Ce que l'état d'un run vaut en mots — la langue de l'onglet Code. */
const STAGE_LABEL: Record<string, string> = {
  pending: 'Queued',
  processing: 'Running',
  awaiting_delegation: 'Delegated',
  awaiting_approval: 'Blocked',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function stageLabel(status: string | null): string | null {
  if (status === null) return null;
  return STAGE_LABEL[status] ?? status;
}

/**
 * Ce qu'une ligne de CONVERSATION dit sous son titre : le canal, l'agent, la
 * dernière phrase, et combien de sessions sont parties de là.
 *
 * Rien d'absent ne se dessine : un fil sans session ne dit pas « 0 sessions
 * inside », il ne dit rien.
 */
export function conversationSubline(c: ProjectActivityConversation): string | null {
  const parts: string[] = [];
  if (c.agentName) parts.push(c.agentName);
  if (c.lastPreview) parts.push(`“${c.lastPreview}”`);
  if (c.sessions > 0) {
    parts.push(c.sessions === 1 ? '1 session inside' : `${c.sessions} sessions inside`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Ce qu'une ligne de SESSION dit sous son titre : qu'elle est seule, et où elle en est. */
export function sessionSubline(s: ProjectActivitySession): string {
  const parts: string[] = ['No conversation'];
  const etat = stageLabel(s.status);
  if (etat) parts.push(etat);
  if (s.task !== '') parts.push(s.task);
  return parts.join(' · ');
}

/**
 * Les lignes de l'onglet, de la plus récente à la plus ancienne.
 *
 * Les deux sortes sont triées ENSEMBLE : c'est une seule histoire du projet, et
 * empiler les conversations puis les runs raconterait deux fois la même semaine.
 * Une ligne sans date ferme la marche plutôt que de passer devant.
 */
export function activityRows(input: ActivityRowsInput): ConversationRowModel[] {
  const now = input.now ?? new Date();

  const parConversation = new Map<string, string[]>();
  const parRun = new Map<string, string[]>();
  for (const w of input.waiting ?? []) {
    if (w.conversationId) {
      const vu = parConversation.get(w.conversationId);
      if (vu) vu.push(w.kind);
      else parConversation.set(w.conversationId, [w.kind]);
    } else if (w.rootJobId) {
      // Une demande SANS conversation se pose sur la ligne du run qui l'a
      // lancée. Sans l'un ni l'autre, elle ne se pose sur AUCUNE ligne : lui
      // en choisir une serait inventer sa provenance.
      const vu = parRun.get(w.rootJobId);
      if (vu) vu.push(w.kind);
      else parRun.set(w.rootJobId, [w.kind]);
    }
  }

  const lignes: Array<{ at: number; row: ConversationRowModel }> = [];

  for (const c of input.conversations) {
    lignes.push({
      at: c.updatedAt?.getTime() ?? 0,
      row: {
        id: c.id,
        key: `conversation-${c.id}`,
        href: `/chat/${c.id}`,
        // L'agent CHANGE d'une ligne à l'autre dans un projet : son avatar
        // distingue les lignes, et son nom part dans la sous-ligne — le titre
        // de la ligne est ce qui a été demandé.
        agent: { name: c.agentName, avatarUrl: c.agentAvatarUrl },
        // Un fil que personne n'a nommé et que l'IA n'a pas encore renommé n'a
        // pas de titre : « Untitled » dit ce que c'est, un titre vide se
        // lirait comme un défaut d'affichage.
        chatName: c.title === '' ? 'Untitled' : truncate(c.title, TITLE_MAX),
        preview: conversationSubline(c),
        time: conversationTimeLabel(c.updatedAt, now),
        waiting: strongestWaiting(parConversation.get(c.id) ?? []),
        running: c.running,
        // Branche de démo seulement : l'état de lecture (#223) n'est pas
        // encore relié à l'activité d'un projet ; la PR #226 le fera en
        // reprenant main.
        unread: false,
      },
    });
  }

  for (const s of input.sessions) {
    lignes.push({
      at: s.createdAt?.getTime() ?? 0,
      row: {
        id: s.id,
        key: `session-${s.id}`,
        // La ligne ouvre la page du RUN DE CODE — celle que l'onglet Code
        // ouvrait, et qui ne disparaît pas avec sa liste.
        href: `/code/${s.id}`,
        agent: { name: s.agentName, avatarUrl: s.agentAvatarUrl },
        chatName: sessionTitle(s),
        preview: sessionSubline(s),
        time: conversationTimeLabel(s.createdAt, now),
        waiting: strongestWaiting(parRun.get(s.id) ?? []) ?? statusWaiting(s.status),
        running: jobIsRunning(s.status),
        // Un run de code n'a pas d'état de lecture : rien n'y est « lu ».
        unread: false,
      },
    });
  }

  return lignes.sort((a, b) => b.at - a.at).map((l) => l.row);
}
