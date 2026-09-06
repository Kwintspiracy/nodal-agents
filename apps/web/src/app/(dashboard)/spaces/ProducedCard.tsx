// ProducedCard — l'encart de P7 : ce qui est SORTI du chat à ce tour, et où
// ça vit.
//
// Il ne paraît qu'au tour qui a produit quelque chose. Le reste du temps la
// conversation est une conversation, et un encart vide sur chaque tour ne
// serait que du bruit. Le verdict vient de `chat-or-work.ts`, qui lit les
// cartes persistées par P1 — cet écran met les mots, il ne classe rien.
//
// Un classement incertain est DIT, jamais arrondi : quand un outil tiers n'a
// déclaré aucun niveau de risque, l'encart le montre plutôt que de trancher à
// sa place (invariant #4).

import Link from 'next/link';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import type { ProducedItem, ProductionVerdict } from '@/lib/chat-or-work.ts';

/** Le mot d'un item, dans la langue de l'écran. */
const KIND_WORDS: Record<ProducedItem['kind'], string> = {
  file: 'file',
  sent: 'sent',
  command: 'command',
  harness: 'code',
  external: 'external',
};

export default function ProducedCard({
  verdict,
  project,
}: {
  verdict: ProductionVerdict;
  project: { id: string; name: string; path: string } | null;
}) {
  return (
    <div className="mt-4 ml-[44px] max-w-[760px] overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-rule-2 bg-sidebar px-4 py-2.5">
        <span className="text-medium-13 text-ink">Produced</span>
        {project ? (
          <Link
            href={`/spaces/${project.id}`}
            className="text-mono-11 text-ink-3 hover:text-ink-2"
            title={project.path}
          >
            in {project.name} · {project.path}
          </Link>
        ) : (
          <span className="text-mono-11 text-ink-4">outside any registered project</span>
        )}
      </div>
      <ul className="py-1">
        {verdict.items.map((item, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-1.5 text-mono-12 text-ink-2">
            <MonoMicroTag tone={item.kind === 'external' && !item.certain ? 'warn' : 'agent'}>
              {KIND_WORDS[item.kind]}
            </MonoMicroTag>
            <span className="min-w-0 flex-1 truncate" title={item.label}>
              {item.label}
            </span>
          </li>
        ))}
      </ul>
      {verdict.more > 0 && (
        <p className="px-4 pb-2 text-mono-11 text-ink-4">
          and {verdict.more} more {verdict.more === 1 ? 'file' : 'files'}
        </p>
      )}
      {verdict.uncertain > 0 && (
        <p className="border-t border-rule-2 px-4 py-2 text-mono-11 text-ink-4">
          {verdict.uncertain} {verdict.uncertain === 1 ? 'classification' : 'classifications'}{' '}
          uncertain: the tool declared no risk level
        </p>
      )}
    </div>
  );
}
