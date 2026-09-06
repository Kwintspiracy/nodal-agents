// ProjectsTable — le registre des projets, une ligne chacun (P8).
//
// Ce que la ligne doit dire tient en une phrase : de quoi il s'agit, à qui
// c'est, où c'est, ce qui s'y est passé, et si c'est prouvé. Le reste vit sur
// la page du projet.
//
// Les projets MASQUÉS restent listés, avec leur étiquette. Masquer retire un
// projet du contexte injecté aux agents et des écrans qui listent du travail ;
// ce n'est pas une désinscription, et l'écran du registre est justement celui
// où l'on doit pouvoir retrouver ce qu'on a rangé.

import Link from 'next/link';
import AgentAvatar from '@/components/ui/AgentAvatar';
import StatusPill from '@/components/ui/StatusPill';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime, truncate } from '@/lib/format-time';
import type { ProjectListRow } from '@/lib/project-actions.ts';

/** Le chemin, raccourci par la GAUCHE : la fin d'un chemin est ce qui le nomme. */
function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - max + 1)}`;
}

export default function ProjectsTable({ rows }: { rows: ProjectListRow[] }) {
  return (
    <Table>
      <THead>
        <Th>Project</Th>
        <Th className="hidden sm:table-cell">Agent</Th>
        <Th className="hidden lg:table-cell">Folder</Th>
        <Th align="right" className="hidden md:table-cell">
          Work
        </Th>
        <Th className="hidden lg:table-cell">Last activity</Th>
        <Th align="right">Proof</Th>
      </THead>
      <tbody>
        {rows.map((p) => (
          <Tr key={p.id}>
            <Td>
              <span className="flex items-center gap-2">
                <Link
                  href={`/spaces/${p.id}`}
                  className="max-w-[32ch] truncate text-body-13 text-ink hover:text-ink-2"
                >
                  {truncate(p.name, 60)}
                </Link>
                <MonoMicroTag tone="ink">{p.kind}</MonoMicroTag>
                {p.hidden && <MonoMicroTag tone="warn">hidden</MonoMicroTag>}
              </span>
            </Td>
            <Td className="hidden sm:table-cell">
              {p.agentName === null ? (
                <span className="text-body-12 text-ink-4">No agent</span>
              ) : (
                <span className="flex items-center gap-2 text-body-13 text-ink-2">
                  <AgentAvatar name={p.agentName} size="sm" shape="square" />
                  <span className="truncate">{p.agentName}</span>
                </span>
              )}
            </Td>
            <Td className="hidden lg:table-cell">
              <span className="text-mono-12 whitespace-nowrap text-ink-3" title={p.path}>
                {shortPath(p.path)}
              </span>
            </Td>
            <Td align="right" className="hidden text-mono-12 text-ink-2 md:table-cell">
              {p.jobsCount}
            </Td>
            <Td className="hidden text-body-12 whitespace-nowrap text-ink-3 lg:table-cell">
              {p.lastActivityAt ? relativeTime(p.lastActivityAt) : 'never'}
            </Td>
            <Td align="right">
              {p.lastProof === null ? (
                // Pas de preuve n'est PAS un échec : le dire en toutes lettres
                // plutôt que d'allumer une pastille qui voudrait dire « rouge ».
                <span className="text-mono-11 whitespace-nowrap text-ink-4">no proof</span>
              ) : (
                <StatusPill
                  variant={p.lastProof.verdict === 'pass' ? 'done' : 'warn'}
                  label={p.lastProof.verdict === 'pass' ? 'proved' : 'failed'}
                />
              )}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
