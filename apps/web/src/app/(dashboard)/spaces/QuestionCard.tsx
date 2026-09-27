'use client';

import { useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CaretRight, PencilSimple } from '@phosphor-icons/react';
import { resolveApprovalAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import ChoiceTile from '@/components/ui/ChoiceTile';
import TextArea from '@/components/ui/TextArea';
import { useApprovals } from '@/components/ApprovalsProvider';

/**
 * La ligne de la PLATEFORME (#465), sous celles de l'agent : répondre dans ses
 * propres mots. Copie d'écran, côté web : l'agent n'écrit plus cette option,
 * et « Autre chose, je t'explique » cliqué renvoyait jusqu'ici ce libellé seul,
 * sans endroit où expliquer quoi que ce soit (job 30e00821, 23/09).
 */
export const SOMETHING_ELSE_LABEL = "Something else, I'll explain";

/** La borne du runner (`FREE_ANSWER_MAX`, approvals/resolve.ts). */
const FREE_ANSWER_MAX = 2000;

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
 * Trois états, et un seul est interactif. En attente : la question, UNE LIGNE
 * par option de l'agent, puis la ligne de la plateforme qui ouvre un champ en
 * place (#465) ; et la pastille qui dit qu'on attend. Répondue : la réponse
 * retenue en pastille (une option, ou le texte écrit), les options en retrait.
 * Déclinée : dit comme tel, avec la raison si elle a été donnée.
 *
 * C'est la SEULE surface qui répond à une question : le fil et la page du run
 * la portent, la page Approvals et le rail renvoient ici (#465).
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
  const [explaining, setExplaining] = useState(false);
  const [text, setText] = useState('');

  /** `free` : la personne a écrit sa réponse, ce n'est aucune option (#465). */
  function answerWith(answer: string, free: boolean) {
    if (!question) return;
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: question.approvalRequestId,
        decision: 'approve',
        answer,
        ...(free ? { free: true } : {}),
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(free ? 'Answered' : `Answered: ${answer}`);
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
        <>
          <ul className="mt-3.5 flex flex-col gap-2">
            {options.map((option) => (
              <li key={option} data-testid="question-answer-row">
                <ChoiceTile
                  icon={<CaretRight size={14} className="text-ink-3" />}
                  label={option}
                  onClick={() => answerWith(option, false)}
                  disabled={isPending}
                  className="w-full"
                />
              </li>
            ))}
            <li data-testid="question-answer-row">
              <ChoiceTile
                icon={<PencilSimple size={14} className="text-ink-3" />}
                label={SOMETHING_ELSE_LABEL}
                onClick={() => setExplaining(true)}
                disabled={isPending}
                className="w-full"
              />
            </li>
          </ul>
          {explaining && (
            <div className="mt-2 flex flex-col gap-2">
              <TextArea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={FREE_ANSWER_MAX}
                autoFocus
                aria-label="Your answer"
              />
              <div className="flex justify-end">
                <PrimaryButton
                  variant="ink"
                  size="sm"
                  onClick={() => answerWith(text.trim(), true)}
                  disabled={isPending || text.trim() === ''}
                >
                  Send
                </PrimaryButton>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {answer !== null && !options.includes(answer) && (
            <span className="inline-flex min-h-[30px] items-center rounded-lg bg-ok-bg px-3.5 py-1 text-medium-13 text-ok">
              ✓ {answer}
            </span>
          )}
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
        <p className="mt-3 text-body-12 text-ink-4">Open the run that asked it to answer.</p>
      )}
    </div>
  );
}
