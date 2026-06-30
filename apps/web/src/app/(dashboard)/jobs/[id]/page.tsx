import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getJobDetailAction } from '@/lib/actions.ts';
import StatusBadge from '@/components/StatusBadge.tsx';
import JobMessages from '@/components/JobMessages.tsx';
import JobStatusPoller from '@/components/JobStatusPoller.tsx';
import PageShell from '@/components/ui/PageShell';
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
      <PageShell title="Run">
        <div className="space-y-4">
          <Link href="/jobs" className="text-xs text-ink-3 hover:text-ink-2">
            ← Jobs
          </Link>
          <p className="text-sm text-err">{result.message}</p>
        </div>
      </PageShell>
    );
  }

  const job = result.data;
  const isLive = !TERMINAL.has(job.status ?? '');
  const messages = Array.isArray(job.messages) ? (job.messages as Record<string, unknown>[]) : [];

  return (
    <PageShell title={job.agentName ?? 'Run'} subtitle={job.id}>
      <div className="space-y-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/jobs" className="text-xs text-ink-3 hover:text-ink-2">
            ← Jobs
          </Link>
          {job.agentName && (
            <span className="text-sm font-medium text-ink">
              {job.agentName}
              {job.agentSlug && (
                <span className="ml-1.5 text-ink-3 font-mono text-xs">({job.agentSlug})</span>
              )}
            </span>
          )}
          <span className="text-ink-4 text-xs font-mono ml-auto">{job.id}</span>
        </div>

        {/* Delegation context: parent + children */}
        {(job.parentJobId || job.children.length > 0) && (
          <div className="bg-paper border border-rule-2 rounded-xl p-5 space-y-3">
            <h2 className="text-xs text-ink-3 font-semibold uppercase tracking-wider">
              Delegation
            </h2>
            {job.parentJobId && (
              <div className="text-xs">
                <span className="text-ink-4 mr-2">↑ parent</span>
                <Link
                  href={`/jobs/${job.parentJobId}`}
                  className="font-mono text-run hover:text-run"
                >
                  {job.parentJobId}
                </Link>
              </div>
            )}
            {job.children.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-ink-4">↓ children ({job.children.length})</p>
                {job.children.map((child) => (
                  <Link
                    key={child.id}
                    href={`/jobs/${child.id}`}
                    className="flex items-center gap-3 text-xs px-3 py-2 bg-canvas border border-rule-2 rounded-lg hover:border-rule"
                  >
                    <span className="text-ink font-medium min-w-0">{child.agentName ?? '—'}</span>
                    <StatusBadge status={child.status ?? 'pending'} />
                    <span className="text-ink-3 truncate min-w-0 flex-1">
                      {child.result ?? child.error ?? ''}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="bg-paper border border-rule-2 rounded-xl p-5 space-y-5">
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
              {/* Result (the human-facing reason — now always populated for a
                blocked/failed run thanks to the reason-on-block fix) AND the
                Error both stay fully visible: the reason explains WHAT happened,
                the error carries the description/code. Neither hides the other. */}
              {job.result && (
                <div>
                  <p className="text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1">
                    Result
                  </p>
                  <pre className="text-sm text-ink-2 whitespace-pre-wrap bg-canvas rounded-lg p-4 border border-rule-2 max-h-80 overflow-auto">
                    {job.result}
                  </pre>
                </div>
              )}
              {job.error && (
                <div>
                  <p className="text-xs text-err font-semibold uppercase tracking-wider mb-1">
                    Error
                  </p>
                  <pre className="text-sm text-err whitespace-pre-wrap bg-warn-bg rounded-lg p-4 border border-err/30">
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
              <div key={label} className="bg-canvas border border-rule-2 rounded-lg px-3 py-2">
                <p className="text-[11px] text-ink-4 uppercase tracking-wider mb-0.5">{label}</p>
                <p className="text-ink-3 font-mono truncate">{value ?? '—'}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Messages thread */}
        {messages.length > 0 && (
          <div className="bg-paper border border-rule-2 rounded-xl p-5 space-y-3">
            <h2 className="text-xs text-ink-3 font-semibold uppercase tracking-wider">
              Messages ({messages.length})
            </h2>
            <JobMessages messages={messages} />
          </div>
        )}
      </div>
    </PageShell>
  );
}
