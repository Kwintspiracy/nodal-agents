import { listAgentsAction, listSchedulesAction } from '@/lib/actions.ts';
import ScheduleForm from './ScheduleForm.tsx';
import ScheduleRow from './ScheduleRow.tsx';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage() {
  const [agentsResult, schedulesResult] = await Promise.all([
    listAgentsAction(),
    listSchedulesAction(),
  ]);

  if (!schedulesResult.ok) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-ink">Automations</h1>
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {schedulesResult.message}
        </div>
      </div>
    );
  }

  const agents = agentsResult.ok ? agentsResult.data : [];
  const active = schedulesResult.data.filter((s) => s.active).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Automations</h1>
        <p className="mt-0.5 text-sm text-ink-3">
          {active} active · {schedulesResult.data.length} total
        </p>
      </div>

      <ScheduleForm agents={agents} />

      {schedulesResult.data.length === 0 ? (
        <div className="rounded-xl border border-rule-2 bg-paper px-6 py-12 text-center text-sm text-ink-4">
          {agents.length === 0
            ? 'Create an agent first, then schedule a recurring task.'
            : 'No schedules yet. Add one above.'}
        </div>
      ) : (
        <div className="space-y-3">
          {schedulesResult.data.map((s) => (
            <ScheduleRow key={s.id} schedule={s} agents={agents} />
          ))}
        </div>
      )}
    </div>
  );
}
