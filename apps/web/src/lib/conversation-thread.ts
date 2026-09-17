// conversation-thread.ts — LE FIL D'UNE CONVERSATION (plan « De la maquette au
// produit », P7).
//
// P2 a donné le fil d'UN travail. Une conversation en contient plusieurs, et
// parfois aucun : sur le dashboard, un tour peut n'être qu'un échange de
// phrases, sans job. Ce module colle les deux dans une seule suite d'items —
// la même que `ConversationFeedView` dessine déjà, ce qui est tout l'intérêt :
// un fil Telegram et un fil du dashboard se lisent avec le même code.
//
// Pur, comme P2 : des fils de jobs DÉJÀ construits et des lignes déjà lues,
// aucune requête. Ce que ce module met en plus, c'est l'ORDRE et des items que
// le job seul ne peut pas connaître :
//
//   produced — ce qui est sorti du chat à ce tour, et le projet où il vit ; le
//              verdict vient de `chat-or-work.ts`, sur les lignes du job ET de
//              ses descendants.
//   handoff  — la consigne que le chat a passée au travail. La demande de
//              l'utilisateur est déjà au-dessus, écrite de sa main ; la
//              reformulation de l'agent la répéterait. Elle est gardée quand
//              même, repliée, parce qu'elle dit ce que le travail a VRAIMENT
//              reçu — c'est souvent là qu'un malentendu se voit.
//   note     — ce que le fil ne peut PAS dire : des tours plus anciens que le
//              plafond, ou une activité d'avant les cartes qui ne se classe
//              pas. Dit, jamais tu.
//
// Ce qui est RETIRÉ, et pourquoi : les items `history` des jobs. Le runner
// préfixe l'historique du fil au transcript pour que l'agent s'en souvienne
// (thread-history.ts) ; dans un fil de CONVERSATION, ces tours sont déjà
// au-dessus. Les garder afficherait deux fois la même chose.

import {
  compactTurns,
  normalizeText,
  type ConversationFeed,
  type DeliveryReview,
  type DeliverySummary,
  type FeedItem,
  type FeedTotals,
  type Origin,
} from './conversation-feed.ts';
import { canonicalChangePath, lineCountsOfCall, sumLineCounts } from './coding-changes.ts';
import { callHappened, outcomeOfToolOutput, parsePresented } from './tool-card-payload.ts';
import type { ProductionVerdict } from './chat-or-work.ts';

export type ThreadProject = { id: string; name: string; path: string };

export type ThreadConversation = {
  id: string;
  channel: string;
  chatId: string | null;
  title: string;
  agentName: string | null;
  agentSlug: string | null;
  /** L'image de l'agent de la conversation, quand il en a une. */
  agentAvatarUrl: string | null;
  currentProject: ThreadProject | null;
};

/** Un tour du dashboard : `chat_messages`. Vide pour une conversation de canal. */
export type ThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Le travail que ce tour a déclenché, s'il en a déclenché un. */
  jobId: string | null;
  createdAt: Date | null;
};

/** Une commande de preuve d'un job (ou d'un de ses délégués) et son verdict. */
export type ThreadProofRun = { command: string; verdict: string };

/** Un job de TÊTE de la conversation, avec son fil P2 déjà assemblé. */
export type ThreadJob = {
  jobId: string;
  feed: ConversationFeed;
  createdAt: Date | null;
  /** Quand le travail s'est refermé. null : il court encore. */
  completedAt: Date | null;
  verdict: ProductionVerdict;
  project: ThreadProject | null;
  /**
   * Les commandes de preuve de CE travail et de ses délégués, dans l'ordre.
   * `[]` quand aucune preuve n'a tourné — et le récapitulatif de livraison
   * n'affiche alors ni « Tests » ni « Checks », plutôt que « 0 / 0 ».
   */
  proof: readonly ThreadProofRun[];
  /**
   * Les lignes d'audit (`tool_calls`) de CE travail et de TOUTE sa
   * descendance, dans l'ordre. C'est de là que le récapitulatif compte les
   * fichiers écrits et les lignes — pas du fil, qui n'assemble qu'un niveau
   * de délégués et vingt fils au plus : un total lu sur le fil était partiel
   * sans le dire (revue Codex, passe 56).
   */
  audit: readonly ThreadAuditRow[];
  /**
   * Les racines des dossiers de travail de l'entité : un chemin absolu d'une
   * carte (`file_write` présente le chemin résolu) se ramène au relatif avant
   * d'être compté, et le même fichier sous deux orthographes compte une fois
   * — par égalité, pas par suffixe (revue Codex, passe 57).
   */
  workspaceRoots: readonly string[];
};

/** Une ligne d'audit, réduite à ce que le récapitulatif en lit. */
export type ThreadAuditRow = {
  toolName: string;
  toolInput: unknown;
  toolOutput: string | null;
  presented: unknown;
};

/** Ce que le fil dit quand le travail d'un tour n'existe plus en base. */
export const JOB_GONE_NOTE = '(job no longer available)';

/**
 * Ce que le fil dit d'un tour dont les lignes d'audit sont d'avant les cartes
 * (P1) : on ne peut RIEN affirmer de ce qu'il a produit. Un encart « Produced »
 * serait une invention, un silence serait un « rien produit » tout aussi
 * inventé (revue Codex, passe 29, doute 5).
 */
export const UNCLASSIFIED_NOTE =
  'Older activity in this turn cannot be classified (recorded before cards existed).';

/** Ce que le fil dit quand il ne montre que la FIN de la conversation. */
export function olderTurnsNote(shown: number): string {
  return `Older turns are not shown (${shown} shown).`;
}

function withoutHistory(items: readonly FeedItem[]): FeedItem[] {
  return items.filter((i) => i.kind !== 'history');
}

/**
 * Les items d'un job, tels qu'ils entrent dans un fil de conversation : sans
 * l'historique, et — sur le dashboard — avec la demande convertie en consigne
 * repliée. Sur un canal, la demande EST le message de l'utilisateur : elle
 * reste une demande.
 */
function jobItems(job: ThreadJob, asHandoff: boolean): FeedItem[] {
  const items = withoutHistory(job.feed.items);
  if (!asHandoff) return items;
  return items.map((i) => (i.kind === 'request' ? { kind: 'handoff' as const, text: i.text } : i));
}

/**
 * Ce que le travail a touché, relu, et prouvé — la matière du récapitulatif de
 * livraison (P2bis).
 *
 * Le fil du job porte déjà tout : ses cartes `files` disent les fichiers, ses
 * cartes `checks` et ses délégués disent les relectures. On les ramasse ici,
 * une fois, plutôt que de laisser l'écran refaire ce parcours à chaque rendu —
 * et surtout pour qu'un test puisse EXIGER qu'un travail sans preuve n'ait ni
 * « Tests » ni « Checks ».
 *
 * Les fichiers seulement LUS (`listed`) ne comptent pas : « 12 fichiers » sous
 * un récapitulatif de livraison veut dire douze fichiers livrés, pas douze
 * fichiers regardés.
 */
function deliverySummary(job: ThreadJob): DeliverySummary {
  // Fichiers et lignes se comptent sur les LIGNES D'AUDIT de toute la
  // descendance (`job.audit`), jamais sur le fil : le fil n'assemble qu'un
  // niveau de délégués et vingt fils au plus, et un petit-enfant qui écrit
  // manquait au total. Une ligne dont l'appel n'a pas eu lieu (erreur,
  // blocage, attente d'approbation) ne compte pas ; une écriture sans ligne
  // d'audit n'existe pas ici.
  //
  // Les fichiers sont dédoublonnés sur leur chemin CANONIQUE (racine du
  // dossier retirée) : `file_write` présente le chemin absolu, `file_edit` le
  // chemin relatif, et le même fichier faisait « 2 files » (vu en vrai le
  // 07/09). Par égalité et non par suffixe : `index.ts` et `a/index.ts` sont
  // deux fichiers (revue Codex, passe 57).
  const files = new Set<string>();
  const addFile = (path: string): void => {
    files.add(canonicalChangePath(path, job.workspaceRoots));
  };
  const counted = job.audit
    .filter((row) => callHappened(outcomeOfToolOutput(row.toolOutput)))
    .map((row) => {
      const p = parsePresented(row.presented);
      if (p !== null && p.card === 'files') {
        for (const f of p.files) if (f.action !== 'listed') addFile(f.path);
      }
      return lineCountsOfCall(row.toolName, row.toolInput, row.toolOutput);
    });
  const reviews: DeliveryReview[] = [];

  const walk = (items: readonly FeedItem[], depth: number): void => {
    for (const item of items) {
      if (item.kind === 'turn') {
        for (const block of item.blocks) {
          if (block.kind !== 'card') continue;
          const p = block.step.presented;
          if (p === null) continue;
          if (p.card === 'checks' && depth === 0) {
            // Les verdicts de revue du job LUI-MÊME. Ceux d'un délégué sont
            // déjà résumés par la ligne du délégué : les lister deux fois
            // gonflerait la section « Reviews » sans rien ajouter.
            reviews.push({
              name: block.step.toolName,
              text: p.summary,
              ok: p.verdict === 'pass',
              isAgent: false,
              avatarUrl: null,
            });
          }
        }
      } else if (item.kind === 'child') {
        reviews.push({
          name: item.job.agentName ?? 'an agent',
          text: item.job.result ?? item.job.task ?? '',
          ok: item.job.status === 'completed',
          isAgent: true,
          // L'image du délégué voyage déjà dans la ligne du fil : le pied du
          // récapitulatif montre le VISAGE de qui a relu, pas deux initiales
          // quand l'agent a une image (#135).
          avatarUrl: item.job.agentAvatarUrl ?? null,
        });
        if (item.job.feed) walk(item.job.feed.items, depth + 1);
      }
    }
  };
  walk(job.feed.items, 0);

  const passed = job.proof.filter((r) => r.verdict === 'green').length;
  const lines = sumLineCounts(counted);
  // Les chemins, dans l'ORDRE OÙ ILS ONT ÉTÉ ÉCRITS : un `Set` garde l'ordre
  // d'insertion, et les lignes d'audit arrivent déjà triées par date. Le compte
  // en est dérivé — il ne peut plus diverger de la liste (#135).
  const filePaths = [...files];
  return {
    files: filePaths.length,
    filePaths,
    lines: lines.added === 0 && lines.removed === 0 ? null : lines,
    tests: job.proof.length > 0 ? { passed, total: job.proof.length } : null,
    durationMs:
      job.completedAt !== null && job.createdAt !== null
        ? job.completedAt.getTime() - job.createdAt.getTime()
        : null,
    costUsd: job.feed.totals.costUsd,
    reviews,
    checks: job.proof.map((r) => ({ command: r.command, ok: r.verdict === 'green' })),
    // Un `infra_error` n'est pas un succès : tout ce qui n'est pas vert fait
    // « Checks failed ». La section « Checks » montre laquelle a lâché.
    verdict: job.proof.length === 0 ? null : passed === job.proof.length ? 'green' : 'red',
  };
}

/**
 * Ce qui suit les items d'un job : l'encart quand il a produit, sinon l'aveu
 * d'ignorance quand ses lignes ne se classent pas. Jamais les deux — l'encart
 * porte déjà son propre compte d'incertitude.
 */
function afterJobItems(job: ThreadJob): FeedItem[] {
  if (job.verdict.isWork) {
    return [
      {
        kind: 'produced',
        jobId: job.jobId,
        verdict: job.verdict,
        project: job.project,
        summary: deliverySummary(job),
      },
    ];
  }
  if (job.verdict.unclassified > 0)
    return [{ kind: 'note', text: UNCLASSIFIED_NOTE, origin: 'thread' }];
  return [];
}

/** La somme des totaux des jobs — un tour de pure conversation n'en a pas. */
function sumTotals(jobs: readonly ThreadJob[]): FeedTotals {
  const models = new Set<string>();
  const totals: FeedTotals = {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    llmDurationMs: 0,
    models: [],
  };
  for (const job of jobs) {
    const t = job.feed.totals;
    totals.turns += t.turns;
    totals.toolCalls += t.toolCalls;
    totals.inputTokens += t.inputTokens;
    totals.outputTokens += t.outputTokens;
    totals.cachedTokens += t.cachedTokens;
    totals.cacheCreationTokens += t.cacheCreationTokens;
    // null reste null tant qu'AUCUN job ne connaît son coût — jamais un 0 qui
    // voudrait dire « gratuit » (même règle que P2).
    if (t.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + t.costUsd;
    totals.llmDurationMs += t.llmDurationMs;
    for (const m of t.models) models.add(m);
  }
  totals.models = [...models];
  return totals;
}

/**
 * Ce que les plafonds ont laissé de côté. L'appelant ne charge que la FIN d'un
 * fil (les tours récents sont ceux qu'on vient lire) ; quand le plafond a
 * mordu, le fil le DIT en tête plutôt que de faire croire qu'il commence là.
 */
export type ThreadTruncation = { messages: boolean; jobs: boolean };

/**
 * Le bruit système, dit une fois (P2bis).
 *
 * Trois jobs anciens dans un même fil poussaient trois fois la même phrase
 * (« Older activity in this turn cannot be classified… »), sous chaque tour :
 * la capture de Quentin en montrait une colonne entière. L'aveu vaut pour LE
 * FIL, pas pour chaque job — il paraît après le premier job concerné, et plus
 * jamais. Deux notes consécutives de même texte fusionnent aussi : c'est la
 * même phrase, écrite deux fois.
 */
function dedupeNotes(items: readonly FeedItem[]): FeedItem[] {
  const out: FeedItem[] = [];
  let saidUnclassified = false;
  for (const item of items) {
    if (item.kind !== 'note') {
      out.push(item);
      continue;
    }
    if (item.text === UNCLASSIFIED_NOTE) {
      if (saidUnclassified) continue;
      saidUnclassified = true;
    }
    const prev = out[out.length - 1];
    if (prev?.kind === 'note' && normalizeText(prev.text) === normalizeText(item.text)) continue;
    out.push(item);
  }
  return out;
}

/** Ce que TOUT fil de conversation subit avant d'être rendu. */
function settle(items: readonly FeedItem[]): FeedItem[] {
  return compactTurns(dedupeNotes(items));
}

export function buildConversationThread(input: {
  conversation: ThreadConversation;
  /** Les tours du dashboard, chronologiques. `[]` pour une conversation de canal. */
  messages: readonly ThreadMessage[];
  /** Les jobs de TÊTE de la conversation, chronologiques. */
  jobs: readonly ThreadJob[];
  /** Les plafonds atteints, s'il y en a. Absent = le fil est entier. */
  truncated?: ThreadTruncation;
}): ConversationFeed {
  const { conversation, messages, jobs, truncated } = input;
  const items: FeedItem[] = [];

  // La coupe se dit EN TÊTE, avant tout item : c'est la première chose qu'un
  // lecteur doit savoir d'un fil qui ne commence pas à son début. Ce qu'on
  // COMPTE est ce qui fait un tour à l'écran — les messages sur le dashboard,
  // les jobs sur un canal.
  const isDashboard = conversation.channel === 'dashboard';
  const cut = isDashboard
    ? truncated?.messages === true || truncated?.jobs === true
    : truncated?.jobs === true;
  if (cut) {
    items.push({
      kind: 'note',
      text: olderTurnsNote(isDashboard ? messages.length : jobs.length),
      origin: 'thread',
    });
  }

  if (conversation.channel !== 'dashboard') {
    // Un fil de canal n'a pas de `chat_messages` : ses tours SONT ses jobs.
    for (const job of jobs) {
      items.push(...jobItems(job, false));
      items.push(...afterJobItems(job));
    }
    return { items: settle(items), totals: sumTotals(jobs) };
  }

  const byJobId = new Map(jobs.map((j) => [j.jobId, j]));
  const origin: Origin = { channel: 'dashboard', scheduleName: null, chatId: null };
  let turnIndex = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      items.push({ kind: 'request', text: message.content, origin, at: message.createdAt });
      continue;
    }

    // Un tour d'assistant du chat n'a pas de ligne d'audit : son compteur de
    // tour n'existe pas (`turn: 0`, `inferred`) et il ne porte NI modèle NI
    // jetons — le chat écrit `chat_messages`, pas `llm_calls.turn`. Les
    // inventer les attribuerait à un appel qu'on n'a pas lu.
    const text = message.content.trim();
    if (text !== '') {
      turnIndex += 1;
      items.push({
        kind: 'turn',
        index: turnIndex,
        turn: 0,
        turnSource: 'inferred',
        agent: {
          name: conversation.agentName,
          slug: conversation.agentSlug,
          avatarUrl: conversation.agentAvatarUrl,
        },
        model: null,
        blocks: [{ kind: 'prose', text: message.content }],
        usage: null,
        // Le message de chat, lui, EST daté : l'en-tête du tour montre l'heure
        // où l'agent a parlé (#135).
        at: message.createdAt,
      });
    }

    if (message.jobId === null) continue;
    const job = byJobId.get(message.jobId);
    if (!job) {
      // Le job a été purgé (pas de clé étrangère depuis `chat_messages.job_id`
      // vers un job vivant : la colonne est SET NULL, mais un job supprimé
      // avant P6 a pu laisser l'id). Le fil le dit plutôt que de sauter le tour.
      items.push({ kind: 'note', text: JOB_GONE_NOTE, origin: 'thread' });
      continue;
    }
    items.push(...jobItems(job, true));
    items.push(...afterJobItems(job));
  }

  return { items: settle(items), totals: sumTotals(jobs) };
}
