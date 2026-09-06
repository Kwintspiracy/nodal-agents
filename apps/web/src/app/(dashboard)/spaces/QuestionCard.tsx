'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { resolveApprovalAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';

export interface QuestionCardProps {
  /** La question, telle que l'agent l'a écrite. */
  prompt: string;
  options: string[];
  /**
   * La ligne `approval_requests` de cette question, quand le fil l'a chargée.
   * null ⇒ la carte se lit, elle ne se répond pas : sans id, un bouton ne
   * résoudrait rien, et un bouton qui ne fait rien est pire qu'aucun bouton.
   */
  question: {
    approvalRequestId: string;
    status: string;
    answer: string | null;
    notes: string | null;
  } | null;
}

/**
 * La carte d'une question dans le fil (P10a) — la même que la page Approvals
 * porte, à sa place : là où l'agent l'a posée.
 *
 * Trois états, et un seul est interactif. En attente : la question et ses
 * options en boutons. Répondue : l'option retenue, mise en avant, les autres
 * en retrait — ce qui a été choisi se lit sans relire toute la liste.
 * Déclinée : dit comme tel, avec la raison si elle a été donnée.
 */
export default function QuestionCard({ prompt, options, question }: QuestionCardProps) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const status = question?.status ?? null;
  const answer = question?.answer ?? null;

  function answerWith(option: string) {
    if (!question) return;
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: question.approvalRequestId,
        decision: 'approve',
        answer: option,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`Answered: ${option}`);
      // Le fil est rendu côté serveur : sans ce rafraîchissement, la carte
      // resterait en attente jusqu'au prochain passage de LiveRefresh.
      router.refresh();
    });
  }

  return (
    <div className="max-w-[760px] overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-rule-2 bg-sidebar px-4 py-2.5">
        <span className="text-medium-13 text-ink">Question</span>
        {status !== null && status !== 'pending' && (
          <span className="text-mono-11 text-ink-4">
            {status === 'rejected' ? 'declined' : 'answered'}
          </span>
        )}
      </div>
      <div className="space-y-2.5 px-4 py-3">
        <p className="max-w-[68ch] whitespace-pre-wrap text-body-15 text-ink">{prompt}</p>

        {status === 'pending' && question !== null ? (
          <div className="flex flex-wrap gap-2">
            {options.map((option, i) => (
              <PrimaryButton
                key={option}
                variant={i === 0 ? 'ink' : 'neutral'}
                size="sm"
                onClick={() => answerWith(option)}
                disabled={isPending}
                className="!text-xs"
              >
                {option}
              </PrimaryButton>
            ))}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {options.map((option) => (
              <li
                key={option}
                className={
                  option === answer ? 'text-medium-13 text-ink' : 'text-body-12 text-ink-4'
                }
              >
                {option === answer ? `✓ ${option}` : `· ${option}`}
              </li>
            ))}
          </ul>
        )}

        {status === 'rejected' && (
          <p className="text-body-12 text-ink-3">
            Declined{question?.notes ? ` · ${question.notes}` : ''}
          </p>
        )}
        {question === null && (
          <p className="text-body-12 text-ink-4">Answer it from the Approvals page.</p>
        )}
      </div>
    </div>
  );
}
