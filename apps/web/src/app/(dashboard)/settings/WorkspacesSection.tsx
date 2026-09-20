'use client';

import { useEffect, useState, useTransition } from 'react';
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
import {
  listWorkspaceFootprintsAction,
  type WorkspaceFootprint,
} from '@/lib/workspace-footprint-actions.ts';
import { footprintSizeText, footprintSnapshotText } from '@/lib/workspace-footprint.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { SetForm } from '@/components/ui/SetForm.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import { TagMini } from '@/components/ui/TagMini.tsx';
import EmojiPicker, { WORKSPACE_EMOJI_PRESETS } from '@/components/ui/EmojiPicker.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import TextInput from '@/components/ui/TextInput';

interface Props {
  initial: WorkspaceRow[];
  /**
   * L'`id` du formulaire de CRÉATION quand cette section est rendue dans le
   * panneau ancré (#231) : le bouton du pied le soumet par l'attribut HTML
   * `form`. Le formulaire de renommage, en ligne dans la liste, garde le sien.
   */
  formId?: string;
}

export default function WorkspacesSection({ initial, formId }: Props) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>(initial);

  // Create form
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState<string>(WORKSPACE_EMOJI_PRESETS[0]!);
  const [isCreating, startCreateTransition] = useTransition();

  // Rename/edit state — tracks which workspace is being edited (name + icon)
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameIcon, setRenameIcon] = useState<string>(WORKSPACE_EMOJI_PRESETS[0]!);
  const [isRenamePending, startRenameTransition] = useTransition();

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceRow | null>(null);
  const [isDeleting, startDeleteTransition] = useTransition();

  // CE QUE PÈSE CHAQUE ESPACE, ET CE QU'A COÛTÉ SA DERNIÈRE PHOTO (#261).
  //
  // APRÈS LE MONTAGE, jamais pendant le rendu de la page : la mesure parcourt
  // le disque et s'arrête à trois secondes par espace. La liste s'affiche
  // d'abord, les deux faits arrivent ensuite — comme la liste des fichiers
  // d'un dossier d'agent.
  //
  // `null` = la lecture n'a pas répondu, et l'écran le DIT. Un tableau vide
  // dirait « aucun espace ne pèse rien », ce qui n'est pas la même chose
  // (invariant #4).
  const [footprints, setFootprints] = useState<WorkspaceFootprint[] | null>(null);
  const [footprintError, setFootprintError] = useState<string | null>(null);
  useEffect(() => {
    let vivant = true;
    void listWorkspaceFootprintsAction().then((res) => {
      if (!vivant) return;
      if (res.ok) setFootprints(res.data);
      // Un échec se DIT sous la ligne : une taille absente en silence se
      // lirait comme un dossier vide.
      else setFootprintError(res.message);
    });
    return () => {
      vivant = false;
    };
  }, []);

  async function reload() {
    const res = await listWorkspacesAction();
    if (res.ok) setWorkspaces(res.data);
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    startCreateTransition(async () => {
      const res = await createWorkspaceAction({ name, icon: newIcon });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`Workspace "${name}" created`);
      setNewName('');
      setNewIcon(WORKSPACE_EMOJI_PRESETS[0]!);
      await reload();
      router.refresh();
    });
  }

  function startRename(ws: WorkspaceRow) {
    setRenamingId(ws.id);
    setRenameValue(ws.name);
    setRenameIcon(ws.icon ?? WORKSPACE_EMOJI_PRESETS[0]!);
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
      const res = await renameWorkspaceAction({ id, name, icon: renameIcon });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success('Workspace updated');
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

  // Le titre et le lede sont ceux du panneau qui accueille ce formulaire
  // (SettingsList) — la section ne porte plus son propre en-tête (#231).
  return (
    <>
      {/* Workspace list */}
      <div className="mt-3.5 rounded-xl border border-rule-2 bg-paper overflow-hidden">
        {workspaces.length === 0 ? (
          <p className="px-[18px] py-4 text-body-14 text-ink-4">No workspaces found.</p>
        ) : (
          workspaces.map((ws) => {
            const isRenaming = renamingId === ws.id;
            return (
              <div
                key={ws.id}
                className="flex items-center gap-3 px-[18px] py-3.5 border-b border-rule-2 last:border-b-0"
              >
                {/* Icon badge */}
                <span className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-md border border-rule-2 bg-canvas font-mono text-legacy-14 leading-none!">
                  {ws.icon ?? ws.name.slice(0, 1).toUpperCase()}
                </span>

                {/* Name / inline rename */}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {isRenaming ? (
                    <form
                      onSubmit={(e) => handleRenameSubmit(e, ws.id)}
                      className="flex flex-col gap-2"
                    >
                      <EmojiPicker
                        value={renameIcon}
                        onChange={setRenameIcon}
                        disabled={isRenamePending}
                      />
                      <div className="flex items-center gap-1.5">
                        <TextInput
                          autoFocus
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          maxLength={60}
                          disabled={isRenamePending}
                          containerClassName="w-44"
                        />
                        <PrimaryButton
                          variant="ink"
                          size="sm"
                          type="submit"
                          disabled={!renameValue.trim()}
                        >
                          Save
                        </PrimaryButton>
                        <RowActionButton type="button" onClick={cancelRename}>
                          Cancel
                        </RowActionButton>
                      </div>
                    </form>
                  ) : (
                    <span className="text-medium-14 text-ink leading-none!">{ws.name}</span>
                  )}
                  <span className="text-mono-11 text-ink-4 leading-none! mt-0.5">{ws.role}</span>
                  {/* La taille du dossier partagé et la durée de la dernière
                      photo. Deux faits LUS, jamais estimés : c'est ce qui rend
                      visible un espace devenu trop gros pour le filet, avant
                      qu'une écriture ne soit refusée (#261). */}
                  <span
                    className="text-mono-11 text-ink-4 leading-none! mt-1"
                    data-testid={`workspace-footprint-${ws.id}`}
                  >
                    {footprintError !== null
                      ? footprintError
                      : footprints === null
                        ? 'Measuring shared folder…'
                        : (() => {
                            const f = footprints.find((x) => x.workspaceId === ws.id);
                            if (f === undefined) return 'Shared folder not measured';
                            return `${footprintSizeText(f)} · ${footprintSnapshotText(f)}`;
                          })()}
                  </span>
                </span>

                {/* Tags + actions */}
                <div className="flex shrink-0 items-center gap-2">
                  {ws.active && <TagMini variant="ok">ACTIVE</TagMini>}
                  {!ws.active && (
                    <RowActionButton onClick={() => handleSwitch(ws.id)}>Switch</RowActionButton>
                  )}
                  {!isRenaming && (
                    <RowActionButton onClick={() => startRename(ws)}>Rename</RowActionButton>
                  )}
                  {ws.role === 'owner' && !ws.active && (
                    <RowActionButton
                      tone="danger"
                      onClick={() => setDeleteTarget(ws)}
                      disabled={isDeleting}
                    >
                      Delete
                    </RowActionButton>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create form */}
      <form id={formId} onSubmit={handleCreate}>
        <SetForm label="Create workspace">
          <div className="mb-2">
            <EmojiPicker value={newIcon} onChange={setNewIcon} disabled={isCreating} />
          </div>
          <div className="flex gap-2 items-center">
            <TextInput
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workspace name"
              maxLength={60}
              disabled={isCreating}
              containerClassName="min-w-0 flex-1"
            />
          </div>
          <SetCtaRow onCancel={() => setNewName('')} pending={isCreating} saveLabel="Create" />
        </SetForm>
      </form>

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
