'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  listWorkspacesAction,
  createWorkspaceAction,
  renameWorkspaceAction,
  deleteWorkspaceAction,
  switchWorkspaceAction,
  type WorkspaceRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { SetBlock } from '@/components/ui/SetBlock.tsx';
import { SetForm } from '@/components/ui/SetForm.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import { TagMini } from '@/components/ui/TagMini.tsx';

interface Props {
  initial: WorkspaceRow[];
}

export default function WorkspacesSection({ initial }: Props) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>(initial);

  // Create form
  const [newName, setNewName] = useState('');
  const [isCreating, startCreateTransition] = useTransition();

  // Rename state — tracks which workspace is being renamed
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenamePending, startRenameTransition] = useTransition();

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceRow | null>(null);
  const [isDeleting, startDeleteTransition] = useTransition();

  async function reload() {
    const res = await listWorkspacesAction();
    if (res.ok) setWorkspaces(res.data);
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    startCreateTransition(async () => {
      const res = await createWorkspaceAction({ name });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`Workspace "${name}" created`);
      setNewName('');
      await reload();
      router.refresh();
    });
  }

  function startRename(ws: WorkspaceRow) {
    setRenamingId(ws.id);
    setRenameValue(ws.name);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue('');
  }

  function handleRenameSubmit(e: React.FormEvent, id: string) {
    e.preventDefault();
    const name = renameValue.trim();
    if (!name) return;
    startRenameTransition(async () => {
      const res = await renameWorkspaceAction({ id, name });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success('Workspace renamed');
      setRenamingId(null);
      await reload();
      router.refresh();
    });
  }

  function handleDeleteConfirm() {
    if (!deleteTarget) return;
    const { id, name } = deleteTarget;
    startDeleteTransition(async () => {
      setDeleteTarget(null);
      const res = await deleteWorkspaceAction({ id });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`Workspace "${name}" deleted`);
      await reload();
      router.refresh();
    });
  }

  async function handleSwitch(id: string) {
    const res = await switchWorkspaceAction({ id });
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    await reload();
    router.refresh();
  }

  return (
    <>
      <SetBlock
        label="Workspaces"
        lede="Manage your workspaces. Each workspace scopes agents, credentials, and data independently."
      >
        {/* Workspace list */}
        <div className="mt-3.5 rounded-xl border border-rule-2 bg-paper overflow-hidden">
          {workspaces.length === 0 ? (
            <p className="px-[18px] py-4 text-[13px] text-ink-4">No workspaces found.</p>
          ) : (
            workspaces.map((ws) => {
              const isRenaming = renamingId === ws.id;
              return (
                <div
                  key={ws.id}
                  className="flex items-center gap-3 px-[18px] py-3.5 border-b border-rule-2 last:border-b-0"
                >
                  {/* Icon badge */}
                  <span className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-md border border-rule-2 bg-canvas font-mono text-[13px] leading-none">
                    {ws.icon ?? ws.name.slice(0, 1).toUpperCase()}
                  </span>

                  {/* Name / inline rename */}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {isRenaming ? (
                      <form
                        onSubmit={(e) => handleRenameSubmit(e, ws.id)}
                        className="flex items-center gap-1.5"
                      >
                        <input
                          autoFocus
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          maxLength={60}
                          disabled={isRenamePending}
                          className="w-44 rounded-md border border-rule bg-canvas px-2 py-1 text-[12.5px] text-ink focus:border-ink-3 focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={!renameValue.trim()}
                          className="rounded-md bg-ink px-2.5 py-1 text-[11.5px] font-medium text-canvas hover:brightness-90 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelRename}
                          className="rounded-md border border-rule px-2 py-1 text-[11.5px] text-ink-3 hover:border-rule-2 hover:text-ink-2"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <span className="text-[13.5px] font-medium text-ink leading-none">
                        {ws.name}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-ink-4 leading-none mt-0.5">
                      {ws.role}
                    </span>
                  </span>

                  {/* Tags + actions */}
                  <div className="flex shrink-0 items-center gap-2">
                    {ws.active && <TagMini variant="ok">ACTIVE</TagMini>}
                    {!ws.active && (
                      <button
                        type="button"
                        onClick={() => handleSwitch(ws.id)}
                        className="rounded-md border border-rule px-2.5 py-1 text-[11.5px] text-ink-3 hover:border-rule-2 hover:text-ink-2 transition-colors"
                      >
                        Switch
                      </button>
                    )}
                    {!isRenaming && (
                      <button
                        type="button"
                        onClick={() => startRename(ws)}
                        className="rounded-md border border-rule px-2.5 py-1 text-[11.5px] text-ink-3 hover:border-rule-2 hover:text-ink-2 transition-colors"
                      >
                        Rename
                      </button>
                    )}
                    {ws.role === 'owner' && !ws.active && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(ws)}
                        disabled={isDeleting}
                        className="rounded-md border border-rule px-2.5 py-1 text-[11.5px] text-err hover:border-err/40 hover:bg-err/5 disabled:opacity-50 transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Create form */}
        <form onSubmit={handleCreate}>
          <SetForm label="Create workspace">
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Workspace name"
                maxLength={60}
                disabled={isCreating}
                className="min-w-0 flex-1 rounded-lg border border-rule bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none disabled:opacity-50"
              />
            </div>
            <SetCtaRow onCancel={() => setNewName('')} pending={isCreating} saveLabel="Create" />
          </SetForm>
        </form>
      </SetBlock>

      {/* Delete confirmation — NEVER window.confirm (ESLint-banned) */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete workspace?"
        message={
          deleteTarget
            ? `This will permanently delete "${deleteTarget.name}" and all its data (agents, jobs, credentials). This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
