// LiveRunStrip — ce que le run fait EN CE MOMENT, sous l'en-tête (#444).
//
// Un run de deux heures qui ne montre rien se fait tuer à la main par
// inquiétude. Pendant `processing`, la bande dit le tour, ce que l'appel en
// cours produit (le flux de #484, posé par le runner dans
// `agent_jobs.live_progress`), depuis quand rien n'est venu, et le temps et le
// coût consommés face aux plafonds du run (#442).
//
// Rien hors `processing` : une progression restée en base ne se montre pas
// sous un run fini, et le budget d'un run arrêté se lit dans la barre d'état.
// Entre deux appels (un outil qui tourne), il n'y a pas d'appel à décrire : la
// bande dit le budget seul, sans tour inventé.

import type { JobLiveProgress } from '@nodal-agents/db';
import LiveDot from '@/components/ui/LiveDot';
import type { SpaceCostView } from '@/lib/space-cost.ts';
import { formatCost, formatMs, formatTokens } from '@/app/(dashboard)/spaces/format.ts';

export type LiveRunStripProps = {
  status: string | null;
  liveProgress: JobLiveProgress | null;
  cost: SpaceCostView;
  /** L'heure de lecture : l'âge du dernier morceau se compte d'elle. */
  now?: Date;
};

/** Ce que l'appel fait, lu sur ce que son flux a produit. */
function activity(p: JobLiveProgress): string {
  if (p.toolName !== null) return `filling ${p.toolName}`;
  if (p.textChars > 0) return 'writing';
  if (p.reasoningChars > 0) return 'thinking';
  return 'waiting for the model';
}

function callParts(p: JobLiveProgress, now: Date): string[] {
  const parts = [`Turn ${p.turn}`, activity(p)];
  const chars = p.textChars + p.reasoningChars + p.toolInputChars;
  if (p.lastProgressAt === null) {
    // Rien n'est venu : depuis quand l'appel attend.
    parts.push(formatMs(Math.max(0, now.getTime() - Date.parse(p.callStartedAt))));
    return parts;
  }
  parts.push(`${formatTokens(chars)} characters`);
  parts.push(
    `last output ${formatMs(Math.max(0, now.getTime() - Date.parse(p.lastProgressAt)))} ago`,
  );
  return parts;
}

function budgetParts(cost: SpaceCostView): string[] {
  const hours = cost.runBudget?.maxRunHours ?? 0;
  const ceilingUsd = cost.runBudget?.maxRunCostUsd ?? 0;
  const time = formatMs(cost.totals.durationMs);
  const spent = formatCost(cost.totals.costUsd);
  return [
    hours > 0 ? `${time} / ${hours} h` : time,
    ceilingUsd > 0 ? `${spent} / ${formatCost(ceilingUsd, 2)}` : spent,
  ];
}

export default function LiveRunStrip({
  status,
  liveProgress,
  cost,
  now = new Date(),
}: LiveRunStripProps) {
  if (status !== 'processing') return null;
  const parts = [
    ...(liveProgress !== null ? callParts(liveProgress, now) : []),
    ...budgetParts(cost),
  ];
  return (
    <div
      data-testid="live-run-strip"
      className="flex items-center gap-2 rounded-lg border border-rule-2 bg-sidebar px-4 py-2 text-mono-11 text-ink-3"
    >
      <LiveDot variant="blue" />
      <span>{parts.join(' · ')}</span>
    </div>
  );
}
