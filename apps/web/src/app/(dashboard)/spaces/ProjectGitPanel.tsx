'use client';

/**
 * ProjectGitPanel — l'option « git dans ce dossier », dans les réglages du
 * projet (issue #200).
 *
 * OÙ, ET POURQUOI PAS AILLEURS. Le panneau a d'abord vécu sur l'écran du
 * projet DÉRIVÉ de l'onglet Code, qui n'a pas d'identité en base : l'écran ne
 * pouvait donner qu'un CHEMIN, et une action qui pose un dépôt à partir d'un
 * chemin venu du client est une action qui pose un dépôt n'importe où (revue C
 * de la PR #244, constat 2). Il vit donc là où un projet a un identifiant :
 * `/spaces/[id]/files`, ce que Quentin appelle « les réglages de mon projet ».
 * Et c'est ce que l'issue demandait — « un projet ENREGISTRÉ gagne une option ».
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
  projectId,
  git,
  isOwner,
}: {
  /** L'identité du projet enregistré. Le serveur va chercher SON chemin. */
  projectId: string;
  git: ProjectGit;
  isOwner: boolean;
}) {
  const [busy, startTransition] = useTransition();
  /** Ce que le serveur a rendu depuis le dernier geste — la ligne relue. */
  const [etat, setEtat] = useState<ProjectGit>(git);
  /** Ce que le serveur vient de répondre — dit une fois, sous l'interrupteur. */
  const [dernier, setDernier] = useState<'initialised' | 'already' | 'off' | null>(null);
  const initGit = etat.initGit;
  const pose = etat.gitInitializedAt;

  function basculer(): void {
    if (!isOwner || busy) return;
    const cible = !initGit;
    startTransition(async () => {
      const r = await setCodeProjectInitGitAction({ projectId, initGit: cible });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setDernier(r.data.outcome === 'failed' ? null : r.data.outcome);
      // CE QUE LE SERVEUR A RENDU, jamais ce qu'on croyait avoir écrit : la
      // date de pose vient de la ligne relue (revue C, mineur 6).
      setEtat({
        initGit: r.data.initGit,
        gitInitializedAt: r.data.gitInitializedAt ? new Date(r.data.gitInitializedAt) : null,
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
          {/* Aucune classe de couleur : `Switch` porte la sienne depuis #238,
              et c'est tout l'intérêt de cette PR-là — l'interrupteur du serveur
              MCP avait l'air éteint en étant allumé parce que chaque appelant
              peignait le sien. */}
          <Switch
            checked={initGit}
            onChange={basculer}
            disabled={!isOwner || busy}
            size="md"
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
            The repository stays where it is. Turning this off never deletes one.
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
