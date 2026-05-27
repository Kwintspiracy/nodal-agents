// RunApprovalBanner — coral-tinted banner shown when a job is in the
// `awaiting_approval` state. Matches the design's `.appr-banner` pattern
// (coral dashed border, amber/coral icon, Reject + Approve buttons).
//
// Currently used only on /jobs/[id]; created as a standalone primitive so
// the /approvals list can reuse it if needed.

'use client';

import { Warning } from '@phosphor-icons/react';

type Props = {
  /** Title — bold lead text. */
  title?: string;
  /** Body — human-readable description of what needs approval. */
  body?: string;
  onReject?: () => void;
  onApprove?: () => void;
  /** When true, both buttons are disabled (e.g. while a request is in-flight). */
  pending?: boolean;
};

/**
 * RunApprovalBanner — coral-tinted action strip placed at the bottom of the
 * timeline panel when the job is paused awaiting human approval.
 *
 * Maps to `.appr-banner` in the design bundle:
 *   - dashed coral border
 *   - coral-tinted icon (Warning circle)
 *   - "Reject" ghost button + "Approve" solid button
 */
export default function RunApprovalBanner({
  title = 'Approval required',
  body,
  onReject,
  onApprove,
  pending = false,
}: Props) {
  return (
    <div className="mx-[18px] mb-[18px] flex items-center gap-[14px] rounded-[10px] border border-dashed border-skill-vivid/45 bg-skill-vivid/8 px-[16px] py-[14px]">
      <Warning size={22} weight="regular" className="shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <b className="block text-[13px] font-medium leading-snug text-ink">{title}</b>
        {body && <span className="mt-0.5 block text-[12px] leading-[1.5] text-ink-3">{body}</span>}
      </div>
      {(onReject || onApprove) && (
        <div className="flex shrink-0 gap-2">
          {onReject && (
            <button
              type="button"
              onClick={onReject}
              disabled={pending}
              className="inline-flex h-[30px] items-center rounded-[6px] border border-rule px-[14px] text-[12px] font-medium leading-none text-ink-3 transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reject
            </button>
          )}
          {onApprove && (
            <button
              type="button"
              onClick={onApprove}
              disabled={pending}
              className="inline-flex h-[30px] items-center rounded-[6px] bg-ink px-[14px] text-[12px] font-medium leading-none text-canvas transition-[filter] hover:brightness-[0.92] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Approve
            </button>
          )}
        </div>
      )}
    </div>
  );
}
