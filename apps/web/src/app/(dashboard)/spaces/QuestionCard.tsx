'use client';

import { useTransition } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { resolveApprovalAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { useApprovals } from '@/components/ApprovalsProvider';

export interface QuestionCardProps {
  /**
   * La question, telle que l'agent l'a écrite. Un `ReactNode` : le fil y met
   * du markdown RENDU, composé côté serveur. La carte est cliente (elle
   * répond) ; parser le markdown ici embarquerait remark dans le navigateur
   * pour une phrase.
   */
  prompt: ReactNode;
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
 * Forme de la maquette (P2bis) : un cadre encré, sans en-tête. Une question
 * n'a pas besoin qu'on lui écrive « Question » au-dessus — le point
 * d'interrogation et les boutons le disent, et le bandeau la faisait
 * ressembler aux cartes de résultat qui l'entourent alors qu'elle est la seule
 * chose du fil qui attend le lecteur.
 *
 * Trois états, et un seul est interactif. En attente : la question, ses
 * options en boutons, et la pastille qui dit qu'on attend. Répondue : l'option
 * retenue en pastille, les autres en retrait. Déclinée : dit comme tel, avec
 * la raison si elle a été donnée.
 */
export default function QuestionCard({ prompt, options, question }: QuestionCardProps) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  // Une question du fil compte dans la pastille du rail comme celle de la page
  // Approvals : y répondre ICI doit la faire tomber ICI. `router.refresh()` ne
  // suffit pas — il refait le rendu serveur du fil, et `ApprovalsProvider` est
  // un état client que seule sa relecture met à jour (sinon : 15 s de barre qui
  // réclame une réponse déjà donnée).
  const { refresh } = useApprovals();
  const status = question?.status ?? null;
  const answer = question?.answer ?? null;
  const waiting = status === 'pending' && question !== null;

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
      // Et la barre, qui compte les attentes côté client.
      await refresh();
    });
  }

  return (
    <div className="rounded-xl border border-run bg-canvas px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-medium-14 text-ink">{prompt}</div>
        {/* L'état est dit en capitales, pas en pastille (P2bis) : la question
            est déjà cerclée de bleu — une seconde pastille bleue par-dessus
            criait deux fois la même chose. */}
        {waiting && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-run" />
            <span className="text-mono-11-caps text-run">Waiting</span>
          </span>
        )}
        {answer !== null && <span className="shrink-0 text-mono-11-caps text-ok">Answered</span>}
      </div>

      {waiting ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {options.map((option) => (
            <PrimaryButton
              key={option}
              variant="neutral"
              size="sm"
              onClick={() => answerWith(option)}
              disabled={isPending}
            >
              {option}
            </PrimaryButton>
          ))}
        </div>
      ) : (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {options.map((option) =>
            option === answer ? (
              <span
                key={option}
                className="inline-flex h-[30px] items-center rounded-lg bg-ok-bg px-3.5 text-medium-13 text-ok"
              >
                ✓ {option}
              </span>
            ) : (
              <span key={option} className="text-body-12 text-ink-4">
                {option}
              </span>
            ),
          )}
        </div>
      )}

      {status === 'rejected' && (
        <p className="mt-3 text-body-12 text-ink-3">
          Declined{question?.notes ? ` · ${question.notes}` : ''}
        </p>
      )}
      {question === null && (
        <p className="mt-3 text-body-12 text-ink-4">Answer it from the Approvals page.</p>
      )}
    </div>
  );
}
