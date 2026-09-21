'use client';

/**
 * ProofRepairSection — combien de fois un run se corrige après une preuve
 * rouge, et ce qui le borne par ailleurs (issue #377).
 *
 * Quentin, 21/09 : « il faut exposer ces réglages quelque part ». #375 avait
 * écrit la borne en dur dans le runner ; elle se règle ici, par espace.
 *
 * DEUX CHOSES SUR LA MÊME CARTE, et l'ordre compte. En haut ce qui se règle :
 * 0, 1, 2 ou 3 tours. En dessous, en lecture seule, les trois budgets
 * anti-boucle d'un run — reprises, appels d'outils par tour, profondeur de
 * délégation. Ils ne sont pas là pour décorer : régler « 3 réparations » sans
 * savoir qu'un run n'a que quinze reprises en tout, c'est régler à l'aveugle.
 *
 * LES BUDGETS VIENNENT DE L'ACTION, jamais d'un import. Ils sont lus dans
 * `DEFAULT_LIMITS` (`@nodal-agents/orchestration`), la constante que le runner
 * oppose réellement à un job ; importer ce paquet dans un composant client
 * traînerait drizzle dans le bundle du navigateur et la page ne compilerait
 * plus (piège du 20/08). Rien n'est recopié en dur ici : un écran qui répète
 * un nombre finit par dire le contraire de la machine.
 *
 * AUCUN CONFIRMDIALOG. Baisser à zéro ne rend aucun pouvoir à un agent et ne
 * casse rien : le run finit simplement avec son verdict rouge, comme avant
 * #375. Monter non plus. Ce réglage n'a pas de direction dangereuse, à la
 * différence du frein d'urgence (AutoRunPauseSection) et des surfaces sous
 * vérification (VerificationSurfacesSection), qui en ont chacune une.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { PROOF_REPAIR_ATTEMPTS_CHOICES } from '@nodal-agents/shared';
import { setProofRepairAction, type ProofRepairView } from '@/lib/actions.ts';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import SegmentedControl from '@/components/ui/SegmentedControl';

interface Props {
  initial: ProofRepairView;
}

/** Ce que chaque choix veut dire, en une ligne, sous le contrôle. */
function phrase(n: number): string {
  if (n === 0) return 'A failed proof ends the run at once, with its red verdict.';
  if (n === 1)
    return 'A failed proof reopens the run once. The agent gets the failing command and its output, fixes it, and delivers again.';
  return `A failed proof reopens the run up to ${n} times. Each turn costs another model call and another full proof.`;
}

export default function ProofRepairSection({ initial }: Props) {
  const [attempts, setAttempts] = useState(initial.repairAttempts);
  const [isPending, startTransition] = useTransition();

  function handleChange(next: string) {
    const valeur = Number(next);
    const avant = attempts;
    setAttempts(valeur);
    startTransition(async () => {
      const r = await setProofRepairAction({ repairAttempts: valeur });
      if (!r.ok) {
        toast.error(r.message);
        setAttempts(avant);
      } else {
        toast.success(
          valeur === 0
            ? 'A failed proof now ends the run at once.'
            : `A failed proof now reopens the run ${valeur === 1 ? 'once' : `up to ${valeur} times`}.`,
        );
      }
    });
  }

  const isDisabled = !initial.isOwner || isPending;

  return (
    <div className="rounded-xl border border-rule-2 bg-paper px-[18px] py-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-medium-14 text-ink">Repair turns after a failed proof</span>
            <MonoMicroTag tone="err">owner only</MonoMicroTag>
          </div>
          <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">{phrase(attempts)}</p>

          {!initial.isOwner && (
            <p className="mt-2 text-body-12 text-ink-4">
              Only the workspace owner can change this setting.
            </p>
          )}
        </div>

        <div className="mt-0.5">
          <SegmentedControl
            ariaLabel="Repair turns after a failed proof"
            value={String(attempts)}
            onChange={handleChange}
            disabled={isDisabled}
            options={PROOF_REPAIR_ATTEMPTS_CHOICES.map((n) => ({
              value: String(n),
              label: String(n),
              testId: `repair-turns-${n}`,
            }))}
          />
        </div>
      </div>

      {/* Ce qui borne un run par ailleurs. En lecture seule : ces trois-là
          vivent dans le code du runner, et les rendre modifiables demanderait
          de les faire voyager jusqu'à chaque garde. Les MONTRER suffit à ce
          que le réglage du dessus se choisisse en connaissance de cause. */}
      <div className="mt-4 border-t border-rule-2 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-medium-13 text-ink-2">What else bounds a run</span>
          <MonoMicroTag tone="ink">read only</MonoMicroTag>
        </div>
        <dl className="mt-2 grid gap-1.5" data-testid="run-budgets">
          {[
            {
              key: 'resumes',
              label: 'Resumes per run',
              value: initial.budgets.resumesPerRun,
              hint: 'Delegations picked back up, approvals answered, repair turns.',
            },
            {
              key: 'tool-calls',
              label: 'Tool calls per turn',
              value: initial.budgets.toolCallsPerTurn,
              hint: 'One model turn cannot ask for more than this.',
            },
            {
              key: 'delegation',
              label: 'Delegation depth',
              value: initial.budgets.delegationDepth,
              hint: 'An agent briefing an agent briefing an agent.',
            },
          ].map((b) => (
            <div key={b.key} className="flex items-baseline gap-3" data-testid={`budget-${b.key}`}>
              <dt className="text-body-13 text-ink-2">{b.label}</dt>
              <dd className="text-medium-13 text-ink">{b.value}</dd>
              <span className="min-w-0 truncate text-body-12 text-ink-4">{b.hint}</span>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
