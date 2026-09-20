import type { ReactNode } from 'react';

type Props = {
  /** Brand / type glyph (use the `Disc` primitive). */
  glyph?: ReactNode;
  /** Bold primary label — may include trailing chips/PN via composition. */
  name: ReactNode;
  /** Secondary line under the name — descriptions, scope tags, etc. */
  description?: ReactNode;
  /** Trailing mono-style metadata (part-number, latency, "last 4m"…). */
  meta?: ReactNode;
  /** Right-edge action cluster — typically `<IcBtn>` settings / remove. */
  actions?: ReactNode;
  /** Optional revealed-on-expand body rendered under the row, separated by
   *  a border-top + bg-canvas/40 pad (per the handoff's `.ed-row[expanded]`
   *  treatment used for per-op whitelisting). */
  expanded?: ReactNode;
  className?: string;
};

/**
 * EdRow — canonical `.ed-row` row used inside the Agent Composer
 * (`screen-composer-v2.jsx`) for Skills, Connectors, Knowledge and Runs
 * tabs. Always rendered as a flex row with optional glyph / name /
 * description / trailing meta / actions, plus an optional expanded body
 * for sub-grids (e.g. per-operation whitelist).
 *
 * Compose with `Disc` (variant + shape="square") for the glyph slot so
 * brand colours stay consistent with /connectors and /skills.
 */
export default function EdRow({
  glyph,
  name,
  description,
  meta,
  actions,
  expanded,
  className = '',
}: Props) {
  return (
    /* Ancre stable (issue #55). Deux parcours remontaient à cette ligne par
       `[class*="rounded-[10px]"]` — un rayon de bordure pris pour une
       structure. Il suffisait de changer le rayon pour les rendre muets. */
    <div
      data-testid="ed-row"
      className={`overflow-hidden rounded-[10px] border border-rule-2 bg-paper ${className}`}
    >
      {/* ⚠️ LA RANGÉE SE REPLIE QUAND ELLE EST ÉTROITE (issue #310), et c'est le
          COMPOSANT qui le décide, pas l'appelant. Dans la grille de trois
          cartes de l'onglet Overview, une carte fait moins de 300 px : le nom
          n'avait alors plus la place de tenir sur une ligne, débordait de sa
          colonne — rien ne la coupait — et sa deuxième ligne se dessinait
          PAR-DESSUS la méta et le bouton d'à côté.

          Trois choses le règlent ensemble, et il faut les trois :

            - `flex-wrap` : quand la somme des bases dépasse la largeur, la
              méta et les actions passent SOUS le nom au lieu de rester à
              côté de lui. C'est ce que l'issue demande à l'œil.
            - une BASE de 10 rem sur la colonne du nom (`flex-[1_1_10rem]`) :
              sans base, `flex-1` vaut `flex: 1 1 0%` et la colonne se laisse
              écraser à zéro, donc rien ne se replie jamais et le texte
              déborde. La base est ce qui DÉCLENCHE le repli.
            - `break-words` sur le NOM, et sur lui seul : sa colonne, elle,
              rétrécit (`min-w-0`), donc un mot unique plus long qu'elle — un
              identifiant, une URL — y déborderait encore, repli ou pas.

          Large, rien ne change : tout tient sur une ligne, comme la planche
          le dessine. Mesuré à 900 px, avec et sans méta : les quatre boîtes
          tombent au pixel près là où elles tombaient avant. Le `ml-auto` des
          actions n'y joue AUCUN rôle — la colonne du nom grandit et les pousse
          déjà au bord droit ; il ne sert que sur la SECONDE ligne d'une rangée
          repliée, où il renvoie les actions à droite de la méta. */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-4 py-3.5">
        {glyph && <div className="flex-shrink-0">{glyph}</div>}
        <div className="min-w-0 flex-[1_1_10rem]">
          <div className="text-medium-14 leading-[1.2]! break-words text-ink">{name}</div>
          {description && (
            <div
              className="mt-0.5 truncate text-body-13 leading-[1.3]! text-ink-3"
              // La description se COUPE depuis toujours ; l'infobulle rend le
              // texte entier, et le composant la pose seul quand la
              // description est du texte. Un `ReactNode` composé n'en a pas :
              // on n'invente pas une chaîne à partir d'un arbre React.
              title={typeof description === 'string' ? description : undefined}
            >
              {description}
            </div>
          )}
        </div>
        {meta && (
          // La méta garde sa largeur (`flex-shrink-0`) : sa boîte fait toujours
          // la taille de son contenu. Lui poser `break-words` ne servirait donc
          // à rien — la classe ne se déclencherait jamais (passe 1 de la revue).
          // Un slug plus long que la carte entière est coupé par
          // l'`overflow-hidden` de la rangée, et il n'y en a pas dans le
          // produit : un slug est un mot court, par construction.
          <div className="flex-shrink-0 text-mono-11 tracking-[0.04em] text-ink-4">{meta}</div>
        )}
        {actions && <div className="ml-auto flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-rule-2 bg-canvas/40 px-4 py-3">{expanded}</div>
      )}
    </div>
  );
}

/**
 * IcBtn — the small icon button used at the right edge of an EdRow.
 * Matches `.ic-btn` in the handoff: 28×28, rounded, ghost-style with
 * subtle hover. Pass a child SVG sized 11–13px.
 */
export function IcBtn({
  onClick,
  title,
  children,
  ariaLabel,
}: {
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-rule text-ink-3 transition-colors hover:bg-hover hover:text-ink"
    >
      {children}
    </button>
  );
}
