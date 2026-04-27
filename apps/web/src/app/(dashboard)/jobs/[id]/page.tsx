import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getJobDetailAction } from '@/lib/actions.ts';
import StatusBadge from '@/components/StatusBadge.tsx';
import JobMessages from '@/components/JobMessages.tsx';
import JobStatusPoller from '@/components/JobStatusPoller.tsx';

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
      <div className="space-y-4 max-w-3xl">
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
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link href="/jobs" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Jobs
        </Link>
        <span className="text-neutral-700 text-xs font-mono">{job.id}</span>
      </div>

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-5">
        {/* Live status poller when job is active, static badge otherwise */}
        {isLive ? (
          <JobStatusPoller jobId={job.id} initialStatus={job.status ?? 'pending'} />
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
