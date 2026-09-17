// DeliveryBlock — LA CONCLUSION DU TRAVAIL (P2bis, redessiné par #135).
//
// Il remplace `ProducedCard` ET la section de preuve du bas de page : ce qui a
// été livré, ce que ça a coûté, qui l'a relu et ce qui l'a éprouvé se lisent
// au même endroit, à la fin du travail qui les a produits — pas trois écrans
// plus bas, séparés de leur contexte.
//
// #135 a changé ce qu'il DIT, pas ce qu'il compte. Le titre est le mot du
// résultat — « Delivered », pas « Delivery summary », qui nommait un encart et
// non un fait. Les fichiers ne sont plus un nombre seul : ils sont nommés, un
// par ligne. Les contrôles s'appellent « Proof ». Et le pied mène au run.
//
// CE QUI N'EST PAS LÀ, ET POURQUOI. La maquette de Quentin montre six
// cellules : Fichiers, Lignes, Tests, Couverture, Durée, Coût. Cinq ont une
// source — « Lignes » se lit dans l'ENTRÉE des appels d'écriture, la même
// lecture que la page Code (`coding-changes.ts`), et c'est du churn : « +27
// −2 » veut dire vingt-sept lignes écrites et deux remplacées, pas le résultat
// d'une comparaison. « Couverture » demanderait un rapport de couverture que
// rien n'écrit : la cellule n'existe pas, pas de tiret, pas de zéro, pas de
// « n/a » (invariant #4). De même, une section vide ne se dessine pas.
//
// La maquette écrit aussi « 3 passed » après une commande de preuve.
// `ThreadProofRun` ne porte qu'un VERDICT par commande, jamais un compte de
// cas : ces nombres ne sont donc pas écrits. Les inventer ferait dire au
// produit ce que la base ne sait pas.

import Link from 'next/link';
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  PencilSimple,
  X,
} from '@phosphor-icons/react/dist/ssr';
import AgentAvatar from '@/components/ui/AgentAvatar';
import StatusPill from '@/components/ui/StatusPill';
import type { DeliverySummary } from '@/lib/conversation-feed.ts';
import { formatCost, formatMs, shortToolName } from './format.ts';

/** Au-delà, la liste de fichiers cesse d'être lisible : on compte le reste. */
const FILES_SHOWN = 12;

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="w-[100px] shrink-0">
      <p className="text-mono-11 text-ink-4">{label}</p>
      <p className={`mt-0.5 text-medium-14 ${mono ? 'text-feed-metric' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

export default function DeliveryBlock({
  summary,
  jobId,
}: {
  summary: DeliverySummary;
  /**
   * Le travail que ce récapitulatif conclut — « Open run » y mène. `null`
   * quand l'appelant n'en a pas : le lien ne se dessine alors pas, plutôt que
   * de pointer vers une page introuvable.
   */
  jobId: string | null;
}) {
  const { verdict } = summary;
  const stats: Array<{ label: string; value: string; mono?: boolean }> = [];
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
    // La durée est une MESURE : elle porte la couleur des mesures du fil.
    stats.push({ label: 'Duration', value: formatMs(summary.durationMs), mono: true });
  }
  if (summary.costUsd !== null) {
    stats.push({ label: 'Cost', value: formatCost(summary.costUsd) });
  }

  const shownFiles = summary.filePaths.slice(0, FILES_SHOWN);
  const hiddenFiles = summary.filePaths.length - shownFiles.length;
  // Le pied ne se dessine que s'il a quelque chose à dire : personne n'a relu
  // ET aucun run à ouvrir, il n'y a pas de pied.
  const showFoot = summary.reviews.length > 0 || jobId !== null;

  // Pleine largeur, comme tout bloc du fil (#135) : la marge de 46 px poussait
  // le récapitulatif vers la droite, plus étroit que les blocs du travail
  // qu'il conclut.
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <div className="flex h-[48px] items-center gap-2.5 px-4">
        <CheckCircle
          size={16}
          className={
            verdict === 'green' ? 'text-ok' : verdict === 'red' ? 'text-warn' : 'text-ink-4'
          }
          aria-hidden
        />
        <span className="text-title-15 text-ink">Delivered</span>
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
            <Stat key={s.label} label={s.label} value={s.value} mono={s.mono ?? false} />
          ))}
        </div>
      )}

      {shownFiles.length > 0 && (
        <div className="border-t border-rule-2 px-4 py-2.5">
          <ul className="flex flex-col gap-1">
            {shownFiles.map((path) => (
              <li key={path} className="flex min-w-0 items-center gap-2">
                <PencilSimple size={12} className="shrink-0 text-ink-4" aria-hidden />
                <span className="min-w-0 truncate text-mono-12 text-feed-path">{path}</span>
              </li>
            ))}
          </ul>
          {hiddenFiles > 0 && (
            <p className="mt-1 text-mono-11 text-ink-4">… and {hiddenFiles} more</p>
          )}
        </div>
      )}

      {summary.checks.length > 0 && (
        <div className="border-t border-rule-2 px-4 pt-2.5 pb-3">
          <p className="mb-1 text-mono-11 text-ink-4">Proof</p>
          <ul className="flex flex-col gap-1">
            {summary.checks.map((c, i) => (
              <li key={i} className="flex min-w-0 items-center gap-2">
                {c.ok ? (
                  <Check size={12} className="shrink-0 text-ok" aria-hidden />
                ) : (
                  <X size={12} className="shrink-0 text-warn" aria-hidden />
                )}
                <span className="min-w-0 truncate text-mono-12 text-ink-2">{c.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showFoot && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-rule-2 px-4 pt-2.5 pb-3">
          {summary.reviews.length > 0 && (
            <span className="text-mono-11 text-ink-4">Reviewed by</span>
          )}
          {summary.reviews.map((r, i) => (
            <span key={i} className="flex items-center gap-2">
              {r.isAgent && (
                <AgentAvatar name={r.name} imageUrl={r.avatarUrl} size="sm" shape="square" />
              )}
              <span className="text-medium-13 text-ink">
                {r.isAgent ? r.name : shortToolName(r.name)}
              </span>
              {/* Une relecture qui a dit NON ne doit pas se lire comme les
                  autres. La maquette ne dessine pas ce point ; le retirer
                  effacerait le seul endroit où un refus de relecture se voit. */}
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.ok ? 'bg-ok' : 'bg-warn'}`}
                aria-hidden
              />
            </span>
          ))}
          {jobId !== null && (
            <Link
              href={`/scheduled/${jobId}`}
              className="ml-auto flex shrink-0 items-center gap-1.5 text-medium-13 text-ink-2 transition-colors hover:text-ink"
            >
              Open run
              <ArrowSquareOut size={12} aria-hidden />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
