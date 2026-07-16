/**
 * MemoryCategoryChip — small coloured chip for the four memory categories
 * tracked in the `agent_memory` DB table: preference · context · outcome ·
 * learned_rule.  Maps colour to semantic intent rather than arbitrary hues:
 *
 *   preference   → conn-vivid tint   (blue — "user likes X")
 *   context      → paper/ink-4 tint  (neutral — just a fact)
 *   outcome      → ok tint           (green — something worked)
 *   learned_rule → warn tint         (coral — behavioural rule)
 *
 * Canonical usage: one chip per memory row in the memories table.
 * Unknown values fall back to the neutral style so new DB categories
 * don't break the UI.
 *
 * @example
 *   <MemoryCategoryChip category="preference" />
 *   <MemoryCategoryChip category="learned_rule" />
 */

export type MemoryCategory = 'preference' | 'context' | 'outcome' | 'learned_rule';

const LABEL: Record<MemoryCategory, string> = {
  preference: 'Preference',
  context: 'Context',
  outcome: 'Outcome',
  learned_rule: 'Rule',
};

const STYLE: Record<MemoryCategory, string> = {
  preference: 'bg-conn-vivid/15 text-run dark:bg-conn-vivid/20 dark:text-[#8aa8ff]',
  context: 'bg-hover text-ink-3',
  outcome: 'bg-ok-bg text-ok',
  learned_rule: 'bg-warn-bg text-warn',
};

type Props = {
  category: string;
  className?: string;
};

export default function MemoryCategoryChip({ category, className = '' }: Props) {
  const key = category as MemoryCategory;
  const label = LABEL[key] ?? category;
  const style = STYLE[key] ?? 'bg-hover text-ink-3';

  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-[5px] px-2.5 text-medium-12 leading-none! ${style} ${className}`}
    >
      {label}
    </span>
  );
}
