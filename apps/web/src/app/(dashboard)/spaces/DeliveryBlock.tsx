// DeliveryBlock — le récapitulatif de livraison (P2bis).
//
// Il remplace `ProducedCard` ET la section de preuve du bas de page : ce qui a
// été livré, ce que ça a coûté, qui l'a relu et ce qui l'a éprouvé se lisent
// au même endroit, à la fin du travail qui les a produits — pas trois écrans
// plus bas, séparés de leur contexte.
//
// CE QUI N'EST PAS LÀ, ET POURQUOI. La maquette de Quentin montre six
// cellules : Fichiers, Lignes, Tests, Couverture, Durée, Coût. Cinq ont une
// source — « Lignes » se lit dans l'ENTRÉE des appels d'écriture, la même
// lecture que la page Code (`coding-changes.ts`), et c'est du churn : « +27
// −2 » veut dire vingt-sept lignes écrites et deux remplacées, pas le résultat
// d'une comparaison. « Couverture » demanderait un rapport de couverture que
// rien n'écrit : la cellule n'existe pas, pas de tiret, pas de zéro, pas de
// « n/a » (invariant #4). De même, une section « Reviews » ou « Checks » vide
// ne se dessine pas.

import { CheckCircle, XCircle } from '@phosphor-icons/react/dist/ssr';
import AgentAvatar from '@/components/ui/AgentAvatar';
import StatusPill from '@/components/ui/StatusPill';
import { plainText } from '@/components/Markdown.tsx';
import { truncate } from '@/lib/format-time';
import type { DeliverySummary } from '@/lib/conversation-feed.ts';
import { formatCost, formatMs, shortToolName } from './format.ts';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="w-[100px] shrink-0">
      <p className="text-micro-10 tracking-wider text-ink-4 uppercase">{label}</p>
      <p className="mt-0.5 text-mono-13 text-ink">{value}</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-mono-11-caps text-ink-4">{children}</p>;
}

export default function DeliveryBlock({ summary }: { summary: DeliverySummary }) {
  const { verdict } = summary;
  const stats: Array<{ label: string; value: string }> = [];
  if (summary.files > 0) stats.push({ label: 'Files', value: String(summary.files) });
  if (summary.lines !== null) {
    // L'ordre de la maquette : les fichiers, puis ce qu'ils ont pris de lignes.
    stats.push({
      label: 'Lines',
      value: [
        summary.lines.added > 0 ? `+${summary.lines.added}` : null,
        summary.lines.removed > 0 ? `−${summary.lines.removed}` : null,
      ]
        .filter((x): x is string => x !== null)
        .join(' '),
    });
  }
  if (summary.tests !== null) {
    stats.push({ label: 'Tests', value: `${summary.tests.passed} / ${summary.tests.total}` });
  }
  if (summary.durationMs !== null && summary.durationMs > 0) {
    stats.push({ label: 'Duration', value: formatMs(summary.durationMs) });
  }
  if (summary.costUsd !== null) {
    stats.push({ label: 'Cost', value: formatCost(summary.costUsd) });
  }

  // Pleine largeur, comme tout bloc du fil (#135) : la marge de 46 px poussait
  // le récapitulatif vers la droite, plus étroit que les blocs du travail
  // qu'il conclut.
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-rule bg-paper">
      <div className="flex h-[48px] items-center gap-2.5 px-4">
        <CheckCircle
          size={16}
          className={
            verdict === 'green' ? 'text-ok' : verdict === 'red' ? 'text-warn' : 'text-ink-4'
          }
          aria-hidden
        />
        <span className="text-title-15 text-ink">Delivery summary</span>
        <span className="ml-auto">
          {verdict === 'green' ? (
            <StatusPill variant="done" label="Verified" />
          ) : verdict === 'red' ? (
            <StatusPill variant="warn" label="Checks failed" />
          ) : (
            <StatusPill variant="idle" label="Not verified" />
          )}
        </span>
      </div>

      {stats.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-3 border-t border-rule-2 px-4 py-3">
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} />
          ))}
        </div>
      )}

      {summary.reviews.length > 0 && (
        <div className="border-t border-rule-2 px-4 py-3">
          <SectionLabel>Reviews</SectionLabel>
          <ul>
            {summary.reviews.map((r, i) => (
              <li key={i} className="flex items-center gap-2.5 py-1">
                {r.isAgent ? <AgentAvatar name={r.name} size="sm" shape="square" /> : null}
                <span className="shrink-0 text-medium-13 text-ink">
                  {r.isAgent ? r.name : shortToolName(r.name)}
                </span>
                <span className="ml-auto min-w-0 truncate text-body-13 text-ink-3">
                  {truncate(plainText(r.text), 60)}
                </span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.ok ? 'bg-ok' : 'bg-warn'}`}
                  aria-hidden
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.checks.length > 0 && (
        <div className="border-t border-rule-2 px-4 py-3">
          <SectionLabel>Checks</SectionLabel>
          <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {summary.checks.map((c, i) => (
              <li key={i} className="flex min-w-0 items-center gap-2">
                {c.ok ? (
                  <CheckCircle size={14} className="shrink-0 text-ok" aria-hidden />
                ) : (
                  <XCircle size={14} className="shrink-0 text-err" aria-hidden />
                )}
                <span className="min-w-0 truncate text-body-13 text-ink">{c.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
