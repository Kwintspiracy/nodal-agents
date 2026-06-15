'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Bell } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { resolveApprovalAction } from '@/lib/actions';
import { useApprovals, type PendingApproval } from './ApprovalsProvider';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(date: Date | string | null): string {
  if (!date) return '—';
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Produce a short readable snippet from toolInput. */
function inputSnippet(toolInput: Record<string, unknown> | null | undefined): string {
  if (!toolInput) return '—';
  // Show `command` if present (run_command), else compact JSON of first key.
  if (typeof toolInput.command === 'string') {
    const cmd = toolInput.command as string;
    return cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd;
  }
  const raw = JSON.stringify(toolInput);
  return raw.length > 60 ? raw.slice(0, 57) + '…' : raw;
}

// ─── Approve button inside the dropdown ───────────────────────────────────────

function ApproveButton({
  item,
  onApproved,
}: {
  item: PendingApproval;
  onApproved: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  function handleApprove() {
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: item.id,
        decision: 'approve',
      });
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success('Approved');
        onApproved();
      }
    });
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault(); // don't follow the parent Link
        e.stopPropagation();
        handleApprove();
      }}
      disabled={isPending}
      className="shrink-0 rounded-md bg-ok px-2.5 py-1 text-[11px] font-semibold text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-40"
    >
      {isPending ? '…' : 'Approve'}
    </button>
  );
}

// ─── Dropdown panel ───────────────────────────────────────────────────────────

function ApprovalsDropdown({
  items,
  onClose,
  onApproved,
}: {
  items: PendingApproval[];
  onClose: () => void;
  onApproved: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside-click.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  // Close on Escape.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full z-50 mt-1.5 w-[340px] rounded-xl border border-rule-2 bg-paper shadow-lg"
      role="dialog"
      aria-label="Pending approvals"
    >
      {/* Header */}
      <div className="border-b border-rule-2 px-4 py-3">
        <p className="text-[13px] font-semibold text-ink">
          Pending approvals ({items.length})
        </p>
      </div>

      {/* Body */}
      {items.length === 0 ? (
        <p className="px-4 py-5 text-center text-[12.5px] text-ink-3">No pending approvals.</p>
      ) : (
        <ul className="max-h-[340px] divide-y divide-rule-2 overflow-y-auto">
          {items.map((item) => (
            <li key={item.id}>
              {/* The item body is a link to the job; Approve button stops propagation */}
              <Link
                href={`/jobs/${item.jobId}`}
                onClick={onClose}
                className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-hover"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-ink">
                    {item.agentName ?? 'Agent'}
                    <span className="mx-1 text-ink-4">·</span>
                    <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px] text-ink-2">
                      {item.toolName}
                    </code>
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-3">
                    {inputSnippet(item.toolInput as Record<string, unknown> | null)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink-4">
                    {relativeTime(item.requestedAt)}
                  </p>
                </div>
                <ApproveButton item={item} onApproved={onApproved} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Footer */}
      <div className="border-t border-rule-2 px-4 py-2.5">
        <Link
          href="/approvals"
          onClick={onClose}
          className="text-[12px] font-medium text-ink-2 transition-colors hover:text-ink"
        >
          See all approvals →
        </Link>
      </div>
    </div>
  );
}

// ─── Bell button ──────────────────────────────────────────────────────────────

export default function NotificationsBell() {
  const { pending, refresh } = useApprovals();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const count = pending.length;

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const handleApproved = useCallback(() => {
    refresh();
    // Panel stays open so the user can approve more items; it will auto-update.
  }, [refresh]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        title="Notifications"
        onClick={toggle}
        className="relative flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md border border-rule-2 bg-paper text-ink-2 transition-colors hover:text-ink"
      >
        <Bell size={15} />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-err px-1 text-[9px] font-bold leading-none text-canvas">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <ApprovalsDropdown
          items={pending}
          onClose={close}
          onApproved={handleApproved}
        />
      )}
    </div>
  );
}
