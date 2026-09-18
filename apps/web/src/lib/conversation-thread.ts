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
  type RunSummary,
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
  /**
   * Ce que le travail a RENDU (`agent_jobs.result`) : la chose livrée à la
   * personne, par le canal ou le dashboard. C'est elle que le fil montre hors
   * du groupe quand la dernière prose de l'agent n'est pas sa réponse.
   */
  result: string | null;
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
 * Ce que la ligne de résumé dit du run (#135, #132).
 *
 * Les outils et le coût se lisent sur les TOTAUX du job — la même source que
 * la barre d'état — plus ceux des délégués dont le fil est assemblé dans le
 * groupe, puisque le dépliage les montre.
 * Les délégations et les appels de modèle se comptent sur les items du GROUPE,
 * après le retrait de la réponse : la ligne promet ce que le dépliage montre,
 * et un tour dont la prose est sortie ne compte plus sa ligne de modèle deux
 * fois. La durée est celle du travail entier, pas celle du modèle : `null` tant
 * qu'il court (invariant #4 — on ne devine pas une fin).
 */
function runSummary(job: ThreadJob, work: readonly FeedItem[]): RunSummary {
  // Le travail d'un délégué dont le fil est assemblé DANS le groupe se déplie
  // avec lui : ses outils et son coût comptent dans la ligne, sinon elle
  // promettrait moins que ce que le dépliage montre (Reviewer C, passe 1).
  let tools = job.feed.totals.toolCalls;
  let costUsd = job.feed.totals.costUsd;
  for (const item of work) {
    if (item.kind !== 'child' || item.job.feed === undefined) continue;
    tools += item.job.feed.totals.toolCalls;
    const childCost = item.job.feed.totals.costUsd;
    if (childCost !== null) costUsd = (costUsd ?? 0) + childCost;
  }
  return {
    tools,
    delegations: work.filter((i) => i.kind === 'child').length,
    modelCalls: work.filter((i) => i.kind === 'turn' && i.usage !== null).length,
    durationMs:
      job.completedAt !== null && job.createdAt !== null
        ? job.completedAt.getTime() - job.createdAt.getTime()
        : null,
    costUsd,
  };
}

/**
 * La RÉPONSE d'un run qui n'a pas d'item `answer` — ce qu'on lit SANS déplier.
 *
 * `buildConversationFeed` ne pose `answer` que lorsque l'agent a fini SANS un
 * mot : quand il a parlé (une prose, ou une carte d'envoi qui livre un texte),
 * répéter `result` en plaque affichait deux fois le même texte dans un fil à
 * plat. Le tableau de #135 veut pourtant la réponse DEHORS, au-dessus de la
 * ligne de résumé — et Quentin (18/09) : « la réponse textuelle de l'agent est
 * invisible, elle est DANS le feed de tools qui est fermé ». Deux cas :
 *
 *   - la dernière prose du dernier tour EST ce que le travail a rendu (l'agent
 *     a fini par sa réponse) : on sort ce tour du groupe, avec son nom, son
 *     image et son heure — une plaque anonyme les perdrait. Une prose plus
 *     haut est intermédiaire (l'agent qui annonce ce qu'il va faire) et reste
 *     dans le groupe ;
 *   - elle ne l'est PAS (l'agent a publié sa réponse par une carte d'envoi puis
 *     rendu son résultat ; sa dernière phrase n'est qu'une annonce) : ce qu'on
 *     montre dehors est `result`, la chose livrée — jamais l'annonce. La prose
 *     et la carte restent dans le groupe, où le dépliage les montre.
 *
 * Sans `result` (un travail d'avant la colonne, ou qui n'a rien rendu), la
 * dernière prose sort, comme avant.
 *
 * Seulement sur un travail TERMINÉ (`completedAt`). Tant qu'il court, sa
 * dernière phrase n'est pas une réponse mais une étape ; la dessiner comme la
 * réponse serait inventer une fin (invariant #4).
 *
 * Le tour sorti ne porte NI jetons NI durée : sa ligne de modèle reste dans le
 * groupe, avec le travail qu'elle a payé.
 */
function answerOutsideTheRun(job: ThreadJob, work: FeedItem[]): FeedItem | null {
  if (job.completedAt === null) return null;
  const result = job.result?.trim() ?? '';
  const turnAt = work.map((i) => i.kind).lastIndexOf('turn');
  const turn = turnAt >= 0 ? work[turnAt] : undefined;
  const proseAt =
    turn !== undefined && turn.kind === 'turn'
      ? turn.blocks.map((b) => b.kind).lastIndexOf('prose')
      : -1;
  const prose = turn !== undefined && turn.kind === 'turn' ? turn.blocks[proseAt] : undefined;
  const lastProse = prose !== undefined && prose.kind === 'prose' ? prose : null;

  // `result` sort SEUL quand il se lit comme une réponse : pas un JSON rendu
  // par `return_result` pour une machine, pas une version tronquée de la prose
  // (Reviewer C, passe 1 : un résultat machine sorti brut cachait la vraie
  // réponse, repliée). Dans ces deux cas, la prose reste ce qu'on lit.
  // En vue DÉPLIÉE, la réponse sortie et la carte d'envoi qui porte le même
  // texte se voient toutes deux : c'est assumé — l'une est ce qui a été dit,
  // l'autre l'acte de l'envoyer.
  if (result !== '' && readsAsReply(result, lastProse?.text ?? null)) {
    return { kind: 'answer', text: job.result ?? '' };
  }
  if (lastProse === null || turn === undefined || turn.kind !== 'turn') return null;
  const rest = turn.blocks.filter((_, i) => i !== proseAt);
  // Un tour vidé de sa prose et sans appel de modèle n'a plus rien à montrer :
  // il disparaît du groupe plutôt que d'y laisser un en-tête d'agent seul.
  if (rest.length === 0 && turn.usage === null) work.splice(turnAt, 1);
  else work[turnAt] = { ...turn, blocks: rest };
  return { ...turn, blocks: [lastProse], usage: null };
}

/**
 * `result` se lit-il comme une réponse à la personne — plutôt que la dernière
 * prose de l'agent ? Non quand c'est du JSON (un `return_result` structuré,
 * pour une machine), non quand c'est la même phrase (la prose sort alors avec
 * son en-tête d'agent), non quand ce n'est qu'un début tronqué de la prose.
 */
function readsAsReply(result: string, lastProse: string | null): boolean {
  const first = result[0];
  if (first === '{' || first === '[') {
    try {
      JSON.parse(result);
      return false;
    } catch {
      // Pas du JSON : une phrase qui commence par une accolade se lit.
    }
  }
  if (lastProse === null) return true;
  const prose = lastProse.trim();
  if (prose === result) return false;
  return !(result.length < prose.length && prose.startsWith(result.replace(/[….]+$/, '')));
}

/**
 * Les items d'un job tels que le FIL les pose (#135, #132) : la demande, la
 * réponse, puis le travail replié sous sa ligne de résumé.
 *
 * Ce qui entre dans le groupe : les tours et les délégations. Ce qui reste
 * dehors, et pourquoi :
 *   - `request` / `handoff` — la demande précède le travail, elle n'en fait pas
 *     partie ;
 *   - `note` — le bruit système est dit UNE fois par fil (`dedupeNotes`), et
 *     cette règle ne peut pas voir ce qui est enfoui dans un groupe ;
 *   - `answer` / `failure` — ce que le run a rendu, la seule chose qu'on lit
 *     sans déplier ;
 *   - `produced` — le récapitulatif de livraison, posé par `afterJobItems`.
 *
 * Les tours sont compactés AVANT le groupe : `compactTurns` replie les tours
 * muets dans le précédent, et il ne verrait plus rien s'il ne tournait qu'au
 * niveau du fil, où le job n'est plus qu'un item.
 */
function jobThreadItems(job: ThreadJob, asHandoff: boolean): FeedItem[] {
  const own = compactTurns(jobItems(job, asHandoff));
  const lead: FeedItem[] = [];
  const notes: FeedItem[] = [];
  const work: FeedItem[] = [];
  let answer: FeedItem | null = null;
  let failure: FeedItem | null = null;
  for (const item of own) {
    if (item.kind === 'request' || item.kind === 'handoff') lead.push(item);
    else if (item.kind === 'note') notes.push(item);
    else if (item.kind === 'answer') answer = item;
    else if (item.kind === 'failure') failure = item;
    else work.push(item);
  }
  // Un travail qui a ÉCHOUÉ ne se relit pas par sa dernière phrase : ce qu'il a
  // rendu est son échec, et la carte est juste sous le groupe. Sortir sa
  // dernière prose la ferait passer pour une réponse.
  if (answer === null && failure === null) answer = answerOutsideTheRun(job, work);

  const first = work.find((i) => i.kind === 'turn');
  const out: FeedItem[] = [...lead, ...notes];
  if (answer !== null) out.push(answer);
  if (work.length > 0) {
    out.push({
      kind: 'run',
      jobId: job.jobId,
      agent: first?.kind === 'turn' ? first.agent : { name: null, slug: null, avatarUrl: null },
      model: first?.kind === 'turn' ? first.model : null,
      at: job.createdAt,
      summary: runSummary(job, work),
      items: work,
    });
  }
  if (failure !== null) out.push(failure);
  return out;
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
      items.push(...jobThreadItems(job, false));
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
    items.push(...jobThreadItems(job, true));
    items.push(...afterJobItems(job));
  }

  return { items: settle(items), totals: sumTotals(jobs) };
}
