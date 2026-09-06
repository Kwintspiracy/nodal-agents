'use client';

// ConversationsList — la liste de TOUTES les conversations (P7).
//
// Une conversation par ligne, la plus récente en haut, avec son ORIGINE : le
// dashboard et les canaux se lisent au même endroit, parce que du point de vue
// de l'utilisateur c'est le même agent qui parle. Le filtre est côté client :
// deux cents lignes tiennent en mémoire, et taper doit répondre à la frappe.
//
// Ce qui est repris du chat à deux volets qui disparaît ici : la recherche, la
// suppression avec confirmation, le bouton « nouvelle conversation ».

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Trash } from '@phosphor-icons/react';
import AgentAvatar from '@/components/ui/AgentAvatar';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import EmptyState from '@/components/ui/EmptyState';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import RowActionButton from '@/components/ui/RowActionButton';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { createConversationAction, deleteConversationAction } from '@/lib/actions.ts';
import type { ConversationListRow } from '@/lib/conversation-actions.ts';
import { relativeTime, truncate } from '@/lib/format-time';
import { originLabel } from '@/app/(dashboard)/spaces/format.ts';

export default function ConversationsList({ rows }: { rows: ConversationListRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<ConversationListRow | null>(null);
  // Aucun agent ROOT désigné : le bouton ne peut pas marcher, et l'écran le dit
  // avec le chemin pour y remédier plutôt que d'échouer à chaque clic.
  const [noRoot, setNoRoot] = useState(false);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return rows;
    return rows.filter(
      (r) => r.title.toLowerCase().includes(q) || (r.agentName ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  function create(): void {
    startTransition(async () => {
      const r = await createConversationAction();
      if (!r.ok) {
        if (r.code === 'no_root_agent') setNoRoot(true);
        else toast.error(r.message);
        return;
      }
      router.push(`/chat/${r.data.id}`);
    });
  }

  function confirmDelete(): void {
    const victim = target;
    if (!victim) return;
    setTarget(null);
    startTransition(async () => {
      const r = await deleteConversationAction(victim.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={create} disabled={isPending || noRoot}>
          New conversation
        </PrimaryButton>
        <PageSearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search conversations…"
          className="ml-auto"
        />
      </div>

      {noRoot && (
        <p className="mb-4 text-body-13 text-ink-3">
          Designate a ROOT agent in Settings first.{' '}
          <Link href="/settings" className="text-ink-2 underline hover:text-ink">
            Go to Settings
          </Link>
        </p>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? 'No conversation yet' : 'No conversation matches that.'}
          description={
            rows.length === 0
              ? 'Start one here, or write to your agent from one of its channels.'
              : undefined
          }
        />
      ) : (
        <Table>
          <THead>
            <Th>Agent</Th>
            <Th>Conversation</Th>
            <Th className="hidden md:table-cell">Origin</Th>
            <Th className="hidden lg:table-cell">Project</Th>
            <Th align="right" className="hidden sm:table-cell">
              Turns
            </Th>
            <Th className="hidden lg:table-cell">Last activity</Th>
            <Th align="right">
              <span className="sr-only">Actions</span>
            </Th>
          </THead>
          <tbody>
            {filtered.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <span className="flex items-center gap-2 text-body-13 text-ink">
                    <AgentAvatar
                      name={r.agentName ?? 'Agent'}
                      imageUrl={r.agentAvatarUrl}
                      size="sm"
                      shape="square"
                    />
                    <span className="truncate">{r.agentName ?? 'Agent'}</span>
                  </span>
                </Td>
                <Td>
                  <Link
                    href={`/chat/${r.id}`}
                    className="block max-w-[52ch] truncate text-body-13 text-ink-2 hover:text-ink"
                  >
                    {r.title !== '' ? truncate(r.title, 120) : 'Untitled'}
                  </Link>
                  {r.lastPreview !== null && (
                    <span className="block max-w-[52ch] truncate text-body-12 text-ink-4">
                      {r.lastPreview}
                    </span>
                  )}
                </Td>
                <Td className="hidden text-body-12 text-ink-3 md:table-cell">
                  {originLabel({ channel: r.channel, scheduleName: null, chatId: r.chatId })}
                </Td>
                <Td className="hidden text-body-12 text-ink-3 lg:table-cell">
                  {r.currentProject ? (
                    <Link
                      href={`/spaces/${r.currentProject.id}`}
                      className="hover:text-ink-2"
                      title={r.currentProject.path}
                    >
                      {r.currentProject.name}
                    </Link>
                  ) : (
                    ''
                  )}
                </Td>
                <Td align="right" className="hidden text-mono-12 text-ink-2 sm:table-cell">
                  {r.turns}
                </Td>
                <Td className="hidden text-body-12 whitespace-nowrap text-ink-3 lg:table-cell">
                  {r.updatedAt ? relativeTime(r.updatedAt) : ''}
                </Td>
                <Td align="right">
                  <RowActionButton
                    square
                    tone="danger"
                    icon={<Trash size={14} weight="bold" />}
                    title="Delete conversation"
                    onClick={() => setTarget(r)}
                    disabled={isPending}
                  />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <ConfirmDialog
        open={target !== null}
        title="Delete this conversation?"
        message={`“${target?.title !== '' ? (target?.title ?? '') : 'Untitled'}” and its turns will be removed. The work it produced stays.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setTarget(null)}
      />
    </>
  );
}
