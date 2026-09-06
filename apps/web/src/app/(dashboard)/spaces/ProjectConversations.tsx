// ProjectConversations — tout ce qui s'est DIT autour de ce projet (P8).
//
// Deux façons d'y entrer, et la ligne dit laquelle : un travail rattaché au
// projet (la conversation d'où il est parti, quel que soit son canal), ou une
// conversation ANCRÉE au projet (`current_project_id`, posé par P6 dès qu'une
// production atterrit dedans). L'ancrage est ce qui fait que l'agent sait de
// quel dossier on parle au tour suivant : il mérite son étiquette.

import Link from 'next/link';
import AgentAvatar from '@/components/ui/AgentAvatar';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime, truncate } from '@/lib/format-time';
import { originLabel } from './format.ts';
import type { ProjectConversationRow } from '@/lib/project-actions.ts';

export default function ProjectConversations({ rows }: { rows: ProjectConversationRow[] }) {
  return (
    <Table>
      <THead>
        <Th>Conversation</Th>
        <Th className="hidden md:table-cell">Origin</Th>
        <Th className="hidden sm:table-cell">Agent</Th>
        <Th align="right">Last activity</Th>
      </THead>
      <tbody>
        {rows.map((c) => (
          <Tr key={c.id}>
            <Td>
              <span className="flex items-center gap-2">
                <Link
                  href={`/chat/${c.id}`}
                  className="max-w-[46ch] truncate text-body-13 text-ink-2 hover:text-ink"
                >
                  {c.title === '' ? 'Untitled' : truncate(c.title, 90)}
                </Link>
                {c.anchored && <MonoMicroTag tone="agent">anchored</MonoMicroTag>}
              </span>
            </Td>
            <Td className="hidden text-body-12 text-ink-3 md:table-cell">
              {originLabel({ channel: c.channel, scheduleName: null, chatId: null })}
            </Td>
            <Td className="hidden sm:table-cell">
              {c.agentName === null ? (
                <span className="text-body-12 text-ink-4">No agent</span>
              ) : (
                <span className="flex items-center gap-2 text-body-13 text-ink-2">
                  <AgentAvatar name={c.agentName} size="sm" shape="square" />
                  <span className="truncate">{c.agentName}</span>
                </span>
              )}
            </Td>
            <Td align="right" className="text-body-12 whitespace-nowrap text-ink-3">
              {c.updatedAt ? relativeTime(c.updatedAt) : ''}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
