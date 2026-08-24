// notify/code-transitions.ts — les transitions du pipeline code, notifiées au
// canal d'origine (punch list V1.1, pattern kanban_notify d'Hermes).
//
// Un utilisateur qui a lancé une tâche de code depuis Telegram ne voit RIEN
// entre son message et la réponse finale de l'orchestrateur — un code_task de
// dix minutes est un silence de dix minutes. Ce module envoie le strict
// condensé aux moments où le pipeline bascule : ✔/✖ quand un code_task se
// termine, 🔎 quand un verdict de review tombe. JAMAIS les sorties (diffs,
// logs) — elles vivent dans l'onglet Code. Le cas « ⏸ bloqué sur approbation »
// est déjà couvert par notifyApprovalCreated (la carte ✅/❌).
//
// Invariant #2 (le runner ne parle pas à la place du LLM) : même statut que
// les cartes d'approbation — c'est une surface SYSTÈME (état de la machine),
// pas une parole d'agent. Le texte le montre : factuel, une ligne, préfixé
// d'un glyphe d'état.
//
// Garde anti-spam : on ne notifie que si le job RACINE est né sur un canal de
// MESSAGERIE (telegram/whatsapp/slack/discord). Un job dashboard/api regarde
// l'onglet Code en live ; un cron a déjà sa livraison de fin
// (deliverCompletedRoots) ; les prévenir ici doublerait le signal.

import { getAdapter } from '@nodal-agents/delivery';
import { walkJobChainToRoot, resolveChannelApprovalDeliveryTarget } from '../approvals/notify.ts';
import type { RunnerDeps } from '../deps.ts';

/** Canaux dont l'humain est joignable par message proactif. */
const MESSAGING_CHANNELS = new Set(['telegram', 'whatsapp', 'slack', 'discord']);

export type CodeTransitionEvent =
  | { kind: 'code_task_done'; success: boolean; agentName: string | null }
  | { kind: 'review_verdict'; verdict: string; agentName: string | null };

/** Le condensé — une ligne, jamais de sortie d'outil. */
export function renderCodeTransition(event: CodeTransitionEvent): string {
  const who = event.agentName ? ` — ${event.agentName}` : '';
  if (event.kind === 'code_task_done') {
    return event.success ? `✔ Code task finished${who}` : `✖ Code task failed${who}`;
  }
  const label =
    event.verdict === 'approve'
      ? 'approved'
      : event.verdict === 'request_changes'
        ? 'changes requested'
        : event.verdict;
  return `🔎 Review: ${label}${who}`;
}

/**
 * Best-effort, comme notifyApprovalCreated : une notification qui échoue ne
 * doit jamais faire échouer le job — l'erreur va aux logs serveur, point.
 */
export async function notifyCodeTransition(
  db: RunnerDeps['db'],
  jobId: string,
  event: CodeTransitionEvent,
): Promise<void> {
  try {
    // Garde messagerie : le canal BRUT du job racine décide. On ne passe pas
    // par resolveTransportChannel ici — lui remappe cron/dashboard/api vers un
    // canal par défaut, ce qui est voulu pour une carte d'approbation
    // (bloquante) mais serait du spam pour un simple signal de progression.
    const chain = await walkJobChainToRoot(db, jobId);
    if (!chain) return;
    const rootChannel = chain[chain.length - 1]?.channel ?? null;
    if (!rootChannel || !MESSAGING_CHANNELS.has(rootChannel)) return;

    const target = await resolveChannelApprovalDeliveryTarget(db, jobId);
    if (!target) return;

    const adapter = getAdapter(target.channel);
    await adapter.sendText(target.credentials, target.conversationId, renderCodeTransition(event));
  } catch (err) {
    console.error(
      `[code-transitions] notification failed for job ${jobId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
