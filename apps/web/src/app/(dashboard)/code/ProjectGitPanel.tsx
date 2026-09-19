'use client';

/**
 * ProjectGitPanel — l'option « git dans ce dossier », sur l'écran du projet
 * (issue #200).
 *
 * POURQUOI ELLE EXISTE. Le constat par git (#199) s'active de lui-même dès
 * qu'un projet est un dépôt : il liste exactement ce qu'un run a écrit, y
 * compris ce qu'une commande a écrit sans le nommer. Quelqu'un qui démarre un
 * projet depuis Telegram ou depuis le chat n'a pas git, et n'aurait jamais ce
 * constat-là. Nodal peut donc poser le dépôt — quand on le lui demande.
 *
 * L'INTERRUPTEUR N'EST PAS OPTIMISTE. Allumer écrit dans le dossier de la
 * personne : on persiste, le serveur répond ce qu'il a fait, et l'écran
 * affiche CETTE réponse. Un interrupteur qui bascule avant que le dépôt
 * existe dirait quelque chose de faux pendant une seconde, et de définitif si
 * l'écriture échoue (invariant #4). C'est la même règle que le panneau de
 * preuve juste au-dessus, et pour la même raison.
 *
 * ÉTEINDRE NE SUPPRIME RIEN. Un dépôt n'est pas un réglage d'affichage :
 * effacer `.git` emporterait tout l'historique. La ligne sous l'interrupteur
 * le dit, pour que personne ne l'apprenne en le faisant.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setCodeProjectInitGitAction } from '@/lib/actions.ts';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Switch from '@/components/ui/Switch';
import { relativeTime } from '@/lib/format-time';

/** Ce que la table porte pour un projet — l'intention, et le fait. */
export type ProjectGit = {
  initGit: boolean;
  /** L'instant où Nodal a posé le dépôt. `null` = il n'a rien posé. */
  gitInitializedAt: Date | null;
};

export default function ProjectGitPanel({
  projectPath,
  git,
  isOwner,
  onChanged,
}: {
  projectPath: string;
  git: ProjectGit | null;
  isOwner: boolean;
  onChanged: (next: ProjectGit) => void;
}) {
  const [busy, startTransition] = useTransition();
  /** Ce que le serveur vient de répondre — dit une fois, sous l'interrupteur. */
  const [dernier, setDernier] = useState<'initialised' | 'already' | 'off' | null>(null);
  const initGit = git?.initGit ?? false;
  const pose = git?.gitInitializedAt ?? null;

  function basculer(): void {
    if (!isOwner || busy) return;
    const cible = !initGit;
    startTransition(async () => {
      const r = await setCodeProjectInitGitAction({ projectPath, initGit: cible });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setDernier(r.data.outcome === 'failed' ? null : r.data.outcome);
      onChanged({
        initGit: r.data.initGit,
        gitInitializedAt: r.data.gitInitializedAt ? new Date(r.data.gitInitializedAt) : pose,
      });
      toast.success(
        r.data.outcome === 'initialised'
          ? 'Git initialised in this folder'
          : r.data.outcome === 'already'
            ? 'This folder was already a repository'
            : 'Nodal will not initialise git here',
      );
    });
  }

  return (
    <section
      className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
      data-testid="project-git-panel"
    >
      <h2 className="flex items-center gap-2 border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
        Git
        {!isOwner && <MonoMicroTag tone="err">owner only</MonoMicroTag>}
      </h2>
      <div className="space-y-2 p-4">
        <div className="flex items-start gap-3">
          <Switch
            checked={initGit}
            onChange={basculer}
            disabled={!isOwner || busy}
            size="md"
            trackClassName={
              initGit ? 'bg-ink border-ink' : 'bg-canvas border-rule hover:border-rule-2'
            }
            thumbClassName={initGit ? 'bg-paper translate-x-[18px]' : 'bg-ink-4 translate-x-[2px]'}
            ariaLabel="Initialise git in this folder"
          />
          <div className="min-w-0">
            <p className="text-body-13 text-ink">Initialise git in this folder</p>
            <p className="text-body-12 text-ink-4">
              Nodal then lists exactly the files each run wrote, even the ones a command wrote
              without naming them. Nothing is committed and nothing is pushed.
            </p>
          </div>
        </div>

        {/* LE FAIT, pas l'intention. Un dossier qui était déjà un dépôt n'a
            pas de date de pose, et on ne lui en invente pas une. */}
        {pose !== null && (
          <p className="text-body-12 text-ink-3" data-testid="project-git-posed">
            Nodal initialised this repository {relativeTime(pose)}.
          </p>
        )}
        {dernier === 'already' && pose === null && (
          <p className="text-body-12 text-ink-3">
            This folder was already a repository. Nodal left it alone.
          </p>
        )}
        {dernier === 'off' && (
          <p className="text-body-12 text-ink-3">
            The repository stays where it is — turning this off never deletes one.
          </p>
        )}
        {!isOwner && (
          <p className="text-body-12 text-ink-3">
            Only the workspace owner can initialise git in a project folder.
          </p>
        )}
      </div>
    </section>
  );
}
