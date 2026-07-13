'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { resolveApprovalAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextArea from '@/components/ui/TextArea';

interface Props {
  approvalId: string;
}

export default function ApprovalActions({ approvalId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [notes, setNotes] = useState('');

  function handleApprove() {
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: approvalId,
        decision: 'approve',
      });
      if (!r.ok) toast.error(r.message);
      else toast.success('Approved');
    });
  }

  function handleReject() {
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: approvalId,
        decision: 'reject',
        notes: notes.trim() || undefined,
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Rejected');
        setShowRejectInput(false);
        setNotes('');
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <PrimaryButton
          variant="ink"
          size="sm"
          onClick={handleApprove}
          disabled={isPending}
          className="!bg-ok !text-xs !text-canvas hover:!brightness-[0.92]"
        >
          Approve
        </PrimaryButton>
        <PrimaryButton
          variant="danger"
          size="sm"
          onClick={handleReject}
          disabled={isPending}
          className="!text-xs"
        >
          {showRejectInput ? 'Confirm reject' : 'Reject'}
        </PrimaryButton>
        {showRejectInput && (
          <PrimaryButton
            variant="neutral"
            size="sm"
            className="!border-0 !bg-transparent !text-ink-3 hover:!text-ink"
            onClick={() => {
              setShowRejectInput(false);
              setNotes('');
            }}
          >
            Cancel
          </PrimaryButton>
        )}
      </div>
      {showRejectInput && (
        <TextArea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Reason for rejection (optional, shown to the agent)"
          rows={2}
          maxLength={500}
          className="!resize-none !bg-canvas text-xs"
        />
      )}
    </div>
  );
}
