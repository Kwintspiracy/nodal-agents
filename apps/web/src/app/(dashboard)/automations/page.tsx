import { listAgentsAction, listSchedulesAction } from '@/lib/actions.ts';
import ScheduleForm from './ScheduleForm.tsx';
import ScheduleActions from './ScheduleActions.tsx';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage() {
  const [agentsResult, schedulesResult] = await Promise.all([
    listAgentsAction(),
    listSchedulesAction(),
  ]);

  if (!schedulesResult.ok) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold text-white">Automations</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {schedulesResult.message}
        </div>
      </div>
    );
  }

  const agents = agentsResult.ok ? agentsResult.data : [];
  const active = schedulesResult.data.filter((s) => s.active).length;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Automations</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {active} active · {schedulesResult.data.length} total
        </p>
      </div>

      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-3 text-xs text-amber-300">
        <strong className="font-semibold">Scheduler not yet running.</strong> You can define
        schedules and they're saved, but the runner cron tick doesn't pick them up yet —
        agents won't fire on the configured schedule. The wiring lands in a follow-up
        brick. For now, treat this page as schedule planning.
      </div>

      <ScheduleForm agents={agents} />

      {schedulesResult.data.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
          {agents.length === 0
            ? 'Create an agent first, then schedule a recurring task.'
            : 'No schedules yet. Add one above.'}
        </div>
      ) : (
        <div className="space-y-3">
          {schedulesResult.data.map((s) => (
            <div
              key={s.id}
              className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-semibold text-white">{s.name}</h3>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                        s.active
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-neutral-800 text-neutral-500'
                      }`}
                    >
                      {s.active ? 'active' : 'paused'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <code className="font-mono text-violet-400">{s.cronExpr}</code>
                    {s.agentName && (
                      <>
                        <span className="text-neutral-700">·</span>
                        <span>
                          {s.agentName}{' '}
                          <span className="font-mono text-neutral-600">{s.agentSlug}</span>
                        </span>
                      </>
                    )}
                  </div>
                  {s.lastRun && (
                    <div className="text-[10px] text-neutral-600">
                      Last run {new Date(s.lastRun).toLocaleString()}
                      {s.lastStatus && (
                        <span
                          className={`ml-2 ${
                            s.lastStatus === 'success'
                              ? 'text-emerald-400'
                              : s.lastStatus === 'failed'
                                ? 'text-red-400'
                                : 'text-neutral-500'
                          }`}
                        >
                          ({s.lastStatus})
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <ScheduleActions id={s.id} active={s.active} />
              </div>

              {s.task && (
                <details className="bg-neutral-950 border border-neutral-800/40 rounded-md">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300">
                    Task instructions
                  </summary>
                  <pre className="px-3 pb-3 text-xs text-neutral-300 whitespace-pre-wrap">
                    {s.task}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
