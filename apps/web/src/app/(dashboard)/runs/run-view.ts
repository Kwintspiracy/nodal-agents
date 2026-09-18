// run-view.ts — ce que la PAGE D'UN RUN lit dans les données du chargeur.
//
// Un run n'est pas une conversation : c'est un TABLEAU DE BORD qu'on vient
// suivre (décision Quentin, 18/09/2026). La page garde donc l'ordre linéaire du
// détail Code — l'en-tête et ses chiffres, la réponse, la livraison, la revue,
// la preuve, l'activité — mais dessinée avec les codes graphiques du fil (#135).
//
// Tout ce qui est CALCUL vit ici, pur et testable : l'écran ne fait que
// dessiner. Chaque valeur vient de la donnée ou vaut « — » : un chiffre inventé
// (un 0 qui voudrait dire « rien », une durée devinée) serait pire que son
// absence (invariant #4).

import type { SpaceConversationView } from '@/lib/actions.ts';
import type { StatusVariant } from '@/components/ui/StatusPill';
import { normalizeText, type ConversationFeed, type FeedItem } from '@/lib/conversation-feed.ts';
import { readsAsReply } from '@/lib/conversation-thread.ts';
import { threadAgents } from '@/app/(dashboard)/spaces/format.ts';
import { formatMs, formatTokens } from '@/app/(dashboard)/spaces/format.ts';
import { relativeTime } from '@/lib/format-time';

/** Ce que la page écrit là où la donnée ne dit rien. */
export const UNKNOWN = '—';

type RunJob = SpaceConversationView['job'];

/** Les statuts sans suite : le run ne bougera plus. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** true tant que le run peut encore écrire quelque chose. */
export function runIsLive(status: string | null): boolean {
  return !TERMINAL.has(status ?? '');
}

/**
 * L'état du run, dit d'un mot. Le mot vient du statut en base et de lui seul :
 * un statut que cette table ne connaît pas s'écrit tel quel, plutôt que de se
 * faire ranger d'office dans « Idle » (invariant #4).
 */
const STATUS_LABEL: Record<string, string> = {
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  processing: 'Running',
  pending: 'Pending',
  awaiting_approval: 'Blocked',
  awaiting_delegation: 'Waiting',
};

export function runStatus(status: string | null): { variant: StatusVariant; label: string } {
  const key = status ?? 'pending';
  const label = STATUS_LABEL[key] ?? key;
  if (key === 'completed') return { variant: 'done', label };
  if (key === 'failed' || key === 'cancelled') return { variant: 'warn', label };
  if (key === 'processing' || key === 'pending' || key.startsWith('awaiting')) {
    return { variant: 'run', label };
  }
  return { variant: 'idle', label };
}

// ─── L'en-tête : origine, modèle, chiffres ──────────────────────────────────

/**
 * D'OÙ vient ce run, en une ligne — la provenance que la maquette pose en texte
 * nu, jamais en pastille grise (Quentin, 18/09 : l'origine et le modèle se
 * lisent comme l'heure d'un tour, pas comme un état).
 *
 * Une automatisation dit sa routine, une délégation dit qu'elle en est une, et
 * le reste dit son canal avec les mots du fil (`originLabel`). Le NOM de
 * l'agent qui a délégué n'est pas dans ces données : la page dit « delegated »
 * et pose le lien vers le run parent, plutôt que d'inventer un nom.
 */
export function runOrigin(job: Pick<RunJob, 'channel' | 'scheduleName' | 'parentJobId'>): string {
  if (job.channel === 'cron') {
    return job.scheduleName !== null && job.scheduleName !== ''
      ? `scheduled · ${job.scheduleName}`
      : 'scheduled';
  }
  if (job.parentJobId !== null && job.parentJobId !== '') return 'delegated';
  if (job.channel === 'api' || job.channel === 'dashboard') return 'from the dashboard';
  if (job.channel === 'internal') return 'from another agent';
  if (job.channel === 'task-board') return 'from the task board';
  return `via ${job.channel.charAt(0).toUpperCase()}${job.channel.slice(1)}`;
}

/**
 * Le modèle qui a porté le run. Il vit sur les TOURS du fil (`llm_calls`), et
 * les totaux du fil en gardent la liste : on prend celui du premier tour qui en
 * nomme un, sinon le premier des totaux. Aucun des deux ⇒ `null`, et l'écran ne
 * dessine rien — pas de tiret là où il n'y a pas de place pour un modèle.
 */
export function runModel(feed: ConversationFeed): string | null {
  const named = (items: readonly FeedItem[]): string | null => {
    for (const item of items) {
      if (item.kind === 'turn' && item.model !== null && item.model !== '') return item.model;
      if (item.kind === 'run') {
        const inside = named(item.items);
        if (inside !== null) return inside;
      }
    }
    return null;
  };
  return named(feed.items) ?? feed.totals.models[0] ?? null;
}

/**
 * Les fichiers DISTINCTS que le run a écrits, lus sur les cartes `files` du
 * fil. `null` quand aucune carte `files` n'existe : le run n'a peut-être pas
 * touché de fichier, ou son outil n'en a pas rendu compte — « 0 » trancherait
 * entre les deux sans le savoir.
 *
 * Un fichier seulement LU (`listed`) ne compte pas : « fichiers changés » veut
 * dire écrits.
 */
export function runFilesChanged(items: readonly FeedItem[]): number | null {
  const paths = new Set<string>();
  let sawCard = false;
  const walk = (list: readonly FeedItem[]): void => {
    for (const item of list) {
      if (item.kind === 'run') {
        walk(item.items);
        continue;
      }
      if (item.kind === 'child') {
        if (item.job.feed) walk(item.job.feed.items);
        continue;
      }
      if (item.kind !== 'turn') continue;
      for (const block of item.blocks) {
        const steps =
          block.kind === 'card' ? [block.step] : block.kind === 'steps' ? block.steps : [];
        for (const step of steps) {
          if (step.kind !== 'tool') continue;
          const payload = step.presented;
          if (payload === null || payload.card !== 'files') continue;
          sawCard = true;
          for (const f of payload.files) {
            if (f.action !== 'listed') paths.add(f.path);
          }
        }
      }
    }
  };
  walk(items);
  return sawCard ? paths.size : null;
}

/** Quand le run a bougé pour la dernière fois — sa fin, sinon son dernier tour daté, sinon son début. */
export function runLastActivity(data: SpaceConversationView): Date | null {
  if (data.job.completedAt !== null) return data.job.completedAt;
  let last: Date | null = null;
  const walk = (list: readonly FeedItem[]): void => {
    for (const item of list) {
      if (item.kind === 'run') walk(item.items);
      else if (item.kind === 'turn' && item.at !== null) {
        if (last === null || item.at.getTime() > last.getTime()) last = item.at;
      }
    }
  };
  walk(data.feed.items);
  return last ?? data.job.createdAt;
}

export type RunStat = { label: string; value: string };

/**
 * Les sept cases de l'en-tête — les MÊMES que le détail Code, dans le même
 * ordre et avec les mêmes mots : deux écrans qui montrent le même run ne
 * peuvent pas nommer ses chiffres différemment.
 *
 * « — » veut dire ABSENT, et rien d'autre. Un vrai zéro s'écrit `0` : un run
 * qui n'a appelé aucun modèle a bien consommé zéro jeton, et l'écrire « — »
 * le faisait passer pour une donnée manquante (Reviewer C, passe 1). Les deux
 * seules valeurs qui peuvent vraiment manquer ici sont le coût (aucun appel
 * tarifé : `null`, et un coût inconnu n'est pas un coût nul) et la durée (le
 * travail n'a pas de date de début, donc rien à mesurer).
 */
export function runStats(data: SpaceConversationView): RunStat[] {
  const t = data.cost.totals;
  const files = runFilesChanged(data.feed.items);
  // `durationMs` vaut 0 dans DEUX cas que la somme ne distingue pas : aucun
  // début connu, et un travail qui vient de commencer. C'est la date de début
  // qui tranche, et elle seule.
  const measured = data.job.createdAt !== null;
  return [
    { label: 'Cost', value: t.costUsd === null ? UNKNOWN : `$${t.costUsd.toFixed(2)}` },
    { label: 'Duration', value: measured ? formatMs(t.durationMs) : UNKNOWN },
    { label: 'Input tokens', value: formatTokens(t.inputTokens) },
    { label: 'Output tokens', value: formatTokens(t.outputTokens) },
    { label: 'Cache reads', value: formatTokens(t.cachedTokens) },
    { label: 'Files changed', value: files === null ? UNKNOWN : String(files) },
    { label: 'Activity', value: relativeTime(runLastActivity(data)) },
  ];
}

// ─── La réponse, sortie de la chronologie ───────────────────────────────────

/**
 * LA DEMANDE, retirée de la chronologie — elle est déjà en haut de la page.
 *
 * Le fil d'un run s'ouvre sur un item `request` qui porte la consigne du job
 * (`buildConversationFeed` le pose depuis le message `user` égal à la tâche).
 * La carte de tête montre cette même consigne, en entier : la laisser aussi en
 * première ligne de la chronologie, c'est lire deux fois la même phrase à trois
 * centimètres d'écart (Quentin, 18/09).
 *
 * Retirée SEULEMENT si elle répète la tâche. Une demande qui dit autre chose —
 * un fil de canal dont la frontière n'a pas été trouvée, par exemple — est une
 * information que la carte de tête ne porte pas : elle reste. Le fil d'une
 * conversation, lui, ne change pas : là, la demande est le tour de la personne.
 */
export function dropTaskRequest(items: readonly FeedItem[], task: string): FeedItem[] {
  const at = items.findIndex((i) => i.kind === 'request');
  const request = at >= 0 ? items[at] : undefined;
  if (request === undefined || request.kind !== 'request') return [...items];
  if (normalizeText(request.text) !== normalizeText(task)) return [...items];
  const out = [...items];
  out.splice(at, 1);
  return out;
}

/**
 * LA RÉPONSE du run, sortie du fil pour être lue sans rien déplier.
 *
 * C'est la règle que `conversation-thread.ts` applique déjà au fil d'une
 * conversation (`answerOutsideTheRun`), appliquée ici au fil d'UN run — et le
 * verdict « est-ce que le résultat se lit comme une réponse ? » est celui-là
 * même (`readsAsReply`, importé, jamais recopié) :
 *
 *   - le fil porte déjà un item `answer` (l'agent a fini sans un mot) ⇒ c'est
 *     lui, et il quitte la chronologie ;
 *   - le run a ÉCHOUÉ ⇒ rien n'est sorti : sa dernière phrase n'est pas une
 *     réponse, et la carte d'échec dit ce qui s'est passé ;
 *   - `agent_jobs.result` se lit comme une réponse ⇒ c'est lui (la prose reste
 *     dans la chronologie, où elle a eu lieu) ;
 *   - sinon la DERNIÈRE prose du DERNIER tour sort, et son tour la perd.
 *
 * Tant que le run court, RIEN ne sort : sa dernière phrase est une étape, pas
 * une fin (invariant #4). La garde passe donc avant tout le reste, l'item
 * `answer` compris (Reviewer C, passe 1 : elle venait après, et une réponse
 * aurait quitté la chronologie d'un run encore en cours).
 *
 * Un tel item peut-il exister sur un run vivant ? Non aujourd'hui :
 * `buildConversationFeed` ne pose `answer` que sur un job `completed`. La
 * garde ne change donc rien à ce qui s'affiche — elle dit la règle dans le
 * code plutôt que de la faire dépendre d'un autre module.
 *
 * UN RUN RELU N'A PAS DE RÉPONSE EN HAUT (Quentin, 18/09, après mesure).
 * ---------------------------------------------------------------------
 * Un run dont la relecture a été déléguée rendait DEUX fois la même chose :
 * l'orchestrateur reprenait le rapport de son relecteur dans sa réponse
 * finale, et la page l'affichait en prose sous l'en-tête, puis en structure
 * dans le bloc Review.
 *
 * La première règle comparait les deux textes et effaçait la réponse quand
 * elle CONTENAIT le rapport. Elle est morte à la mesure : sur le run
 * `94bc9dfb…`, la réponse et le rapport du délégué divergent dès le caractère
 * 341 sur 5 835 après normalisation des blancs (l'orchestrateur avait retiré
 * les séparateurs `---`, et d'autres écarts suivent) ; l'inclusion échoue même
 * en ne gardant que lettres et chiffres. Un modèle qui recopie « tel quel » ne
 * recopie jamais octet pour octet, et un seuil de similarité serait une
 * heuristique — donc une invention (invariant #4).
 *
 * La règle est désormais un FAIT, pas une comparaison : dès que le run porte
 * au moins un verdict de relecture enregistré — le sien ou celui d'un délégué
 * —, le bloc Review EST la réponse de ce run, et rien ne sort sous l'en-tête.
 * L'item `answer` quitte quand même la chronologie : il y serait un doublon de
 * plus.
 *
 * Le compromis est assumé : sur un run de code relu par un délégué, la phrase
 * finale de l'agent ne se lit plus en haut. Ce que le run a donné se lit dans
 * Review, dans Delivered et dans Files, et la chronologie garde tout — la
 * prose reste dans son tour, elle n'est pas sortie pour être jetée.
 */
export function liftReply(
  items: readonly FeedItem[],
  job: Pick<RunJob, 'completedAt'> & { result?: string | null },
  /**
   * Le run porte-t-il au moins UN verdict de relecture enregistré — le sien ou
   * celui d'un délégué ? Alors le bloc Review EST la réponse de ce run, et
   * rien ne sort sous l'en-tête (voir la règle ci-dessus).
   */
  hasReview = false,
): { reply: string | null; items: FeedItem[] } {
  const out = [...items];
  if (job.completedAt === null) return { reply: null, items: out };
  const answerAt = out.findIndex((i) => i.kind === 'answer');
  if (answerAt >= 0) {
    const answer = out[answerAt];
    out.splice(answerAt, 1);
    return { reply: hasReview ? null : answer?.kind === 'answer' ? answer.text : null, items: out };
  }
  // Relu ⇒ rien d'autre ne sort, et la chronologie garde tout : la prose du
  // dernier tour reste DANS son tour. La sortir pour ne pas l'afficher aurait
  // fait disparaître le texte des deux endroits.
  if (hasReview) return { reply: null, items: out };
  if (out.some((i) => i.kind === 'failure')) return { reply: null, items: out };

  const result = job.result?.trim() ?? '';
  const turnAt = out.map((i) => i.kind).lastIndexOf('turn');
  const turn = turnAt >= 0 ? out[turnAt] : undefined;
  const proseAt =
    turn !== undefined && turn.kind === 'turn'
      ? turn.blocks.map((b) => b.kind).lastIndexOf('prose')
      : -1;
  const block = turn !== undefined && turn.kind === 'turn' ? turn.blocks[proseAt] : undefined;
  const lastProse = block !== undefined && block.kind === 'prose' ? block : null;

  if (result !== '' && readsAsReply(result, lastProse?.text ?? null)) {
    return { reply: job.result ?? '', items: out };
  }
  if (lastProse === null || turn === undefined || turn.kind !== 'turn') {
    return { reply: null, items: out };
  }
  const rest = turn.blocks.filter((_, i) => i !== proseAt);
  // Un tour vidé de sa prose et sans appel de modèle n'a plus rien à montrer.
  if (rest.length === 0 && turn.usage === null) out.splice(turnAt, 1);
  else out[turnAt] = { ...turn, blocks: rest };
  return { reply: lastProse.text, items: out };
}

/**
 * Le récapitulatif de livraison, sorti de la chronologie lui aussi : la
 * maquette le pose juste sous la réponse, parce que c'est ce qui a été LIVRÉ.
 * Le fil d'un run n'en porte pas aujourd'hui (`buildConversationFeed` ne pose
 * pas d'item `produced` — seul un fil de conversation le fait) : la page n'en
 * dessine alors aucun, plutôt qu'un cadre vide.
 */
export function liftDelivered(items: readonly FeedItem[]): {
  delivered: Extract<FeedItem, { kind: 'produced' }> | null;
  items: FeedItem[];
} {
  const out = [...items];
  const at = out.findIndex((i) => i.kind === 'produced');
  if (at < 0) return { delivered: null, items: out };
  const item = out[at];
  out.splice(at, 1);
  return { delivered: item?.kind === 'produced' ? item : null, items: out };
}

// ─── L'activité ─────────────────────────────────────────────────────────────

export type ActivitySummary = {
  /** Les blocs que la chronologie montre, une fois la réponse et la livraison sorties. */
  steps: number;
  /** Les agents DISTINCTS qui y ont travaillé. */
  agents: number;
  /** Du début à la fin du run ; null tant qu'il court. */
  durationMs: number | null;
};

export function activitySummary(
  items: readonly FeedItem[],
  job: Pick<RunJob, 'createdAt' | 'completedAt'>,
): ActivitySummary {
  return {
    steps: items.length,
    agents: threadAgents(items).length,
    durationMs:
      job.createdAt !== null && job.completedAt !== null
        ? job.completedAt.getTime() - job.createdAt.getTime()
        : null,
  };
}

/**
 * Ce que la ligne d'Activity dit d'elle-même : « 9 steps · 3 agents · 41 s ».
 * Un compte nul ne s'écrit pas — « 0 agents » est du bruit, pas un fait.
 */
export function activityLabel(summary: ActivitySummary): string {
  const parts: string[] = [`${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'}`];
  if (summary.agents > 0) {
    parts.push(`${summary.agents} ${summary.agents === 1 ? 'agent' : 'agents'}`);
  }
  if (summary.durationMs !== null && summary.durationMs > 0)
    parts.push(formatMs(summary.durationMs));
  return parts.join(' · ');
}

// ─── Tout ce que la page dessine, en une lecture ────────────────────────────

export type RunView = {
  stats: RunStat[];
  origin: string;
  model: string | null;
  status: { variant: StatusVariant; label: string };
  reply: string | null;
  delivered: Extract<FeedItem, { kind: 'produced' }> | null;
  /** La chronologie, moins ce qui en a été sorti au-dessus. */
  timeline: FeedItem[];
  activity: ActivitySummary;
  live: boolean;
};

export function runView(data: SpaceConversationView): RunView {
  // Dans l'ordre : la demande s'en va (elle titre la page), puis la réponse et
  // le récapitulatif montent au-dessus de la chronologie.
  // Un run RELU n'a pas de réponse en haut : le bloc Review est sa réponse
  // (Quentin, 18/09). Un verdict enregistré suffit à le dire — le sien ou celui
  // d'un délégué.
  const lifted = liftReply(
    dropTaskRequest(data.feed.items, data.job.task),
    data.job,
    data.verdicts.length > 0,
  );
  const { delivered, items } = liftDelivered(lifted.items);
  return {
    stats: runStats(data),
    origin: runOrigin(data.job),
    model: runModel(data.feed),
    status: runStatus(data.job.status),
    reply: lifted.reply,
    delivered,
    timeline: items,
    activity: activitySummary(items, data.job),
    live: runIsLive(data.job.status),
  };
}
