// AutomationScreen — le DESSIN de la page d'une automatisation (planche B, #202).
//
// Séparé de la route pour une raison : la route charge, l'écran dessine, et
// c'est l'écran qu'un test peut rendre avec une automatisation VRAIMENT lue en
// base. Tout ce qui est calcul vit dans `automation-view.ts` ; il ne reste ici
// que de la mise en page.

import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import type { AgentRow, AutomationView } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import StatusPill from '@/components/ui/StatusPill';
// La `WorkBar` va être promue dans `components/ui` par une autre PR ; elle est
// importée d'ici en attendant, et l'import suivra mécaniquement.
import WorkBar from '@/app/(dashboard)/spaces/WorkBar.tsx';
import { RoutineState, ScheduleRunList } from './RunLines.tsx';
import ScheduleActions from '../ScheduleActions.tsx';
import WebhookPageActions from './WebhookPageActions.tsx';
import {
  automationFacts,
  automationName,
  automationSubtitle,
  runsBasePath,
  runsHeadline,
  seeAllHref,
  seeAllLabel,
} from './automation-view.ts';

/** Une ligne de la carte de réglages : libellé en mono espacé, valeur en 13. */
function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex flex-col gap-1 border-b border-rule-2 px-5 py-3.5 last:border-b-0 sm:flex-row sm:gap-5"
      data-testid="automation-fact"
    >
      <span className="text-mono-11-caps shrink-0 text-ink-4 sm:w-[110px]" data-testid="fact-label">
        {label}
      </span>
      <span
        className="min-w-0 flex-1 whitespace-pre-wrap text-body-13 text-ink-2"
        data-testid="fact-value"
      >
        {value}
      </span>
    </div>
  );
}

export default function AutomationScreen({
  view,
  agents,
}: {
  view: AutomationView;
  /** Pour le formulaire d'édition, celui-là même que la liste ouvre. */
  agents: AgentRow[];
}) {
  const active = view.kind === 'schedule' ? view.schedule.active : view.webhook.active;
  return (
    <PageShell
      title={automationName(view)}
      subtitle={automationSubtitle(view)}
      toolbarBleed
      // LA barre du design system (Figma 353:3378), celle du fil de chat et de
      // la page de run : le retour à gauche, le contexte à droite. La page
      // dessinait son propre lien de retour dans un `PageTopBar` — un motif de
      // plus pour une chose qui existe déjà (Quentin, 19/09/2026).
      toolbar={
        <WorkBar
          back={{ label: 'Automations', href: '/automations' }}
          agents={view.agent === null ? [] : [view.agent]}
          status={
            <StatusPill variant={active ? 'done' : 'idle'} label={active ? 'Active' : 'Paused'} />
          }
        />
      }
    >
      <div className="space-y-6">
        {/* Les actions ont leur PROPRE rangée, sous la barre : elles agissent
            sur l'automatisation, et les aligner avec le retour les aurait
            faites lire comme de la navigation (Quentin, 19/09/2026). */}
        <div className="flex justify-end" data-testid="automation-actions-row">
          {view.kind === 'schedule' ? (
            <ScheduleActions schedule={view.schedule} agents={agents} layout="page" />
          ) : (
            <WebhookPageActions webhook={view.webhook} />
          )}
        </div>

        <div
          className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
          data-testid="automation-settings"
        >
          {automationFacts(view).map((f) => (
            <FactRow key={f.label} label={f.label} value={f.value} />
          ))}
        </div>

        <section>
          <div className="mb-2 flex flex-wrap items-baseline gap-3">
            <span className="text-mono-11 text-ink-4" data-testid="runs-headline">
              {runsHeadline(view)}
            </span>
            <Link
              href={seeAllHref(view)}
              className="inline-flex items-center gap-1 text-body-12 text-ink-3 transition-colors hover:text-ink"
              data-testid="runs-see-all"
            >
              {seeAllLabel(view)}
              <ArrowRight size={12} />
            </Link>
          </div>
          {view.runs.length === 0 && (view.kind !== 'schedule' || view.state.length === 0) ? (
            <EmptyState title="No run yet. It shows up here the first time this automation fires." />
          ) : (
            <div
              className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
              data-testid="automation-runs"
            >
              {/* Ce que la routine a RETENU, au-dessus de ses runs : c'est cet
                  état qui décide s'il y aura du travail au prochain. Depuis le
                  retrait de /scheduled (#202), c'est le seul écran qui le
                  montre, et l'y perdre ferait republier une annonce déjà
                  publiée (08/09/2026). */}
              {view.kind === 'schedule' && <RoutineState entries={view.state} />}
              {view.runs.length > 0 && (
                <ScheduleRunList runs={view.runs} basePath={runsBasePath(view)} />
              )}
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
