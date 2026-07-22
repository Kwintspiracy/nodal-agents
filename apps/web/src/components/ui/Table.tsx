import type { ReactNode, CSSProperties, MouseEventHandler } from 'react';

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
 *                      when the host needs its own hover tone.
 *   <Td>               body cell; align / top (align-top) / className.
 *   <TableSegmentRow>  full-width group header (dot + label + count), the
 *                      provenance-segment pattern from /skills.
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
  const table = <table className={`w-full border-collapse text-sm ${className}`}>{children}</table>;
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
  'aria-expanded': ariaExpanded,
  'data-testid': dataTestid,
}: {
  children: ReactNode;
  /** Adds cursor-pointer for clickable rows. */
  interactive?: boolean;
  /** false when the host applies its own hover tone (avoids hover:bg conflicts). */
  hover?: boolean;
  className?: string;
  onClick?: MouseEventHandler<HTMLTableRowElement>;
  title?: string;
  style?: CSSProperties;
  'aria-expanded'?: boolean;
  'data-testid'?: string;
}) {
  return (
    <tr
      onClick={onClick}
      title={title}
      style={style}
      aria-expanded={ariaExpanded}
      data-testid={dataTestid}
      className={`border-b border-rule-2 transition-colors last:border-0 ${
        hover ? 'hover:bg-hover' : ''
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
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  /** align-top for rows whose first cell can grow (e.g. expandable text). */
  top?: boolean;
  colSpan?: number;
  className?: string;
  onClick?: MouseEventHandler<HTMLTableCellElement>;
  style?: CSSProperties;
}) {
  return (
    <td
      colSpan={colSpan}
      onClick={onClick}
      style={style}
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
