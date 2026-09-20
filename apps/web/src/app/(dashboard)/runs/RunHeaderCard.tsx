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

import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import CopyButton from '@/components/ui/CopyButton';
import { plainText } from '@/components/Markdown.tsx';
import { truncate } from '@/lib/format-time';
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
}) {
  // Le titre est la PREMIÈRE LIGNE de la demande, à plat et COUPÉE à soixante
  // caractères — la règle que les trois routes appliquent déjà à l'en-tête de
  // page. `plainText` rend la première ligne ; sans la coupe, une demande d'un
  // seul paragraphe de trois cents caractères passait entière dans la ligne de
  // faits et repoussait l'agent, l'origine et l'état à la ligne suivante
  // (Reviewer C, passe 1). Le texte entier reste juste dessous, et au survol.
  const firstLine = plainText(task);
  const title = truncate(firstLine, 60);
  return (
    <div className="space-y-4 rounded-xl border border-rule-2 bg-paper p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 text-medium-15 text-ink" title={firstLine}>
          {title}
        </span>
        {agentName !== null && agentName !== '' && (
          <MonoMicroTag tone="agent">{agentName}</MonoMicroTag>
        )}
        <span className="text-mono-11 text-ink-4">{origin}</span>
        {model !== null && model !== '' && (
          <span className="text-mono-11 text-feed-model">{model}</span>
        )}
        {/* PLUS D'ACTION ICI (#252). Le bouton d'arrêt tenait le bout de cette
            ligne de faits ; il vit désormais dans la rangée d'actions sous la
            barre, avec tout ce qu'une page permet de faire (règle de #242). */}
        <StatusPill variant={statusVariant} label={statusLabel} />
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
