import { listTasksAction, listAgentsAction } from '@/lib/actions.ts';
import SendTaskForm from '@/components/SendTaskForm.tsx';
import StatusBadge from '@/components/StatusBadge.tsx';

function formatDate(d: Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

export default async function TasksPage() {
  const [tasksResult, agentsResult] = await Promise.all([listTasksAction(), listAgentsAction()]);

  const tasks = tasksResult.ok ? tasksResult.data : [];
  const agents = agentsResult.ok ? agentsResult.data : [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tasks</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <SendTaskForm agents={agents} />
      </div>

      {!tasksResult.ok && <p className="text-sm text-red-400">{tasksResult.message}</p>}

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
        {tasks.length === 0 ? (
          <div className="px-6 py-12 text-center text-neutral-600 text-sm">
            No tasks yet. Send one above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800/60">
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                  Title
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
                  Priority
                </th>
                <th className="text-right px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="border-b border-neutral-800/40 last:border-0">
                  <td className="px-5 py-3 max-w-[300px]">
                    <span className="text-neutral-300 truncate block" title={task.title}>
                      {task.title}
                    </span>
                    {task.jobId && (
                      <a
                        href={`/jobs/${task.jobId}`}
                        className="text-xs text-violet-400 hover:underline mt-0.5 inline-block"
                      >
                        View job
                      </a>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="hidden md:table-cell px-5 py-3 text-neutral-500 text-xs capitalize">
                    {task.priority}
                  </td>
                  <td className="hidden lg:table-cell px-5 py-3 text-right text-neutral-600 text-xs">
                    {formatDate(task.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
