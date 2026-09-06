'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { resolveApprovalAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextArea from '@/components/ui/TextArea';

interface Props {
  approvalId: string;
  /** Les options de l'agent, dans SON ordre — la première est mise en avant. */
  options: string[];
}

/**
 * Decision surface for one pending QUESTION (P10a).
 *
 * Deliberately NOT the approval ladder next door. There is no "always" here,
 * and there must never be: a standing rule on a question would mean "answer
 * this the same way forever", which is not a permission anyone grants — it is
 * a decision made once, in advance, for questions nobody has read yet.
 *
 * What it offers is what the agent offered: one button per option, plus
 * "Decline" for the case where the right answer is none of them. Declining
 * resumes the job on the ordinary rejection path, so the agent is told and
 * adapts, rather than being handed an option it would treat as chosen.
 */
export default function QuestionActions({ approvalId, options }: Props) {
  const [isPending, startTransition] = useTransition();
  const [showDeclineInput, setShowDeclineInput] = useState(false);
  const [notes, setNotes] = useState('');

  function handleAnswer(option: string) {
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: approvalId,
        decision: 'approve',
        answer: option,
      });
      if (!r.ok) toast.error(r.message);
      else toast.success(`Answered: ${option}`);
    });
  }

  function handleDecline() {
    if (!showDeclineInput) {
      setShowDeclineInput(true);
      return;
    }
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: approvalId,
        decision: 'reject',
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Declined');
        setShowDeclineInput(false);
        setNotes('');
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {options.map((option, i) => (
          <PrimaryButton
            key={option}
            variant={i === 0 ? 'ink' : 'neutral'}
            size="sm"
            onClick={() => handleAnswer(option)}
            disabled={isPending}
            className="!text-xs"
          >
            {option}
          </PrimaryButton>
        ))}

        <PrimaryButton
          variant="danger"
          size="sm"
          onClick={handleDecline}
          disabled={isPending}
          className="!text-xs"
        >
          {showDeclineInput ? 'Confirm decline' : 'Decline'}
        </PrimaryButton>

        {showDeclineInput && (
          <PrimaryButton
            variant="neutral"
            size="sm"
            className="!border-0 !bg-transparent !text-ink-3 hover:!text-ink"
            onClick={() => {
              setShowDeclineInput(false);
              setNotes('');
            }}
          >
            Cancel
          </PrimaryButton>
        )}
      </div>

      {showDeclineInput && (
        <TextArea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Why none of these fits (optional, sent to the agent)"
          rows={2}
          maxLength={500}
          className="!resize-none !bg-canvas text-xs"
        />
      )}
    </div>
  );
}
