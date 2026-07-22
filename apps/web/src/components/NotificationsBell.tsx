'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Bell, ArrowClockwise } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { resolveApprovalAction } from '@/lib/actions';
import IconButton from '@/components/ui/IconButton';
import RowActionButton from '@/components/ui/RowActionButton';
import { useApprovals, type PendingApproval } from './ApprovalsProvider';
import { useSkillUpdates, type SkillUpdateNotice } from './SkillUpdatesProvider';
import { relativeTime } from '@/lib/format-time';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Produce a short readable snippet from toolInput. */
function inputSnippet(toolInput: Record<string, unknown> | null | undefined): string {
  if (!toolInput) return '—';
  // Prefer the agent's plain-language `purpose` (what this approval is FOR) over
  // the raw command — that's what lets the user decide at a glance.
  if (typeof toolInput.purpose === 'string' && toolInput.purpose.trim()) {
    const p = toolInput.purpose.trim();
    return p.length > 80 ? p.slice(0, 77) + '…' : p;
  }
  // Fallback: `command` if present (run_command), else compact JSON of first key.
  if (typeof toolInput.command === 'string') {
    const cmd = toolInput.command as string;
    return cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd;
  }
  const raw = JSON.stringify(toolInput);
  return raw.length > 60 ? raw.slice(0, 57) + '…' : raw;
}

// ─── Approve button inside the dropdown ───────────────────────────────────────

function ApproveButton({ item, onApproved }: { item: PendingApproval; onApproved: () => void }) {
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
    // Stops the click from bubbling to the parent Link (the item body
    // navigates to the job; Approve must act in place instead).
    <span onClick={(e) => e.stopPropagation()}>
      <RowActionButton
        onClick={handleApprove}
        disabled={isPending}
        className="!border-ok/30 !bg-ok font-semibold !text-canvas hover:!bg-ok hover:brightness-[0.92]"
      >
        {isPending ? '…' : 'Approve'}
      </RowActionButton>
    </span>
  );
}

// ─── Dropdown panel ───────────────────────────────────────────────────────────

function ApprovalsDropdown({
  items,
  updates,
  onClose,
  onApproved,
}: {
  items: PendingApproval[];
  updates: SkillUpdateNotice[];
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
        <p className="text-legacy-14 font-semibold text-ink">Pending approvals ({items.length})</p>
      </div>

      {/* Body */}
      {items.length === 0 ? (
        <p className="px-4 py-5 text-center text-body-13 text-ink-3">No pending approvals.</p>
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
                  <p className="truncate text-medium-13 text-ink">
                    {item.agentName ?? 'Agent'}
                    <span className="mx-1 text-ink-4">·</span>
                    <code className="rounded bg-canvas px-1 py-0.5 text-mono-12 text-ink-2">
                      {item.toolName}
                    </code>
                  </p>
                  <p className="mt-0.5 truncate text-body-12 text-ink-3">
                    {inputSnippet(item.toolInput as Record<string, unknown> | null)}
                  </p>
                  <p className="mt-0.5 text-legacy-11 text-ink-4">
                    {relativeTime(item.requestedAt)}
                  </p>
                </div>
                <ApproveButton item={item} onApproved={onApproved} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Updates section — only rendered when there's at least one. */}
      {updates.length > 0 && (
        <>
          <div className="border-t border-b border-rule-2 px-4 py-3">
            <p className="text-legacy-14 font-semibold text-ink">Updates ({updates.length})</p>
          </div>
          <ul className="max-h-[220px] divide-y divide-rule-2 overflow-y-auto">
            {updates.map((u) => (
              <li key={u.slug}>
                <Link
                  href="/skills"
                  onClick={onClose}
                  className="flex items-center gap-2.5 px-4 py-3 transition-colors hover:bg-hover"
                >
                  <ArrowClockwise size={14} className="shrink-0 text-warn" />
                  <span className="min-w-0 flex-1 truncate text-medium-13 text-ink">
                    {u.name} has an update
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Footer */}
      <div className="border-t border-rule-2 px-4 py-2.5">
        <Link
          href="/approvals"
          onClick={onClose}
          className="text-medium-13 text-ink-2 transition-colors hover:text-ink"
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
  const { updates } = useSkillUpdates();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const count = pending.length + updates.length;

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const handleApproved = useCallback(() => {
    refresh();
    // Panel stays open so the user can approve more items; it will auto-update.
  }, [refresh]);

  return (
    <div ref={containerRef} className="relative">
      {/* IconButton's `badge` prop (audit UX-B1) is a plain presence dot, not a
          count — it replaces the bespoke numeric bubble this button used to
          draw itself. The exact pending count is still one click away in the
          dropdown header ("Pending approvals (N)"), and the aria-label keeps
          it available to assistive tech even though it's not painted here. */}
      <IconButton
        aria-label={count > 0 ? `Notifications (${count} pending)` : 'Notifications'}
        title="Notifications"
        onClick={toggle}
        badge={count > 0}
      >
        <Bell size={15} />
      </IconButton>

      {open && (
        <ApprovalsDropdown
          items={pending}
          updates={updates}
          onClose={close}
          onApproved={handleApproved}
        />
      )}
    </div>
  );
}
