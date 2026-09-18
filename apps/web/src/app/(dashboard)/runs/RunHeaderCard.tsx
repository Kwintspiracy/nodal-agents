// RunHeaderCard — la carte de tête d'un run (#135, tableau « Run », 18/09).
//
// Trois rangées, et rien d'autre : ce qui a été demandé, le texte entier de la
// demande, et les sept chiffres du run. Les mêmes cases que le détail Code, aux
// mêmes mots — deux écrans qui montrent le même run ne peuvent pas nommer ses
// chiffres différemment.
//
// L'origine et le modèle sont du TEXTE, pas des pastilles (Quentin, 18/09 :
// « pas de pastilles grises ») : ils se lisent comme le modèle et l'heure d'un
// en-tête de tour, où la différence entre les choses est la COULEUR.

import type { ReactNode } from 'react';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import CopyButton from '@/components/ui/CopyButton';
import { plainText } from '@/components/Markdown.tsx';
import type { RunStat } from './run-view.ts';

export default function RunHeaderCard({
  runId,
  task,
  agentName,
  origin,
  model,
  statusVariant,
  statusLabel,
  stats,
  actions = null,
}: {
  /**
   * L'identifiant du run. Il est à l'écran depuis le 18/09 : sans lui, rien
   * sur la page ne dit DE QUEL run il s'agit, et deux pages ouvertes côte à
   * côte ne se distinguaient pas (Quentin). Entier, sélectionnable, copiable.
   */
  runId: string;
  /** La demande, telle que le chargeur la rend (secrets déjà masqués). */
  task: string;
  agentName: string | null;
  /** « scheduled · <routine> », « delegated », « via Telegram »… */
  origin: string;
  /** Le modèle du run, quand les appels en nomment un. */
  model: string | null;
  statusVariant: StatusVariant;
  statusLabel?: string;
  stats: readonly RunStat[];
  /** Ce que la route ajoute au bout de la première ligne (annuler un run vivant). */
  actions?: ReactNode;
}) {
  // Le titre est la PREMIÈRE LIGNE de la demande, à plat : une demande en
  // markdown sur dix lignes ne fait pas un titre de dix lignes.
  const title = plainText(task);
  return (
    <div className="space-y-4 rounded-xl border border-rule-2 bg-paper p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 text-medium-15 text-ink">{title}</span>
        {agentName !== null && agentName !== '' && (
          <MonoMicroTag tone="agent">{agentName}</MonoMicroTag>
        )}
        <span className="text-mono-11 text-ink-4">{origin}</span>
        {model !== null && model !== '' && (
          <span className="text-mono-11 text-feed-model">{model}</span>
        )}
        <StatusPill variant={statusVariant} label={statusLabel} />
        {actions !== null && <span className="ml-auto shrink-0">{actions}</span>}
      </div>
      {/* L'IDENTITÉ du run, sous sa ligne de faits : l'identifiant entier, à
          copier d'un clic. C'est ce qu'on colle dans une commande, dans une
          issue, ou ce qu'on compare entre deux onglets. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-mono-11 text-ink-4 select-all" title={runId}>
          run {runId}
        </span>
        <CopyButton value={runId} label="Copy" successMessage="Run id copied" />
      </div>

      {/* La demande ENTIÈRE, telle qu'elle a été écrite — le détail Code la
          rend de la même façon, et à la même taille. Ses retours à la ligne
          sont gardés (`whitespace-pre-line`) : une consigne d'automatisation
          est souvent une liste, et la mettre à plat la rendrait illisible. */}
      <p className="text-body-14 leading-[1.5]! whitespace-pre-line text-ink-2">{task}</p>
      <div className="flex flex-wrap gap-2">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="min-w-[110px] flex-1 rounded-lg border border-rule-2 bg-canvas px-3 py-2"
          >
            <p className="text-mono-11 tracking-wider text-ink-4 uppercase">{stat.label}</p>
            <p className="mt-0.5 truncate text-mono-13 text-ink-2">{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
