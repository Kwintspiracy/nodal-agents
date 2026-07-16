import type { ReactNode } from 'react';

/**
 * MonoCode — small monospace chip used to render configuration values
 * inline (e.g. `timeout=10s` in a customisation column, `nodal-agents init`
 * in body text). Maps to the `.cus code` + `.set-h .lede code` patterns
 * in the design bundle.
 *
 * Renders as a `<code>` element for semantics, with a paper-toned
 * background that contrasts gently against `bg-paper` rows.
 */
export default function MonoCode({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code
      className={`inline-flex items-center rounded-[5px] bg-hover px-1.5 py-1 text-mono-12 leading-none! tracking-[0.02em] text-ink-2 ${className}`}
    >
      {children}
    </code>
  );
}
