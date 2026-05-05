import Link from 'next/link';
import { listJobsAction, listAgentsAction } from '@/lib/actions.ts';
import SendTaskForm from '@/components/SendTaskForm.tsx';
import StatusBadge from '@/components/StatusBadge.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

function formatDate(d: Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export default async function JobsPage() {
  const [jobsResult, agentsResult] = await Promise.all([
    listJobsAction({ limit: 50 }),
    listAgentsAction(),
  ]);
  const jobs = jobsResult.ok ? jobsResult.data : [];
  const agents = agentsResult.ok ? agentsResult.data : [];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Jobs</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {jobs.length} recent job{jobs.length !== 1 ? 's' : ''}
          </p>
        </div>
        <SendTaskForm agents={agents} />
      </div>

      {!jobsResult.ok && <p className="text-sm text-red-400">{jobsResult.message}</p>}

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
        {jobs.length === 0 ? (
          <div className="px-6 py-12 text-center text-neutral-600 text-sm">
            No jobs yet. Use the form above to send your first task to an agent.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800/60">
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                    Task
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
                    Channel
                  </th>
                  <th className="text-right px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    className="border-b border-neutral-800/40 last:border-0 hover:bg-neutral-800/25 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <StatusBadge status={job.status ?? 'pending'} />
                    </td>
                    <td className="px-5 py-3 max-w-[320px]">
                      <Link
                        href={`/jobs/${job.id}`}
                        className="text-neutral-300 hover:text-white transition-colors truncate block"
                        title={job.task}
                      >
                        {truncate(job.task, 60)}
                      </Link>
                    </td>
                    <td className="hidden md:table-cell px-5 py-3 text-neutral-500 text-xs">
                      {job.channel}
                    </td>
                    <td className="hidden lg:table-cell px-5 py-3 text-right text-neutral-600 text-xs">
                      {formatDate(job.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
