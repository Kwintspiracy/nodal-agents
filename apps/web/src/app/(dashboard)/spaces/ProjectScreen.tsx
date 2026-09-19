// ProjectScreen — LA page d'un projet, en UN écran (#143).
//
// À gauche ses CONVERSATIONS : une liste, la plus récente d'abord, deux sortes
// de lignes. Une ligne de conversation ouvre le fil (`/chat/<id>`), où les
// sessions se déplient comme avant ; une ligne de session sans conversation
// ouvre la page du run (`/code/<id>`).
//
// À droite son DOSSIER et sa PREUVE, dans un panneau ancré qui pousse la page
// au lieu de la couvrir (Quentin, 19/09). C'était un second onglet : il fallait
// quitter les conversations pour voir le dossier, et les quitter de nouveau
// pour revenir. Côte à côte, on lit les deux.
//
// Deux routes rendent cet écran, et c'est le seul écart entre elles :
// `/spaces/[id]` respecte le choix de la personne, `/spaces/[id]/files` ouvre
// le panneau d'office — cette adresse est dans des liens déjà envoyés et dans
// la barre d'un run, et elle veut dire « montre-moi le dossier ».

import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import { projectKey } from '@nodal-agents/shared';
import {
  getProjectActivityAction,
  getProjectFactsAction,
  getProjectPageAction,
} from '@/lib/project-actions.ts';
import {
  getCodeTabOwnerAction,
  listApprovalsAction,
  listCodeProjectPrefsAction,
} from '@/lib/actions.ts';

import { projectFactsLine } from './project-header.ts';
import { activityRows } from './activity-rows.ts';
import ProjectToolbar from './ProjectToolbar.tsx';
import ProjectActivity from './ProjectActivity.tsx';
import ProjectShelf from './ProjectShelf.tsx';
import ProjectProof from './ProjectProof.tsx';
import { ProjectPanelLayout, ProjectPanelProvider } from './ProjectPanel.tsx';
import type { ProjectVerification } from './ProjectVerificationPanel.tsx';

export default async function ProjectScreen({
  id,
  forceFilesOpen = false,
}: {
  id: string;
  forceFilesOpen?: boolean;
}) {
  const [factsResult, activityResult, approvals, pageResult, prefsResult, ownerResult] =
    await Promise.all([
      getProjectFactsAction(id),
      getProjectActivityAction(id),
      // Ce qui attend la personne — la MÊME lecture et la même attribution que
      // le menu de la barre latérale, jamais une seconde vérité.
      listApprovalsAction({ status: 'pending' }),
      getProjectPageAction(id),
      listCodeProjectPrefsAction(),
      getCodeTabOwnerAction(),
    ]);

  if (!factsResult.ok) {
    if (factsResult.code === 'not_found') notFound();
    return (
      <PageShell title="Project">
        <p className="text-sm text-err">{factsResult.message}</p>
      </PageShell>
    );
  }
  const facts = factsResult.data;

  const rows = activityResult.ok
    ? activityRows({
        conversations: activityResult.data.conversations,
        sessions: activityResult.data.sessions,
        waiting: approvals.ok
          ? approvals.data.map((a) => ({
              conversationId: a.conversationId,
              rootJobId: a.rootJobId,
              kind: a.kind,
            }))
          : [],
      })
    : [];

  return (
    <ProjectPanelProvider forceOpen={forceFilesOpen}>
      {/* PAS de `toolbar` ici, et c'est le point (Quentin, 19/09) : passée au
          `PageShell`, la barre faisait un bandeau pleine largeur AU-DESSUS du
          panneau. Elle vit dans la colonne de gauche, avec la liste qu'elle
          commande — voir `ProjectPanelLayout`. */}
      <PageShell fill title={facts.name} subtitle={projectFactsLine(facts)}>
        <ProjectPanelLayout
          title="Files & proof"
          toolbar={
            <ProjectToolbar
              projectId={facts.id}
              projectPath={facts.path}
              projectName={facts.name}
            />
          }
          panel={<FilesAndProof result={pageResult} prefs={prefsResult} owner={ownerResult} />}
        >
          {/* Une activité illisible est DITE, pas remplacée par une liste vide :
              « rien ne s'est passé » et « je n'ai pas pu lire » sont deux choses
              différentes (invariant #4). */}
          {!activityResult.ok ? (
            <p className="text-sm text-err">{activityResult.message}</p>
          ) : (
            <>
              {!approvals.ok && (
                <p className="mb-3 text-body-12 text-err">
                  What is waiting for you could not be read, so no row says it.
                </p>
              )}
              <ProjectActivity rows={rows} />
            </>
          )}
        </ProjectPanelLayout>
      </PageShell>
    </ProjectPanelProvider>
  );
}

/**
 * Le contenu du panneau : le dossier, ses fichiers, la preuve, et les commandes
 * qui la produisent.
 *
 * Une lecture en échec se DIT ici aussi : le panneau qui ne sait pas ce que
 * porte le dossier ne dessine pas un dossier vide.
 */
function FilesAndProof({
  result,
  prefs,
  owner,
}: {
  result: Awaited<ReturnType<typeof getProjectPageAction>>;
  prefs: Awaited<ReturnType<typeof listCodeProjectPrefsAction>>;
  owner: Awaited<ReturnType<typeof getCodeTabOwnerAction>>;
}) {
  if (!result.ok) return <p className="text-sm text-err">{result.message}</p>;
  const { project, files, proof } = result.data;

  // L'état de la séquence de preuve, retrouvé par CLÉ d'identité — jamais par
  // égalité de texte sur le chemin. `null` quand aucune ligne n'existe encore,
  // ou quand la lecture a échoué : le panneau dit alors « rien de configuré »,
  // le repli sûr — il ne prétend jamais qu'une séquence est approuvée.
  const cle = projectKey(project.path);
  const ligne = prefs.ok
    ? (prefs.data.find((p) => projectKey(p.projectPath) === cle) ?? null)
    : null;
  const verification: ProjectVerification | null = ligne
    ? {
        verifyCommands: ligne.verifyCommands,
        verifyApprovedAt: ligne.verifyApprovedAt,
        verifyManifestHash: ligne.verifyManifestHash,
        verifyStatus: ligne.verifyStatus,
        verifySource: ligne.verifySource,
      }
    : null;

  return (
    <>
      <ProjectShelf project={project} files={files} proof={proof} />

      {/* Les commandes qui PRODUISENT la preuve, sous ce qu'elles ont donné.
          Un projet de DOCUMENTS n'en a pas : il n'exécute rien, et lui offrir
          un champ de commandes serait un réglage sans effet. */}
      {project.kind !== 'documents' && (
        <div className="mt-2">
          {!prefs.ok && (
            <p className="mb-2 text-body-12 text-err">
              The proof commands could not be read: {prefs.message}
            </p>
          )}
          <ProjectProof
            projectPath={project.path}
            initialVerification={verification}
            // La lecture en échec vaut NON-propriétaire : un panneau éditable
            // sur une lecture ratée offrirait un geste que le serveur
            // refuserait ensuite.
            isOwner={owner.ok ? owner.data.isOwner : false}
          />
        </div>
      )}
    </>
  );
}
