import type { ReactNode } from 'react';

type Variant = 'agent' | 'skill' | 'conn' | 'ink' | 'neutral' | 'warn' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
type Shape = 'round' | 'square';

const VARIANT_BG: Record<Variant, string> = {
  agent: 'bg-agent-vivid text-[#0a0a0a]',
  skill: 'bg-skill-vivid text-white',
  conn: 'bg-conn-vivid text-white',
  ink: 'bg-ink text-canvas',
  neutral: 'bg-hover text-ink-3',
  // #876 : un fait qui demande l'attention (un dossier introuvable, un bac à
  // sable coupé), et une place vide (un dossier retiré).
  warn: 'bg-warn-bg text-warn',
  outline: 'border border-dashed border-rule-2 text-ink-4',
};

const SIZE_BOX: Record<Size, string> = {
  sm: 'h-[30px] w-[30px]',
  md: 'h-[34px] w-[34px]',
  lg: 'h-[38px] w-[38px]',
  xl: 'h-[42px] w-[42px]',
  // #876 : le pictogramme d'état d'une carte (la section Sandbox).
  xxl: 'h-12 w-12',
};

const SIZE_ICON: Record<Size, string> = {
  sm: '[&_svg]:h-[13px] [&_svg]:w-[13px]',
  md: '[&_svg]:h-[14px] [&_svg]:w-[14px]',
  lg: '[&_svg]:h-[16px] [&_svg]:w-[16px]',
  xl: '[&_svg]:h-[18px] [&_svg]:w-[18px]',
  xxl: '[&_svg]:h-6 [&_svg]:w-6',
};

type Props = {
  variant: Variant;
  size?: Size;
  shape?: Shape;
  /** Override the background — pass a `style.background` string for brand
   *  colours that don't fit the canonical palette (e.g. provider glyphs). */
  background?: string;
  children: ReactNode;
  className?: string;
};

/**
 * Disc — coloured icon container. The visual atom that names "what kind of
 * thing is this" across Agents/Skills/Connectors/LLM Providers/Memory.
 *
 * Maps to multiple .*disc / .glyph patterns in the design bundle:
 *   - `.sk-disc` (skill assigned table) → variant="skill" size="sm"
 *   - `.sklib-card .disc` (skill library card) → variant="skill" size="lg" shape="square"
 *   - `.mk2-glyph` (connector marketplace) → shape="square" with brand bg
 *   - `.ag-orb-sm` (agent grid) → variant="agent" size="xl" shape="square"
 *   - `.llm-card .glyph` → custom background per provider
 *
 * Keeping them all under one primitive means the disc geometry stays
 * coherent everywhere; only the chrome varies via props.
 */
export default function Disc({
  variant,
  size = 'md',
  shape = 'round',
  background,
  children,
  className = '',
}: Props) {
  const radius = shape === 'round' ? 'rounded-full' : 'rounded-[9px]';
  const v = background ? '' : VARIANT_BG[variant];
  return (
    <span
      style={background ? { background } : undefined}
      className={`inline-flex shrink-0 items-center justify-center ${SIZE_BOX[size]} ${SIZE_ICON[size]} ${radius} ${v} ${background ? 'text-white' : ''} ${className}`}
    >
      {children}
    </span>
  );
}
