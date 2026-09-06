'use client';

// NewProjectButton — déclarer un dossier comme projet (P8).
//
// On ne saisit PAS un chemin libre : on choisit un agent, un de ses terrains,
// puis un sous-dossier relatif. Un chemin libre laisserait déclarer un dossier
// qu'aucun agent ne peut atteindre, et le projet naîtrait déjà mort.
//
// La modale n'est pas « dismissable » : c'est un formulaire d'édition, il ne se
// ferme que par ses boutons (règle du dépôt). Et l'aperçu du chemin final est
// montré PENDANT la saisie — la même règle que celle appliquée par l'action
// (`isSafeSubfolder`, @nodal-agents/shared), pour qu'on ne découvre pas au clic que le sous-dossier
// était refusé.

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';
import SegmentedControl from '@/components/ui/SegmentedControl';
import FieldLabel from '@/components/ui/FieldLabel';
import CopyablePath from '@/components/ui/CopyablePath';
import {
  createProjectAction,
  listProjectTerrainsAction,
  type ProjectTerrain,
} from '@/lib/project-actions.ts';
import { previewProjectPath } from '@nodal-agents/shared';

export default function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [terrains, setTerrains] = useState<ProjectTerrain[] | null>(null);
  const [agentId, setAgentId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('');
  const [subfolder, setSubfolder] = useState('');
  const [kind, setKind] = useState<'code' | 'documents'>('code');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Les terrains sont chargés À L'OUVERTURE, pas au montage : la page du
  // registre n'a pas à interroger la base pour un bouton qu'on ne cliquera
  // peut-être jamais.
  useEffect(() => {
    if (!open || terrains !== null) return;
    let annule = false;
    void listProjectTerrainsAction().then((r) => {
      if (annule) return;
      if (!r.ok) {
        setError(r.message);
        setTerrains([]);
        return;
      }
      setTerrains(r.data);
      const premier = r.data[0];
      if (premier) {
        setAgentId(premier.agentId);
        setWorkspaceId(premier.workspaces[0]?.id ?? '');
      }
    });
    return () => {
      annule = true;
    };
  }, [open, terrains]);

  const agent = terrains?.find((t) => t.agentId === agentId) ?? null;
  const workspace = agent?.workspaces.find((w) => w.id === workspaceId) ?? null;
  const preview = workspace ? previewProjectPath(workspace.path, subfolder.trim()) : null;
  const ready = name.trim() !== '' && workspace !== null && preview !== null;

  function reset(): void {
    setName('');
    setSubfolder('');
    setKind('code');
    setError(null);
  }

  function close(): void {
    setOpen(false);
    reset();
  }

  function submit(): void {
    if (!ready || workspace === null) return;
    setError(null);
    startTransition(async () => {
      const r = await createProjectAction({
        name: name.trim(),
        agentId,
        workspaceId,
        subfolder: subfolder.trim(),
        kind,
      });
      if (!r.ok) {
        // Un code par cause, un message par code — l'écran doit dire LAQUELLE.
        setError(r.code === 'already_registered' ? 'This folder is already a project.' : r.message);
        return;
      }
      toast.success('Project created');
      setOpen(false);
      reset();
      router.push(`/spaces/${r.data.id}`);
    });
  }

  return (
    <>
      <PrimaryButton onClick={() => setOpen(true)}>New project</PrimaryButton>
      <Modal
        open={open}
        onClose={close}
        dismissable={false}
        title="New project"
        footer={
          <ModalFooter>
            <PrimaryButton variant="neutral" onClick={close} disabled={isPending}>
              Cancel
            </PrimaryButton>
            <PrimaryButton onClick={submit} disabled={!ready || isPending}>
              {isPending ? 'Creating…' : 'Create project'}
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What this project is"
            disabled={isPending}
          />

          {terrains === null ? (
            <p className="text-body-13 text-ink-4">Loading agents…</p>
          ) : terrains.length === 0 ? (
            <p className="text-body-13 text-ink-3">
              No agent has a folder yet. Attach one to an agent first.
            </p>
          ) : (
            <>
              <Select
                label="Agent"
                value={agentId}
                disabled={isPending}
                onChange={(e) => {
                  const next = terrains.find((t) => t.agentId === e.target.value) ?? null;
                  setAgentId(e.target.value);
                  setWorkspaceId(next?.workspaces[0]?.id ?? '');
                }}
              >
                {terrains.map((t) => (
                  <option key={t.agentId} value={t.agentId}>
                    {t.agentName}
                  </option>
                ))}
              </Select>

              <Select
                label="Folder"
                value={workspaceId}
                disabled={isPending}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {(agent?.workspaces ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label} — {w.path}
                  </option>
                ))}
              </Select>
            </>
          )}

          <div>
            <TextInput
              label="Subfolder"
              value={subfolder}
              onChange={(e) => setSubfolder(e.target.value)}
              placeholder="Leave empty to use the folder itself"
              disabled={isPending}
            />
            <div className="mt-2">
              {preview !== null ? (
                <CopyablePath display={preview} value={preview} />
              ) : (
                <p className="text-body-12 text-err">
                  A subfolder is a relative path inside the folder. No “..”, no drive letter.
                </p>
              )}
            </div>
          </div>

          <div>
            <FieldLabel>Produces</FieldLabel>
            <SegmentedControl
              options={[
                { value: 'code', label: 'Code' },
                { value: 'documents', label: 'Documents' },
              ]}
              value={kind}
              onChange={setKind}
              disabled={isPending}
              ariaLabel="What this project produces"
            />
          </div>

          {error !== null && <p className="text-body-13 text-err">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
