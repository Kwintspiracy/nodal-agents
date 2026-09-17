// activity-runs.ts — le vocabulaire de la liste des runs (#134).
//
// La vue Activity ne compte plus des appels d'outils mais des RUNS : une ligne
// repliée par job, dépliable sur ses appels. Deux choses de cette ligne ne
// dépendent d'aucune base et se prouvent donc seules :
//
//   1. D'OÙ VIENT LA DEMANDE — lue depuis `agent_jobs.channel` et
//      `trigger_context`, jamais tapée. C'est le seul endroit où ces colonnes
//      deviennent un mot ; la page ne connaît pas la liste des canaux.
//   2. L'ORDRE DES APPELS d'un run — les appels d'outils et les appels de
//      modèle sont deux tables ; le run les lit comme UNE suite de temps.
//
// Le fil de conversation a sa propre phrase de provenance (`originLabel` dans
// `spaces/format.ts`, « via automation “Veille” ») : elle se lit dans une
// phrase, pas dans une colonne de tableau. Les deux vocabulaires sont
// délibérément distincts, et chacun dit pourquoi.

import { LIVE_JOB_STATUSES } from '@nodal-agents/shared';
import type { JobTriggerContext } from '@nodal-agents/db';

export type RunOriginInput = {
  channel: string;
  triggerContext: JobTriggerContext | null;
  /** Non-null quand le run appartient à une conversation du tableau de bord. */
  conversationId: string | null;
};

export type RunOrigin = {
  /** Le mot lu dans la colonne : « Telegram », « Automation », « Chat »… */
  label: string;
  /** Ce qui le précise quand la provenance en dit plus : le nom de la routine. */
  detail: string | null;
};

/**
 * Le mot que l'utilisateur lit pour un canal. EXPORTÉ depuis #135 : le menu
 * Chat de la barre latérale nomme ses dossiers ici même, et deux tables de
 * libellés auraient fini par diverger — « WhatsApp » d'un côté, « Whatsapp » de
 * l'autre, sur le même écran.
 */
export const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  mcp: 'MCP',
  internal: 'Agent',
  'task-board': 'Task board',
};

/**
 * D'où vient la demande. Un canal inconnu se rend TEL QUEL plutôt que rangé
 * dans « other » : un canal ajouté demain doit s'afficher, pas disparaître.
 */
export function originOfRun(input: RunOriginInput): RunOrigin {
  const ctx = input.triggerContext;
  if (input.channel === 'cron' || ctx?.type === 'cron') {
    return { label: 'Automation', detail: ctx?.type === 'cron' ? ctx.scheduleName : null };
  }
  if (input.channel === 'webhook' || ctx?.type === 'webhook') {
    return { label: 'Webhook', detail: ctx?.type === 'webhook' ? ctx.webhookName : null };
  }
  const known = CHANNEL_LABELS[input.channel];
  if (known !== undefined) return { label: known, detail: null };
  if (input.channel === 'api' || input.channel === 'dashboard') {
    // Le même canal sert la boîte de dialogue « New task » et un tour de chat :
    // ce qui les sépare est la conversation, pas le canal.
    return { label: input.conversationId === null ? 'Dashboard' : 'Chat', detail: null };
  }
  return { label: input.channel, detail: null };
}

// ─── L'ordre des appels d'un run ──────────────────────────────────────────────

/** Ce qu'une ligne d'appel a besoin d'être pour être rangée dans le temps. */
export type Timed = { id: string; createdAt: Date | null };

/**
 * Les appels d'un run, du plus ancien au plus récent, les deux tables
 * entrelacées.
 *
 * Une date absente (colonne par défaut non retournée par un driver, ligne
 * ancienne) se range à la FIN, jamais au début : un appel dont on ne sait pas
 * quand il a eu lieu ne doit pas se faire passer pour le premier geste du run.
 * À date égale, l'id tranche — sans quoi deux appels écrits dans la même
 * milliseconde changeraient de place d'un chargement à l'autre.
 */
export function inTimeOrder<T extends Timed>(calls: readonly T[]): T[] {
  return [...calls].sort((a, b) => {
    const ta = a.createdAt === null ? Number.POSITIVE_INFINITY : a.createdAt.getTime();
    const tb = b.createdAt === null ? Number.POSITIVE_INFINITY : b.createdAt.getTime();
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Un run qui tourne encore : sa ligne dépliée reçoit de nouveaux appels.
 *
 * La liste des statuts vivants est celle du produit (`LIVE_JOB_STATUSES`), pas
 * une seconde énumération : un statut ajouté là-bas doit rafraîchir ici sans
 * que personne n'y pense. `null` est vivant — une ligne sans statut est une
 * ligne qui vient de naître.
 */
export function runIsLive(status: string | null): boolean {
  if (status === null) return true;
  return (LIVE_JOB_STATUSES as readonly string[]).includes(status);
}
