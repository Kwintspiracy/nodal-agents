// ConversationsTable — les tâches qu'on a demandées soi-même (dashboard,
// Telegram, chat, API, webhook), une ligne chacune, la plus récente en haut.

import Link from 'next/link';
import AgentAvatar from '@/components/ui/AgentAvatar';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { relativeTime, truncate } from '@/lib/format-time';
import type { SpaceListRow } from '@/lib/actions.ts';
import { firstLine } from '@/lib/spaces-list.ts';
import { formatCost, originLabel } from './format.ts';

function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || (status?.startsWith('awaiting') ?? false))
    return 'run';
  return 'idle';
}

export default function ConversationsTable({ rows }: { rows: SpaceListRow[] }) {
  return (
    <Table>
      <THead>
        <Th>Agent</Th>
        <Th>Request</Th>
        <Th className="hidden md:table-cell">Origin</Th>
        <Th className="hidden lg:table-cell">When</Th>
        <Th align="right" className="hidden sm:table-cell">
          Cost
        </Th>
        <Th align="right">Status</Th>
      </THead>
      <tbody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td>
              <span className="flex items-center gap-2 text-body-13 text-ink">
                <AgentAvatar
                  name={r.agentName}
                  imageUrl={r.agentAvatarUrl}
                  size="sm"
                  shape="square"
                />
                <span className="truncate">{r.agentName}</span>
              </span>
            </Td>
            <Td>
              <Link
                href={`/spaces/${r.id}`}
                className="block max-w-[52ch] truncate text-body-13 text-ink-2 hover:text-ink"
              >
                {truncate(firstLine(r.task), 120)}
              </Link>
            </Td>
            <Td className="hidden text-body-12 text-ink-3 md:table-cell">
              {originLabel({ channel: r.channel, scheduleName: null, chatId: null })}
            </Td>
            <Td className="hidden text-body-12 whitespace-nowrap text-ink-3 lg:table-cell">
              {r.createdAt ? relativeTime(r.createdAt) : ''}
            </Td>
            <Td
              align="right"
              className="hidden text-mono-12 whitespace-nowrap text-ink-2 sm:table-cell"
            >
              {r.costUsd > 0 ? formatCost(r.costUsd) : ''}
            </Td>
            <Td align="right">
              <StatusPill variant={statusVariant(r.status)} />
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
