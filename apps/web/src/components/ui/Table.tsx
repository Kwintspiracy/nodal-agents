import type { ReactNode, CSSProperties, MouseEventHandler } from 'react';
import Link from 'next/link';
import { CaretRight } from '@phosphor-icons/react/dist/ssr';
import AgentAvatar from './AgentAvatar';
import RowActionButton from './RowActionButton';

/**
 * Table — the canonical data-table primitive. Before this existed, 9 files
 * rendered tables with 5 different header recipes (mono-11/micro-10/legacy
 * fractional sizes, ink-3 vs ink-4, three trackings, four paddings) — the
 * MonoMicroTag story at pattern scale. One primitive, one recipe everywhere.
 *
 * Canonical choices (decision 2026-07-18, Quentin):
 *  - Header typography = the /memories header ("plus lisible"): semibold sans
 *    uppercase — anchored on the ramp token `text-label-11` (11px/15px/600)
 *    instead of the legacy fractional `text-legacy-10-5` (that fractional
 *    token was rabattu onto the canonical scale on 2026-07-19 and no longer
 *    exists).
 *  - Header colour ink-4, tracking `wider`, padding px-5 py-3.
 *  - Cells px-5 py-3.5 align-middle; rows solid rule-2 border + bg-hover on
 *    hover (the dashed variants were unified to solid).
 *  - Frame rounded-2xl border rule-2 bg-paper with horizontal scroll.
 *
 * Composition:
 *   <Table>            frame + <table>; frame={false} when the host already
 *                      provides the card (e.g. a filter toolbar above).
 *   <THead>            <thead> + its single <tr>.
 *   <Th>               header cell; align / className (responsive hiding).
 *   <Tr>               body row; interactive → cursor-pointer; hover={false}
 *                      when the host needs its own hover tone; expanded →
 *                      the row whose detail is open (aria-expanded + bg-hover).
 *   <Td>               body cell; align / top (align-top) / className.
 *   <TableSegmentRow>  full-width group header (dot + label + count), the
 *                      provenance-segment pattern from /skills.
 *
 * Ce qui va DANS une cellule (#522, 27/09/2026). Jusque-là le cadre était
 * partagé et le contenu non : chaque table rebâtissait sa cellule d'agent, ses
 * nombres, sa ligne dépliée et sa pagination, chacune à sa façon (les nombres
 * étaient `font-mono text-xs text-ink-3` dans Logs, `text-mono-12 text-ink-4`
 * dans Runs). Une recette par sorte de cellule, et une seule :
 *
 *   <CellTitle>        l'identité de la ligne : medium-13 ink, tronqué, avec un
 *                      visuel en tête (`lead`), une ligne `meta` (mono-11 ink-4)
 *                      ou une `description` (body-12 ink-3, deux lignes).
 *   <CellAgent>        un agent, partout pareil : avatar rond md + CellTitle.
 *   <CellText>         une valeur écrite : body-13 ink-2, lien possible, `meta`
 *                      possible ; `quiet` = la recette description (body-12
 *                      ink-3) pour un aperçu secondaire.
 *   <CellMono>         un nombre, une durée, un coût, une date, un identifiant :
 *                      mono-12 ink-3, chiffres tabulaires. Aligné à droite par
 *                      le <Td align="right"> quand c'est une quantité.
 *   <CellMuted>        la valeur en retrait : une absence (« none »,
 *                      « Unassigned ») ou un fait discret sous une autre
 *                      valeur ; mono-11 ink-4, la recette de `meta`.
 *   <CellActions>      les boutons de ligne, collés à droite, gap-2.
 *   <CellChevron>      le chevron d'une ligne qui se déplie.
 *   <TableDetailRow>   la ligne dépliée : fond canvas, en-tête à la recette de
 *                      <Th> (label-11 majuscules ink-4), action à droite.
 *   <TableDetailNote>  une phrase d'état dans une ligne dépliée (vide,
 *                      chargement) : body-13 ink-4.
 *   <TablePagination>  « Page N » + Previous / Next, en RowActionButton.
 *
 * Règle d'alignement, une seule : les cellules sont centrées verticalement.
 * `top` n'existe que pour les lignes dont une cellule GRANDIT sur place (le
 * fait déplié d'une mémoire) : les autres cellules restent alors en haut au lieu
 * de se recentrer, et le visuel en tête d'une CellTitle / CellText suit.
 *
 * La typographie d'une cellule ne s'écrit plus dans les pages : la règle
 * `no-restricted-syntax` de `apps/web/eslint.config.mjs` refuse toute classe de
 * texte (taille, graisse, police, interlignage, couleur) dans l'arbre d'un
 * <Td> ou d'un <Th> hors de `components/ui/`, et tout <table>/<thead>/<tr>/
 * <td>/<th> écrit à la main.
 */

export default function Table({
  children,
  frame = true,
  className = '',
}: {
  children: ReactNode;
  /** false = bare <table> for hosts that already draw the card. */
  frame?: boolean;
  className?: string;
}) {
  const table = (
    <table className={`w-full border-collapse text-body-13 text-ink-2 ${className}`}>
      {children}
    </table>
  );
  if (!frame) return table;
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
      <div className="overflow-x-auto">{table}</div>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr>{children}</tr>
    </thead>
  );
}

export function Th({
  children,
  align = 'left',
  className = '',
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`border-b border-rule-2 px-5 py-3 text-label-11 uppercase tracking-wider whitespace-nowrap text-ink-4 ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className}`}
    >
      {children}
    </th>
  );
}

export function Tr({
  children,
  interactive = false,
  hover = true,
  className = '',
  onClick,
  title,
  style,
  expanded,
  'data-testid': dataTestid,
}: {
  children: ReactNode;
  /** Adds cursor-pointer for clickable rows. */
  interactive?: boolean;
  /**
   * La ligne se déplie (une <TableDetailRow> la suit quand c'est vrai) :
   * `aria-expanded`, et le fond `bg-hover` qui la relie à son détail ouvert.
   * `undefined` = une ligne qui ne se déplie pas.
   */
  expanded?: boolean;
  /** false when the host applies its own hover tone (avoids hover:bg conflicts). */
  hover?: boolean;
  className?: string;
  onClick?: MouseEventHandler<HTMLTableRowElement>;
  title?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}) {
  return (
    <tr
      onClick={onClick}
      title={title}
      style={style}
      aria-expanded={expanded}
      data-testid={dataTestid}
      className={`border-b border-rule-2 transition-colors last:border-0 ${
        expanded === true ? 'bg-hover' : hover ? 'hover:bg-hover' : ''
      } ${interactive ? 'cursor-pointer' : ''} ${className}`}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  align = 'left',
  top = false,
  colSpan,
  className = '',
  onClick,
  style,
  'data-testid': dataTestid,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  /** align-top for rows whose first cell can grow (e.g. expandable text). */
  top?: boolean;
  colSpan?: number;
  className?: string;
  onClick?: MouseEventHandler<HTMLTableCellElement>;
  style?: CSSProperties;
  /** Comme sur <Tr> : une cellule qu'un parcours ou un test doit pouvoir viser. */
  'data-testid'?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      onClick={onClick}
      style={style}
      data-testid={dataTestid}
      className={`px-5 py-3.5 ${top ? 'align-top' : 'align-middle'} ${
        align === 'right' ? 'text-right' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * Full-width group header row — the provenance-segment pattern from /skills:
 * coloured dot (category grammar, like the sidebar) + medium-13 label + count.
 */
export function TableSegmentRow({
  label,
  count,
  dot,
  colSpan,
}: {
  label: string;
  count: number;
  /** Background utility for the dot, e.g. "bg-skill-vivid". */
  dot: string;
  colSpan: number;
}) {
  return (
    <tr className="border-b border-rule-2 bg-canvas/40">
      <td colSpan={colSpan} className="px-5 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
          <span className="text-medium-13 text-ink">{label}</span>
          <span className="text-mono-11 text-ink-4">{count}</span>
        </div>
      </td>
    </tr>
  );
}

// ─── Le contenu des cellules (#522) ─────────────────────────────────────────

/**
 * La mise en page commune d'une cellule à deux étages : un visuel en tête
 * (avatar, disque), puis la valeur et sa ligne d'appoint. Centré sur la ligne ;
 * en haut quand la ligne est `top` et que la pile a une seconde ligne (voir la
 * règle d'alignement plus haut) : c'est la cellule qui suit sa ligne, pas
 * l'appelant qui choisit.
 */
function CellStack({
  kind,
  lead,
  children,
  meta,
  description,
}: {
  /** Le nom de la recette, posé en `data-cell` : la passe de conformité s'y lit. */
  kind: 'title' | 'agent' | 'text';
  lead?: ReactNode;
  children: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
}) {
  const hasLead = lead !== undefined && lead !== null;
  const body = (
    <div className="min-w-0" data-cell={hasLead ? undefined : kind}>
      {children}
      {meta !== undefined && meta !== null && (
        // Repliée à la ligne, jamais coupée : une date, un nombre d'accès, un
        // slug y sont des faits, et un « … » les cacherait.
        <div data-cell-part="meta" className="break-words text-mono-11 text-ink-4">
          {meta}
        </div>
      )}
      {description !== undefined && description !== null && (
        // Coupée à deux lignes : l'infobulle rend le texte entier.
        <div
          data-cell-part="description"
          title={typeof description === 'string' ? description : undefined}
          className="line-clamp-2 max-w-[460px] text-body-12 text-ink-3"
        >
          {description}
        </div>
      )}
    </div>
  );
  if (!hasLead) return body;
  // Une seule ligne se centre sur son visuel ; une pile de plusieurs lignes,
  // dans une ligne `top`, s'aligne en haut avec lui.
  const secondLine =
    (meta !== undefined && meta !== null) || (description !== undefined && description !== null);
  return (
    <div
      data-cell={kind}
      className={`flex items-center gap-2.5 ${secondLine ? '[.align-top_&]:items-start' : ''}`}
    >
      <span data-cell-part="lead" className="inline-flex shrink-0">
        {lead}
      </span>
      {body}
    </div>
  );
}

/** L'identité de la ligne : ce que la ligne EST (un skill, un serveur, un agent). */
export function CellTitle({
  children,
  lead,
  meta,
  description,
  badge,
  href,
  title,
  kind = 'title',
}: {
  /** Le nom. */
  children: ReactNode;
  /** Le visuel en tête : AgentAvatar, Disc… */
  lead?: ReactNode;
  /** Une seconde ligne de donnée : slug, type, identifiant (mono-11 ink-4). */
  meta?: ReactNode;
  /** Une seconde ligne de prose : la description (body-12 ink-3, deux lignes). */
  description?: ReactNode;
  /** Une pastille collée au nom (« Update available »). */
  badge?: ReactNode;
  /** Le nom mène quelque part. */
  href?: string;
  /** Infobulle du nom, quand il est tronqué. */
  title?: string;
  /** @internal CellAgent se nomme lui-même ; aucun autre appelant ne le passe. */
  kind?: 'title' | 'agent';
}) {
  const name = href ? (
    <Link
      href={href}
      title={title}
      data-cell-part="value"
      className="truncate text-medium-13 text-ink transition-colors hover:underline"
    >
      {children}
    </Link>
  ) : (
    <span title={title} data-cell-part="value" className="truncate text-medium-13 text-ink">
      {children}
    </span>
  );
  return (
    <CellStack kind={kind} lead={lead} meta={meta} description={description}>
      <div className="flex min-w-0 items-center gap-1.5">
        {name}
        {badge}
      </div>
    </CellStack>
  );
}

/**
 * Un agent, dans n'importe quelle table : l'avatar rond `md` et le nom à la
 * recette de CellTitle. Un agent inconnu (ligne orpheline) se DIT « Unknown »
 * à la recette de CellMuted, sans avatar inventé.
 */
export function CellAgent({
  name,
  imageUrl,
  meta,
  href,
}: {
  name: string | null;
  imageUrl?: string | null;
  /** Le slug, quand la table le montre. */
  meta?: ReactNode;
  href?: string;
}) {
  if (name === null) return <CellMuted>Unknown</CellMuted>;
  return (
    <CellTitle
      kind="agent"
      lead={<AgentAvatar name={name} imageUrl={imageUrl} size="md" shape="round" />}
      meta={meta}
      href={href}
    >
      {name}
    </CellTitle>
  );
}

/** Une valeur écrite : un compte, une tâche, le nom d'un chat. */
export function CellText({
  children,
  lead,
  meta,
  href,
  title,
  clamp = false,
  quiet = false,
}: {
  children: ReactNode;
  lead?: ReactNode;
  /** Une seconde ligne de donnée (mono-11 ink-4). */
  meta?: ReactNode;
  href?: string;
  /** Infobulle : le texte entier quand `clamp` le coupe. */
  title?: string;
  /** Une seule ligne, coupée. */
  clamp?: boolean;
  /** Un aperçu secondaire : la recette description (body-12 ink-3). */
  quiet?: boolean;
}) {
  const type = quiet ? 'text-body-12 text-ink-3' : 'text-body-13 text-ink-2';
  const cut = clamp ? 'line-clamp-1' : 'break-words';
  const text = href ? (
    <Link
      href={href}
      title={title}
      data-cell-part={quiet ? 'quiet' : 'value'}
      className={`block ${cut} ${type} transition-colors hover:text-ink`}
    >
      {children}
    </Link>
  ) : (
    <div title={title} data-cell-part={quiet ? 'quiet' : 'value'} className={`${cut} ${type}`}>
      {children}
    </div>
  );
  return (
    <CellStack kind="text" lead={lead} meta={meta}>
      {text}
    </CellStack>
  );
}

/** Un nombre, une durée, un coût, une date, un identifiant. */
export function CellMono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      data-cell="mono"
      className="whitespace-nowrap text-mono-12 text-ink-3 tabular-nums"
    >
      {children}
    </span>
  );
}

/**
 * La valeur en retrait : une absence dite en un mot (« none », « Unassigned »),
 * ou un fait discret sous une autre valeur (l'expiration sous un statut). La
 * recette de la ligne `meta`, seule.
 */
export function CellMuted({ children }: { children: ReactNode }) {
  return (
    <span data-cell="muted" className="whitespace-nowrap text-mono-11 text-ink-4">
      {children}
    </span>
  );
}

/** Les actions de la ligne (RowActionButton carrés), collées à droite. */
export function CellActions({ children }: { children: ReactNode }) {
  return (
    <div data-cell="actions" className="flex items-center justify-end gap-2">
      {children}
    </div>
  );
}

/** Le chevron d'une ligne qui se déplie ; tourne quand elle est ouverte. */
export function CellChevron({ expanded }: { expanded: boolean }) {
  return (
    <CaretRight
      size={12}
      aria-hidden
      className={`text-ink-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
    />
  );
}

/**
 * La ligne dépliée sous une <Tr expanded> : pleine largeur, fond canvas, un
 * en-tête à la recette de <Th> et une action à droite (un RowActionButton).
 * Sans `label` ni `action`, elle porte une notice attachée à la ligne du
 * dessus (un identifiant illisible), sans en-tête.
 */
export function TableDetailRow({
  colSpan,
  label,
  action,
  children,
  'data-testid': dataTestid,
}: {
  colSpan: number;
  label?: string;
  action?: ReactNode;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <tr data-testid={dataTestid} className="border-b border-rule-2 bg-canvas last:border-0">
      <td colSpan={colSpan} className="px-5 py-4 align-top">
        {(label !== undefined || action !== undefined) && (
          <div className="mb-3 flex items-center justify-between gap-3">
            <span
              data-cell-part="detail-label"
              className="text-label-11 uppercase tracking-wider text-ink-4"
            >
              {label}
            </span>
            {action}
          </div>
        )}
        {children}
      </td>
    </tr>
  );
}

/** Une phrase d'état dans une ligne dépliée : rien d'enregistré, chargement. */
export function TableDetailNote({
  children,
  'data-testid': dataTestid,
}: {
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <p data-testid={dataTestid} data-cell="detail-note" className="text-body-13 text-ink-4">
      {children}
    </p>
  );
}

/**
 * La pagination d'une table : la page courante, et deux liens. Un lien absent
 * (`null`) est un bouton désactivé, jamais un trou : Previous et Next restent
 * à leur place d'une page à l'autre. Les URL viennent de l'appelant, qui seul
 * connaît les paramètres de sa page.
 */
export function TablePagination({
  page,
  prevHref,
  nextHref,
}: {
  page: number;
  prevHref: string | null;
  nextHref: string | null;
}) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
      <span data-cell-part="page" className="text-mono-12 text-ink-3">
        Page {page}
      </span>
      <div className="flex gap-2">
        {prevHref !== null ? (
          <RowActionButton href={prevHref}>Previous</RowActionButton>
        ) : (
          <RowActionButton disabled>Previous</RowActionButton>
        )}
        {nextHref !== null ? (
          <RowActionButton href={nextHref}>Next</RowActionButton>
        ) : (
          <RowActionButton disabled>Next</RowActionButton>
        )}
      </div>
    </nav>
  );
}
