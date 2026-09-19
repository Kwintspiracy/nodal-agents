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
import Checkbox from '@/components/ui/Checkbox';
import {
  createProjectAction,
  listProjectTerrainsAction,
  type ProjectTerrain,
} from '@/lib/project-actions.ts';
import { previewProjectPath, projectFolderNameFrom } from '@nodal-agents/shared';

export default function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [terrains, setTerrains] = useState<ProjectTerrain[] | null>(null);
  const [agentId, setAgentId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('');
  const [subfolder, setSubfolder] = useState('');
  const [kind, setKind] = useState<'code' | 'documents'>('code');
  // OFF par defaut, comme la colonne : l option est proposee, jamais posee.
  const [initGit, setInitGit] = useState(false);
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
  // Un sous-dossier vide sur un terrain qui porte déjà des projets sera refusé
  // par l'action : le bouton reste éteint plutôt que d'appeler pour rien.
  // Le dossier qui sera RÉELLEMENT créé : la saisie, ou le nom du projet dérivé
  // par la MÊME fonction que l'action serveur — sans quoi l'écran promettrait un
  // dossier et le serveur en créerait un autre.
  const dossierFinal = subfolder.trim() !== '' ? subfolder.trim() : projectFolderNameFrom(name);
  const ready = name.trim() !== '' && workspace !== null && preview !== null && dossierFinal !== '';

  function reset(): void {
    setName('');
    setSubfolder('');
    setKind('code');
    setInitGit(false);
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
        initGit,
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

              {/* UN SEUL dossier ⇒ ce n'est pas un choix, c'est un FAIT.
                  Un menu déroulant à une entrée fait croire à une décision
                  qu'on n'a pas (Quentin, 09/09/2026 : « il y a un dropdown mais
                  il n'y a qu'un seul objet dedans donc ça sert à rien »). On le
                  montre, on ne le propose pas. Le menu revient dès qu'il y a
                  vraiment plusieurs dossiers. */}
              {(agent?.workspaces.length ?? 0) > 1 ? (
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
              ) : workspace ? (
                <div>
                  <FieldLabel>Folder</FieldLabel>
                  <p className="text-body-13 text-ink-2">
                    <span className="text-mono-12 text-ink">{workspace.path}</span>
                  </p>
                  <p className="text-body-12 text-ink-4 mt-1">
                    {agent?.agentName}
                    {agent?.agentName ? ' works here — ' : ''}the project lands inside it.
                  </p>
                </div>
              ) : null}
            </>
          )}

          <div>
            {/* « Subfolder » était du jargon d'implémentation : c'est le NOM DU
                DOSSIER que le projet portera.
                Et le champ VIDE ne prend plus le dossier entier — il laisse le
                nom se dériver du nom du projet. Le dossier racine d'un
                développeur EST un dossier de projets : « on s'en fout qu'il
                contienne déjà des sous-dossiers » (Quentin, 09/09/2026). D'où
                l'avertissement rouge par défaut, retiré : il alarmait sur une
                situation parfaitement normale. */}
            <TextInput
              label="Folder name"
              value={subfolder}
              onChange={(e) => setSubfolder(e.target.value)}
              placeholder="Give a name, or let it be named for you"
              disabled={isPending}
            />
            <div className="mt-2">
              {preview === null ? (
                <p className="text-body-12 text-err">
                  A folder name, not a path. No “..”, no drive letter, no slash.
                </p>
              ) : dossierFinal !== '' ? (
                // Une PHRASE, pas un chemin à copier : on ne copie pas un
                // dossier qui n'existe pas encore.
                <p className="text-body-12 text-ink-3">
                  Creates <span className="text-mono-12 text-ink">{dossierFinal}</span> in that
                  folder.
                </p>
              ) : (
                <p className="text-body-12 text-ink-4">
                  Name the project above, and its folder takes that name.
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

          {/* GIT, PROPOSÉ ET JAMAIS IMPOSÉ (issue #200).
              Décoché par défaut : `git init` écrit dans le dossier, et on ne
              pose pas un dépôt chez quelqu'un parce qu'on trouve ça mieux. La
              ligne dessous dit ce que ça CHANGE pour la personne — la liste
              des fichiers d'un run devient exacte — plutôt que de nommer une
              technique dont elle n'a pas à connaître le détail. */}
          <div>
            <Checkbox
              label="Initialise git in this folder"
              checked={initGit}
              disabled={isPending}
              onChange={(e) => setInitGit(e.target.checked)}
            />
            <p className="text-body-12 text-ink-4 mt-1">
              Nodal then lists exactly the files each run wrote, even the ones a command wrote
              without naming them. Nothing is committed and nothing is pushed.
            </p>
          </div>

          {error !== null && <p className="text-body-13 text-err">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
