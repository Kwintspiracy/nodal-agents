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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Automations</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {active} active · {schedulesResult.data.length} total
        </p>
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
            <ScheduleRow key={s.id} schedule={s} agents={agents} />
          ))}
        </div>
      )}
    </div>
  );
}
