'use client';

// La barre de Bench Studio : la marque, les quatre écrans, et le rappel que
// l'outil ne sert que cette machine.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { ProductLogo } from '@/components/ui/BrandMark';

const SCREENS = [
  {
    href: '/bench-studio',
    label: 'Catalog',
    match: ['/bench-studio', '/bench-studio/scenarios', '/bench-studio/fixture'],
  },
  { href: '/bench-studio/run', label: 'Run', match: ['/bench-studio/run'] },
  { href: '/bench-studio/live', label: 'Live', match: ['/bench-studio/live'] },
  {
    href: '/bench-studio/results',
    label: 'Results',
    match: ['/bench-studio/results', '/bench-studio/deliverable'],
  },
] as const;

function active(path: string, match: readonly string[]): boolean {
  return match.some((m) =>
    m === '/bench-studio'
      ? path === m
      : path === m || path.startsWith(`${m}/`) || path.startsWith(`${m}?`),
  );
}

export default function StudioNav() {
  const path = usePathname();
  return (
    <nav className="sticky top-0 z-10 border-b border-rule-2 bg-paper/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-8 lg:px-9">
        <Link href="/bench-studio" className="flex items-center gap-2.5 text-ink">
          <ProductLogo size={22} priority />
          <span className="text-title-15">Bench Studio</span>
        </Link>
        <div className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
          {SCREENS.map((s) => {
            const on = active(path, s.match);
            return (
              <Link
                key={s.href}
                href={s.href}
                aria-current={on ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-medium-13 whitespace-nowrap transition-colors ${
                  on ? 'bg-ink text-canvas' : 'text-ink-3 hover:bg-hover hover:text-ink'
                }`}
              >
                {s.label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <MonoMicroTag tone="ink">local only</MonoMicroTag>
        </div>
      </div>
    </nav>
  );
}
