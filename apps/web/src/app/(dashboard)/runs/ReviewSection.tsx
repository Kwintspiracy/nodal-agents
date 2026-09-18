'use client';

// ReviewSection — ce que la RELECTURE a dit de ce run (#135, tableau du 18/09).
//
// Une ligne repliée d'abord : le verdict d'ensemble, le résumé du dernier, et
// le compte. Ouverte, chaque verdict avec ses constats — fichier:ligne,
// gravité, ce qui ne va pas. Le rendu vient du détail Code (`VerdictsSection`
// de CodeProcessDetail), et il prend ici la forme du tableau ; la PR qui
// déménagera /code/[id] sur cette page lui passera les mêmes verdicts, d'où le
// type d'entrée emprunté à la lib Code plutôt qu'un type jumeau.
//
// Un run d'automatisation n'a pas de relecture : la ligne se dessine quand
// même, muette et non dépliable. Une section absente laisserait croire que la
// relecture n'existe pas sur cet écran ; « 0 verdicts » dit qu'il n'y en a pas
// eu (invariant #4 — jamais silencieux).

import { useState } from 'react';
import type { CodingVerdictView } from '@/lib/actions.ts';
import DisclosureButton from '@/components/ui/DisclosureButton';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';

/** Le statut condensé d'une relecture — lisible en une demi-seconde. */
function verdictStatus(
  verdicts: readonly CodingVerdictView[],
  reviewing: boolean,
): { variant: StatusVariant; label: string } | null {
  if (verdicts.length === 0) {
    return reviewing ? { variant: 'run', label: 'Review in progress' } : null;
  }
  const last = verdicts[verdicts.length - 1]!;
  return last.verdict === 'approve'
    ? { variant: 'done', label: 'Approve' }
    : { variant: 'warn', label: 'Request changes' };
}

export default function ReviewSection({
  verdicts,
  reviewing = false,
}: {
  verdicts: readonly CodingVerdictView[];
  /** true quand une relecture est EN COURS : la ligne le dit sans verdict. */
  reviewing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = verdictStatus(verdicts, reviewing);
  const last = verdicts[verdicts.length - 1] ?? null;
  const openable = verdicts.length > 0;

  return (
    <div
      className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
      data-testid="review-section"
    >
      <DisclosureButton
        open={open}
        onClick={() => openable && setOpen((v) => !v)}
        inset="tight"
        testId="review-row"
      >
        <span className="shrink-0 text-mono-11 tracking-wider text-ink-4 uppercase">Review</span>
        {status !== null && <StatusPill variant={status.variant} label={status.label} />}
        {openable ? (
          last?.summary !== null && last?.summary !== undefined && last.summary !== '' && !open ? (
            <span className="min-w-0 truncate text-body-13 text-ink-3">{last.summary}</span>
          ) : null
        ) : (
          <span className="min-w-0 truncate text-body-13 text-ink-3">No review on this run</span>
        )}
        <span className="ml-auto shrink-0 text-mono-11 text-ink-4">
          {verdicts.length} {verdicts.length === 1 ? 'verdict' : 'verdicts'}
        </span>
      </DisclosureButton>
      {open && (
        <div className="space-y-3 border-t border-rule-2 px-4 py-4">
          {verdicts.map((verdict, i) => (
            <VerdictCard key={i} verdict={verdict} />
          ))}
        </div>
      )}
    </div>
  );
}

function VerdictCard({ verdict }: { verdict: CodingVerdictView }) {
  const approved = verdict.verdict === 'approve';
  return (
    <div className="space-y-2" data-testid="review-verdict">
      <StatusPill
        variant={approved ? 'done' : 'warn'}
        label={approved ? 'Approve' : (verdict.verdict ?? 'Request changes')}
      />
      {verdict.summary && <p className="text-body-13 text-ink-2">{verdict.summary}</p>}
      {verdict.findings.length > 0 && (
        <ul className="space-y-1.5">
          {verdict.findings.map((f, i) => (
            <li key={i} className="rounded-md border border-rule-2 px-3 py-2 text-body-13">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-mono-12 text-ink-3">
                  {f.file ?? 'Unknown file'}
                  {f.line ? `:${f.line}` : ''}
                </span>
                {f.severity && <MonoMicroTag tone="warn">{f.severity}</MonoMicroTag>}
              </div>
              {f.issue && <p className="mt-1 text-ink-2">{f.issue}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
