// automation-view.ts — ce que la PAGE D'UNE AUTOMATISATION écrit (#202).
//
// Tout ce qui est calcul vit ici, pur et testable ; l'écran ne fait que
// dessiner. Un schedule et un webhook se lisent sur le même gabarit — cinq
// lignes de réglages, un sous-titre d'une ligne, un compteur de runs — et c'est
// ce fichier qui sait ce qu'une de ces lignes porte dans un cas et dans l'autre.
//
// Chaque valeur vient de la donnée ou se tait : une heure devinée ou un coût
// nul mis là faute de mieux se lirait comme un fait (invariant #4).

import type { AutomationView } from '@/lib/actions.ts';
import { humanLabel } from '@/lib/cron.ts';
import { CHANNEL_LABELS } from '@/lib/activity-runs.ts';
import { formatDate } from '@/lib/format-time';
import { formatCost, formatMs } from '@/app/(dashboard)/spaces/format.ts';
import { runStatus } from '@/app/(dashboard)/runs/run-view.ts';

/** Une ligne de la carte de réglages : son libellé, sa valeur. */
export type Fact = { label: string; value: string };

/** Ce que la page écrit là où la donnée ne dit rien. */
const UNKNOWN = '—';

/** Le nom de l'automatisation, quel que soit son genre. */
export function automationName(view: AutomationView): string {
  return view.kind === 'schedule' ? view.schedule.name : view.webhook.name;
}

/** L'agent qui l'exécute. */
export function automationAgent(view: AutomationView): string {
  const name = view.kind === 'schedule' ? view.schedule.agentName : view.webhook.agentName;
  return name ?? UNKNOWN;
}

/** Le chemin que le service extérieur appelle. Le secret n'en fait pas partie :
 *  il n'est jamais relu depuis la base, et l'écrire ici serait le promettre. */
export function webhookPath(slug: string): string {
  return `POST /webhooks/${slug}`;
}

/**
 * Dans combien de temps, en un mot court : « in 2 h », « in 35 min »,
 * « in 3 d ». Une date déjà passée dit « due now » plutôt qu'un nombre
 * négatif — un cron en retard est en retard, pas dans « -4 h ».
 */
export function untilLabel(date: Date | string, now: Date = new Date()): string {
  const at = typeof date === 'string' ? new Date(date) : date;
  const secs = Math.round((at.getTime() - now.getTime()) / 1000);
  if (secs <= 0) return 'due now';
  if (secs < 60) return `in ${secs} s`;
  if (secs < 3600) return `in ${Math.round(secs / 60)} min`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)} h`;
  return `in ${Math.round(secs / 86400)} d`;
}

/**
 * La ligne sous le titre : ce que c'est, quand ça part, qui l'exécute, et ce
 * qui vient ensuite. Un morceau que la donnée ne porte pas disparaît de la
 * ligne au lieu d'y laisser un tiret.
 */
export function automationSubtitle(view: AutomationView, now: Date = new Date()): string {
  const parts: string[] = [];
  if (view.kind === 'schedule') {
    const s = view.schedule;
    parts.push('Schedule', humanLabel(s.cronExpr), automationAgent(view));
    if (!s.active) parts.push('paused');
    else if (s.nextRun) parts.push(`next run ${untilLabel(s.nextRun, now)}`);
  } else {
    const w = view.webhook;
    parts.push('Webhook', webhookPath(w.slug), automationAgent(view));
    parts.push(w.active ? 'on call' : 'paused');
  }
  return parts.join(' · ');
}

/** Le dernier run, tel qu'il se lit : date, verdict, durée, coût. */
function lastRunFact(view: AutomationView): string {
  const last = view.runs[0];
  if (last) {
    const bits = [formatDate(last.createdAt), runStatus(last.status).label];
    if (last.createdAt && last.completedAt) {
      bits.push(formatMs(last.completedAt.getTime() - last.createdAt.getTime()));
    }
    bits.push(formatCost(last.costUsd));
    return bits.join(' · ');
  }
  // Aucun run listé, mais la routine en a compté un : on dit ce qu'on sait
  // (la colonne de la routine), sans inventer la durée ni le coût qu'elle ne
  // porte pas.
  if (view.kind === 'schedule' && view.schedule.lastRun) {
    return [formatDate(view.schedule.lastRun), view.schedule.lastStatus ?? UNKNOWN].join(' · ');
  }
  if (view.kind === 'webhook' && view.webhook.lastTriggeredAt) {
    return formatDate(view.webhook.lastTriggeredAt);
  }
  return view.kind === 'schedule' ? 'Never run' : 'Never fired';
}

/** Comment la notification est réglée, en une phrase. */
function notifyFact(view: AutomationView): string {
  const on =
    view.kind === 'schedule' ? view.schedule.notifyOnSuccess : view.webhook.notifyOnSuccess;
  if (!on) return 'Off';
  const channel =
    view.kind === 'schedule' ? view.schedule.notifyChannel : view.webhook.notifyChannel;
  const where = channel === null ? 'First active channel' : (CHANNEL_LABELS[channel] ?? channel);
  return `${where} · on success`;
}

/** Ce qui la déclenche : l'heure d'un cron, ou l'adresse d'un webhook. */
function triggerFact(view: AutomationView, now: Date): string {
  if (view.kind === 'schedule') {
    const s = view.schedule;
    const bits = [humanLabel(s.cronExpr)];
    if (s.timezone) bits.push(s.timezone);
    if (s.nextRun) bits.push(`next run ${formatDate(s.nextRun)} (${untilLabel(s.nextRun, now)})`);
    else if (!s.active) bits.push('paused, no next run');
    return bits.join(' · ');
  }
  const w = view.webhook;
  const bits = [webhookPath(w.slug)];
  bits.push(w.hasSecret ? 'secret hidden, rotate to see a new URL' : 'no secret set');
  bits.push(`${w.triggerCount} ${w.triggerCount === 1 ? 'fire' : 'fires'}`);
  return bits.join(' · ');
}

/**
 * Les CINQ lignes de la carte de réglages, dans l'ordre de la planche B :
 * qui, quand, quoi, qui on prévient, ce qui s'est passé la dernière fois.
 */
export function automationFacts(view: AutomationView, now: Date = new Date()): Fact[] {
  const task = view.kind === 'schedule' ? view.schedule.task : view.webhook.taskTemplate;
  return [
    { label: 'Agent', value: automationAgent(view) },
    { label: 'Trigger', value: triggerFact(view, now) },
    { label: 'Task', value: task ?? 'No task set' },
    { label: 'Notify', value: notifyFact(view) },
    { label: 'Last run', value: lastRunFact(view) },
  ];
}

/** « RUNS · 12 · $0.51 over 30 days ». */
export function runsHeadline(view: AutomationView): string {
  const { runs, costUsd, days } = view.window;
  return `Runs · ${runs} · ${formatCost(costUsd)} over ${days} days`;
}

/**
 * Sous quelle route les lignes de runs ouvrent leur run. Un run
 * d'automatisation a sa page sous `/scheduled/<id>` ; un run de webhook n'en
 * passe pas par là et s'ouvre sous `/jobs/<id>`. Les deux rendent la même page
 * de run, par deux portes.
 */
export function runsBasePath(view: AutomationView): string {
  return view.kind === 'schedule' ? '/scheduled' : '/jobs';
}

/**
 * Où mène « See all ».
 *
 * Activity (`/logs`) ne filtre aujourd'hui que par agent, outil et run : elle
 * n'a AUCUN filtre par automatisation. Y renvoyer déposerait le lecteur sur la
 * liste entière de la flotte en lui promettant le contraire. Les runs d'une
 * routine se retrouvent donc sur `/scheduled`, où ils sont groupés par
 * automatisation ; ceux d'un webhook vivent dans Activity, filtrés par agent,
 * ce que cette page-là sait faire.
 */
export function seeAllHref(view: AutomationView): string {
  if (view.kind === 'schedule') return '/scheduled';
  const agentId = view.webhook.agentId;
  return agentId === null ? '/logs' : `/logs?agent=${agentId}`;
}

/** Ce que « See all » annonce, puisque les deux destinations diffèrent. */
export function seeAllLabel(view: AutomationView): string {
  return view.kind === 'schedule' ? 'See all in Scheduled' : 'See all in Activity';
}
