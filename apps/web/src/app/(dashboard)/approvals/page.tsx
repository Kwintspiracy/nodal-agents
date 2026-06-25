import Link from 'next/link';
import { Clock } from '@phosphor-icons/react/dist/ssr';
import { listApprovalsAction } from '@/lib/actions.ts';
import ApprovalCard from '@/components/ui/ApprovalCard';
import StatusPill from '@/components/ui/StatusPill';
import type { StatusVariant } from '@/components/ui/StatusPill';
import ApprovalActions from './ApprovalActions.tsx';

export const dynamic = 'force-dynamic';

const STATUS_TO_VARIANT: Record<string, StatusVariant> = {
  pending: 'run',
  approved: 'done',
  rejected: 'warn',
  expired: 'idle',
};

const TABS = ['pending', 'approved', 'rejected', 'expired', 'all'] as const;
type Tab = (typeof TABS)[number];

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rawStatus = sp.status;
  const status: Tab =
    rawStatus === 'approved' ||
    rawStatus === 'rejected' ||
    rawStatus === 'expired' ||
    rawStatus === 'all'
      ? rawStatus
      : 'pending';

  const result = await listApprovalsAction({ status });
  if (!result.ok) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-ink">Approvals</h1>
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Approvals</h1>
        <p className="mt-0.5 text-sm text-ink-3">
          {result.data.length} {status === 'all' ? '' : status} approval
          {result.data.length === 1 ? '' : 's'}
        </p>
      </div>

      {/* Tab filter strip */}
      <div className="flex gap-1.5 text-xs">
        {TABS.map((s) => (
          <Link
            key={s}
            href={s === 'pending' ? '/approvals' : `/approvals?status=${s}`}
            className={`rounded-md px-3 py-1.5 font-medium capitalize transition-colors ${
              status === s
                ? 'bg-ink text-canvas'
                : 'border border-rule-2 text-ink-3 hover:border-rule hover:text-ink'
            }`}
          >
            {s}
          </Link>
        ))}
      </div>

      {result.data.length === 0 ? (
        <div className="rounded-xl border border-rule-2 bg-paper px-6 py-12 text-center text-sm text-ink-4">
          {status === 'pending'
            ? 'No pending approvals. Tools that require approval show up here.'
            : `No ${status} approvals.`}
        </div>
      ) : (
        <div className="space-y-3">
          {result.data.map((a) => (
            <ApprovalCard
              key={a.id}
              icon={<Clock size={18} />}
              title={<span className="font-mono text-sm text-conn-vivid">{a.toolName}</span>}
              agent={`${a.agentName ?? 'no agent'} · ${a.status}`}
              body={
                <div className="space-y-1">
                  {(() => {
                    const ti = (a.toolInput ?? {}) as Record<string, unknown>;
                    const purpose = typeof ti.purpose === 'string' ? ti.purpose.trim() : '';
                    const impact = typeof ti.impact === 'string' ? ti.impact.trim() : '';
                    if (!purpose && !impact) return null;
                    return (
                      <div className="space-y-0.5 rounded-md border border-rule-2 bg-canvas px-3 py-2">
                        {purpose && <p className="text-[13px] text-ink">➤ {purpose}</p>}
                        {impact && <p className="text-[12px] text-warn">⚠️ {impact}</p>}
                      </div>
                    );
                  })()}
                  <div>
                    {a.agentName ? (
                      <>
                        by{' '}
                        <Link href="/agents" className="text-ink-2 hover:text-ink">
                          {a.agentName}
                        </Link>
                      </>
                    ) : (
                      <span className="text-ink-4">no agent</span>
                    )}
                    {a.requestedAt && (
                      <span className="text-ink-3">
                        {' '}
                        · requested {new Date(a.requestedAt).toLocaleString()}
                      </span>
                    )}
                    {a.status === 'pending' && a.expiresAt && (
                      <span className="text-ink-3">
                        {' '}
                        · expires {new Date(a.expiresAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {a.jobTask && <p className="italic text-ink-3">&ldquo;{a.jobTask}&rdquo;</p>}
                  <details className="mt-1 rounded-md border border-rule bg-canvas">
                    <summary className="cursor-pointer px-3 py-2 text-[12px] text-ink-3 hover:text-ink-2">
                      Tool input
                    </summary>
                    <pre className="whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[12px] text-ink-2">
                      {JSON.stringify(a.toolInput, null, 2)}
                    </pre>
                  </details>
                  {a.status !== 'pending' && a.notes && (
                    <p className="italic text-ink-3">
                      Note: {a.notes}
                      {a.resolvedBy ? ` (by ${a.resolvedBy})` : ''}
                    </p>
                  )}
                </div>
              }
              meta={
                <div className="flex flex-col items-end gap-2">
                  <StatusPill variant={STATUS_TO_VARIANT[a.status] ?? 'idle'} label={a.status} />
                  <Link
                    href={`/jobs/${a.jobId}`}
                    className="rounded-md border border-rule-2 px-2.5 py-1 text-[12px] font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink"
                  >
                    View job
                  </Link>
                </div>
              }
              actions={a.status === 'pending' ? <ApprovalActions approvalId={a.id} /> : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
