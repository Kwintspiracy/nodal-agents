import Link from 'next/link';
import { listApprovalsAction } from '@/lib/actions.ts';
import ApprovalActions from './ApprovalActions.tsx';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-400',
  approved: 'bg-emerald-500/15 text-emerald-400',
  rejected: 'bg-red-500/15 text-red-400',
  expired: 'bg-neutral-700 text-neutral-400',
};

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rawStatus = sp.status;
  const status =
    rawStatus === 'approved' ||
    rawStatus === 'rejected' ||
    rawStatus === 'expired' ||
    rawStatus === 'all'
      ? rawStatus
      : 'pending';

  const result = await listApprovalsAction({ status });
  if (!result.ok) {
    return (
      <div className="space-y-6 max-w-5xl">
        <h1 className="text-2xl font-bold text-white">Approvals</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Approvals</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {result.data.length} {status === 'all' ? '' : status} approval
          {result.data.length === 1 ? '' : 's'}
        </p>
      </div>

      <div className="flex gap-1.5 text-xs">
        {(['pending', 'approved', 'rejected', 'expired', 'all'] as const).map((s) => (
          <Link
            key={s}
            href={s === 'pending' ? '/approvals' : `/approvals?status=${s}`}
            className={`px-3 py-1.5 rounded-md font-medium ${
              status === s
                ? 'bg-white text-black'
                : 'border border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-white'
            }`}
          >
            {s}
          </Link>
        ))}
      </div>

      {result.data.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
          {status === 'pending'
            ? 'No pending approvals. Tools that require approval show up here.'
            : `No ${status} approvals.`}
        </div>
      ) : (
        <div className="space-y-3">
          {result.data.map((a) => (
            <div
              key={a.id}
              className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="font-mono text-sm text-violet-400">{a.toolName}</code>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                        STATUS_PILL[a.status] ?? 'bg-neutral-800 text-neutral-400'
                      }`}
                    >
                      {a.status}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-500">
                    {a.agentName ? (
                      <>
                        by{' '}
                        <Link
                          href={`/agents`}
                          className="text-neutral-300 hover:text-white"
                        >
                          {a.agentName}
                        </Link>
                      </>
                    ) : (
                      <span className="text-neutral-600">no agent</span>
                    )}
                    {a.requestedAt && (
                      <span> · requested {new Date(a.requestedAt).toLocaleString()}</span>
                    )}
                    {a.status === 'pending' && a.expiresAt && (
                      <span> · expires {new Date(a.expiresAt).toLocaleString()}</span>
                    )}
                  </div>
                  {a.jobTask && (
                    <p className="text-xs text-neutral-400 mt-2 italic">"{a.jobTask}"</p>
                  )}
                </div>
                <Link
                  href={`/jobs/${a.jobId}`}
                  className="shrink-0 px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white"
                >
                  View job
                </Link>
              </div>

              <details className="bg-neutral-950 border border-neutral-800/40 rounded-md">
                <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300">
                  Tool input
                </summary>
                <pre className="px-3 pb-3 text-xs text-neutral-300 font-mono whitespace-pre-wrap break-words">
                  {JSON.stringify(a.toolInput, null, 2)}
                </pre>
              </details>

              {a.status === 'pending' ? (
                <ApprovalActions approvalId={a.id} />
              ) : (
                a.notes && (
                  <p className="text-xs text-neutral-500 italic">
                    Note: {a.notes}
                    {a.resolvedBy ? ` (by ${a.resolvedBy})` : ''}
                  </p>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
