'use client';

// ConversationApprovals — the approvals a conversation's runs are waiting for,
// answered IN the conversation (#469).
//
// Quentin, 24/09, testing #464 (run ae424ac0): the agent's command was held,
// and answering meant leaving the conversation for the Approvals page "just to
// click a button". The approval belongs to the conversation it came from, so
// the thread carries the card, under the latest turn: a pending approval is
// always what the conversation is waiting for NOW.
//
// The SAME card as /approvals and the Code tab (`ApprovalRequestCard`): the
// agent's reason, the effect, the checklist reasons (#464), the rule chain and
// the three answers. Two renderings of one decision drift.
//
// When to read: on mount, and whenever the workspace's pending list changes.
// That list is already polled for the rail (`ApprovalsProvider`), so the card
// appears here as soon as a run of this conversation starts waiting, with no
// polling of its own. Questions (`kind = 'question'`) are #465's own block.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listApprovalsAction, type ApprovalRow } from '@/lib/actions.ts';
import { useApprovals } from '@/components/ApprovalsProvider';
import ApprovalRequestCard from '@/app/(dashboard)/approvals/ApprovalRequestCard.tsx';
import { APPROVALS_READ_LIMIT } from '@/lib/approvals-window.ts';

export default function ConversationApprovals({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const { pending } = useApprovals();
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  // Answered from this card: never shown again, even by a read that left
  // before the answer and lands after it (review of PR #482, Reviewer A).
  const answered = useRef(new Set<string>());
  // What changes when a request appears or is answered anywhere in the
  // workspace: the ids. A new string is a reason to re-read, the same one is not.
  const pendingKey = pending
    .map((p) => p.id)
    .sort()
    .join(',');
  // The rail's list stops at APPROVALS_READ_LIMIT. Once it is full, a request
  // of this conversation can be answered elsewhere without that list changing
  // (review of PR #482, Reviewer A): every poll is then a reason to re-read.
  // `pending` is a new array on each poll.
  const readKey: unknown = pending.length >= APPROVALS_READ_LIMIT ? pending : pendingKey;

  useEffect(() => {
    let current = true;
    void listApprovalsAction({ status: 'pending', conversationId }).then((result) => {
      if (!current) return;
      // A failed read keeps what is shown and says so, never an empty thread.
      if (!result.ok) {
        console.warn(
          '[ConversationApprovals] could not read the pending approvals',
          result.message,
        );
        return;
      }
      // Everything but the questions, which are #465's own block.
      setApprovals(result.data.filter((a) => a.kind !== 'question' && !answered.current.has(a.id)));
    });
    return () => {
      current = false;
    };
  }, [conversationId, readKey]);

  if (approvals.length === 0) return null;

  return (
    <div
      className="mx-auto flex max-w-[760px] flex-col gap-3 pt-6"
      data-testid="conversation-approvals"
    >
      {approvals.map((approval) => (
        <ApprovalRequestCard
          key={approval.id}
          approval={approval}
          onResolved={() => {
            // Answered: the card leaves, and the run's next steps follow in the
            // thread, re-read from the server.
            answered.current.add(approval.id);
            setApprovals((prev) => prev.filter((a) => a.id !== approval.id));
            router.refresh();
          }}
        />
      ))}
    </div>
  );
}
