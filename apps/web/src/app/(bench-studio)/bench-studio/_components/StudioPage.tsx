// Le cadre d'un écran de Bench Studio : la recette de PageHeader (titre, lede,
// filet), sans les contrôles globaux du dashboard qui n'ont rien à faire ici.
import type { ReactNode } from 'react';

export default function StudioPage({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-8 lg:px-9">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-rule-2 pb-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-display-28 leading-[1.15]! tracking-[-0.015em] text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-body-14 leading-[1.5]! text-ink-3">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** Une carte de l'écran : un intitulé, puis son contenu. */
export function Panel({
  title,
  aside,
  children,
  className = '',
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-rule-2 bg-paper ${className}`}>
      {title !== undefined && (
        <div className="flex items-center justify-between gap-3 border-b border-rule-2 px-5 py-3">
          <h2 className="text-label-11 tracking-wider text-ink-4 uppercase">{title}</h2>
          {aside}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/** Une rangée « intitulé · valeur » dans une carte. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-2">
      <div className="text-medium-12 text-ink-4">{label}</div>
      <div className="min-w-0 flex-1 text-body-13 text-ink-2">{children}</div>
    </div>
  );
}
