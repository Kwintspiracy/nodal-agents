'use client';

import Link from 'next/link';
import type { AgentRow, ScheduleRow as ScheduleRowData } from '@/lib/actions.ts';
import { humanLabel } from '@/lib/cron.ts';
import StatusPill from '@/components/ui/StatusPill';
import ScheduleActions from './ScheduleActions.tsx';

interface Props {
  schedule: ScheduleRowData;
  agents: AgentRow[];
}

export default function ScheduleRow({ schedule: s, agents }: Props) {
  return (
    /* Ancre stable (issue #55). Quatre parcours désignaient cette carte par
       `.rounded-xl`, une classe de mise en forme : le jour où un `rounded-xl`
       est devenu `rounded-2xl`, huit parcours sont passés au rouge d'un coup,
       en silence, sans qu'une seule fonctionnalité soit cassée. Le genre vit à
       côté de l'ancre pour qu'un lecteur du DOM sache de quelle carte il
       s'agit sans avoir à lire son titre. */
    <div
      data-testid="automation-card"
      data-automation-kind="schedule"
      className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Le nom OUVRE l'automatisation (#202) : ses réglages en entier et
                ses derniers runs. La carte garde ses gestes rapides. Le lien
                vit DANS le titre : le nom reste le titre de la carte, pour qui
                lit l'écran comme pour qui le parcourt au clavier. */}
            <h3 className="text-base font-semibold text-ink">
              <Link href={`/automations/${s.id}`} className="hover:underline">
                {s.name}
              </Link>
            </h3>
            <StatusPill
              variant={s.active ? 'done' : 'idle'}
              label={s.active ? 'Active' : 'Paused'}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
            <span>{humanLabel(s.cronExpr)}</span>
            {s.agentName && (
              <>
                <span className="text-rule">·</span>
                <span>
                  {s.agentName} <span className="font-mono text-ink-4">{s.agentSlug}</span>
                </span>
              </>
            )}
            {s.notifyOnSuccess && (
              <>
                <span className="text-rule">·</span>
                <span
                  title={`Sends you a confirmation on ${s.notifyChannel ?? 'your first active channel'} when it succeeds`}
                >
                  🔔 Notifies
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 text-legacy-11 text-ink-4">
            {s.nextRun && s.active && <span>Next run {new Date(s.nextRun).toLocaleString()}</span>}
            {s.lastRun && (
              <span>
                Last run {new Date(s.lastRun).toLocaleString()}
                {s.lastStatus && (
                  <span
                    className={`ml-1 ${
                      s.lastStatus === 'success'
                        ? 'text-ok'
                        : s.lastStatus === 'failed'
                          ? 'text-err'
                          : s.lastStatus === 'budget_exhausted' ||
                              s.lastStatus === 'notify_unreachable'
                            ? 'text-warn'
                            : 'text-ink-4'
                    }`}
                  >
                    (
                    {s.lastStatus === 'budget_exhausted'
                      ? 'budget reached'
                      : s.lastStatus === 'notify_unreachable'
                        ? 'notify unreachable'
                        : s.lastStatus}
                    )
                  </span>
                )}
              </span>
            )}
            {s.lastStatus === 'budget_exhausted' && (
              <span title={`Paused until tomorrow — spent its $${s.dailyBudgetUsd} daily budget`}>
                💰
              </span>
            )}
            {s.lastStatus === 'notify_unreachable' && (
              <span
                title={`Ran, but couldn't reach you on ${s.notifyChannel ?? 'the notify channel'} — you never messaged this agent there yet.`}
              >
                🔕
              </span>
            )}
          </div>
        </div>

        <ScheduleActions schedule={s} agents={agents} />
      </div>

      {s.task && (
        <details className="rounded-md border border-rule bg-canvas">
          <summary className="cursor-pointer px-3 py-2 text-xs text-ink-3 hover:text-ink-2">
            Task instructions
          </summary>
          <pre className="whitespace-pre-wrap px-3 pb-3 text-xs text-ink-2">{s.task}</pre>
        </details>
      )}
    </div>
  );
}
