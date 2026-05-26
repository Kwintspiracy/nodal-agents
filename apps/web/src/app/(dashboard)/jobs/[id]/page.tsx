import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getJobDetailAction } from '@/lib/actions.ts';
import StatusBadge from '@/components/StatusBadge.tsx';
import JobMessages from '@/components/JobMessages.tsx';
import JobStatusPoller from '@/components/JobStatusPoller.tsx';
import CancelJobButton from '../CancelJobButton.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function formatDate(d: Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

type Props = { params: Promise<{ id: string }> };

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const result = await getJobDetailAction(id);

  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <div className="space-y-4">
        <Link href="/jobs" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Jobs
        </Link>
        <p className="text-sm text-red-400">{result.message}</p>
      </div>
    );
  }

  const job = result.data;
  const isLive = !TERMINAL.has(job.status ?? '');
  const messages = Array.isArray(job.messages) ? (job.messages as Record<string, unknown>[]) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/jobs" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Jobs
        </Link>
        {job.agentName && (
          <span className="text-sm font-medium text-white">
            {job.agentName}
            {job.agentSlug && (
              <span className="ml-1.5 text-neutral-500 font-mono text-xs">({job.agentSlug})</span>
            )}
          </span>
        )}
        <span className="text-neutral-700 text-xs font-mono ml-auto">{job.id}</span>
      </div>

      {/* Delegation context: parent + children */}
      {(job.parentJobId || job.children.length > 0) && (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3">
          <h2 className="text-xs text-neutral-500 font-semibold uppercase tracking-wider">
            Delegation
          </h2>
          {job.parentJobId && (
            <div className="text-xs">
              <span className="text-neutral-600 mr-2">↑ parent</span>
              <Link
                href={`/jobs/${job.parentJobId}`}
                className="font-mono text-violet-400 hover:text-violet-300"
              >
                {job.parentJobId}
              </Link>
            </div>
          )}
          {job.children.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-neutral-600">↓ children ({job.children.length})</p>
              {job.children.map((child) => (
                <Link
                  key={child.id}
                  href={`/jobs/${child.id}`}
                  className="flex items-center gap-3 text-xs px-3 py-2 bg-neutral-950 border border-neutral-800/40 rounded-lg hover:border-neutral-700"
                >
                  <span className="text-white font-medium min-w-0">{child.agentName ?? '—'}</span>
                  <StatusBadge status={child.status ?? 'pending'} />
                  <span className="text-neutral-500 truncate min-w-0 flex-1">
                    {child.result ?? child.error ?? ''}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-5">
        {/* Live status poller when job is active, static badge otherwise.
            Cancel button shown only while the job can still be cancelled —
            once terminal, the action would refuse anyway. */}
        {isLive ? (
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <JobStatusPoller jobId={job.id} initialStatus={job.status ?? 'pending'} />
            <CancelJobButton jobId={job.id} />
          </div>
        ) : (
          <div className="space-y-4">
            <StatusBadge status={job.status ?? 'pending'} />
            {job.result && (
              <div>
                <p className="text-xs text-neutral-500 font-semibold uppercase tracking-wider mb-1">
                  Result
                </p>
                <pre className="text-sm text-neutral-300 whitespace-pre-wrap bg-neutral-950 rounded-lg p-4 border border-neutral-800/60 max-h-80 overflow-auto">
                  {job.result}
                </pre>
              </div>
            )}
            {job.error && (
              <div>
                <p className="text-xs text-red-400 font-semibold uppercase tracking-wider mb-1">
                  Error
                </p>
                <pre className="text-sm text-red-300 whitespace-pre-wrap bg-red-950/20 rounded-lg p-4 border border-red-900/40">
                  {job.error}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            ['Task', job.task],
            ['Channel', job.channel],
            ['Turn', String(job.turn ?? 0)],
            ['Chain count', String(job.chainCount ?? 0)],
            ['Delegation depth', String(job.delegationDepth ?? 0)],
            ['Input tokens', String(job.inputTokens ?? 0)],
            ['Output tokens', String(job.outputTokens ?? 0)],
            ['Duration ms', String(job.totalDurationMs ?? '—')],
            ['Created', formatDate(job.createdAt)],
            ['Completed', formatDate(job.completedAt)],
          ].map(([label, value]) => (
            <div
              key={label}
              className="bg-neutral-950 border border-neutral-800/40 rounded-lg px-3 py-2"
            >
              <p className="text-[10px] text-neutral-600 uppercase tracking-wider mb-0.5">
                {label}
              </p>
              <p className="text-neutral-400 font-mono truncate">{value ?? '—'}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Messages thread */}
      {messages.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3">
          <h2 className="text-xs text-neutral-500 font-semibold uppercase tracking-wider">
            Messages ({messages.length})
          </h2>
          <JobMessages messages={messages} />
        </div>
      )}
    </div>
  );
}
