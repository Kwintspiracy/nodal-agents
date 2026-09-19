// /spaces/[id]/files — L'ONGLET « FILES & PROOF » d'un projet (#143).
//
// Ce que Quentin appelle « les réglages de mon projet » : où le dossier est, ce
// qu'il contient, ce que la preuve en dit, et les commandes qui la produisent.
//
// Le PANNEAU DE PREUVE arrive ici avec #143. Il vivait sur l'onglet Code, dans
// la branche « projet ouvert » d'une table de sessions — le seul écran qui fût
// celui du projet, faute de mieux. Le projet a maintenant sa page : sa preuve y
// est, à côté de ses fichiers et de la preuve déjà affichée.
//
// Les CONVERSATIONS ne sont plus listées ici : elles sont sur l'onglet
// Activity, avec les sessions, dans une seule histoire du projet.

import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import { getProjectFactsAction, getProjectPageAction } from '@/lib/project-actions.ts';
import { getCodeTabOwnerAction, listCodeProjectPrefsAction } from '@/lib/actions.ts';
import { projectKey } from '@nodal-agents/shared';
import type { VerificationUnconfiguredView } from '@/lib/verification-runs-view.ts';

import { projectFactsLine } from '../../project-header.ts';
import ProjectToolbar from '../../ProjectToolbar.tsx';
import ProjectShelf from '../../ProjectShelf.tsx';
import ProjectProof from '../../ProjectProof.tsx';
import type { ProjectVerification } from '../../ProjectVerificationPanel.tsx';

// Force dynamic — le dossier est relu à chaque requête.
export const dynamic = 'force-dynamic';

export default async function ProjectFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [factsResult, pageResult, prefsResult, ownerResult] = await Promise.all([
    getProjectFactsAction(id),
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
  if (!pageResult.ok) {
    if (pageResult.code === 'not_found') notFound();
    return (
      <PageShell title={factsResult.data.name}>
        <p className="text-sm text-err">{pageResult.message}</p>
      </PageShell>
    );
  }

  const facts = factsResult.data;
  const { project, files, proof } = pageResult.data;

  // Ce que la preuve n'a pas pu éprouver, dans la forme que `VerificationSection`
  // attend. Le type de livrable suit la SORTE du projet : dire « pas de
  // commandes configurées » d'un dossier de documents enverrait son
  // propriétaire chercher un réglage qui n'existe pas pour lui.
  const unconfigured: VerificationUnconfiguredView[] =
    proof.approval === 'approved'
      ? []
      : [
          {
            deliverableType: project.kind === 'documents' ? 'office_file' : 'code_project',
            canonicalKey: project.path,
            displayPath: project.path,
            reason: proof.approval,
          },
        ];

  // L'état de la séquence de preuve, retrouvé par CLÉ d'identité — jamais par
  // égalité de texte sur le chemin. `null` quand aucune ligne n'existe encore,
  // ou quand la lecture a échoué : le panneau dit alors « rien de configuré »,
  // le repli sûr — il ne prétend jamais qu'une séquence est approuvée.
  const cle = projectKey(project.path);
  const prefs = prefsResult.ok
    ? (prefsResult.data.find((p) => projectKey(p.projectPath) === cle) ?? null)
    : null;
  const verification: ProjectVerification | null = prefs
    ? {
        verifyCommands: prefs.verifyCommands,
        verifyApprovedAt: prefs.verifyApprovedAt,
        verifyManifestHash: prefs.verifyManifestHash,
        verifyStatus: prefs.verifyStatus,
        verifySource: prefs.verifySource,
      }
    : null;

  return (
    <PageShell
      title={facts.name}
      subtitle={projectFactsLine(facts)}
      toolbar={
        <ProjectToolbar
          projectId={facts.id}
          projectPath={facts.path}
          projectName={facts.name}
          active="files"
          activityCount={facts.conversations + facts.sessionsWithoutConversation}
        />
      }
    >
      <ProjectShelf project={project} files={files} proof={proof} unconfigured={unconfigured} />

      {/* Les commandes qui PRODUISENT la preuve, sous ce qu'elles ont donné.
          Un projet de DOCUMENTS n'en a pas : il n'exécute rien, et lui offrir
          un champ de commandes serait un réglage sans effet. */}
      {project.kind !== 'documents' && (
        <div className="mx-auto mt-8 max-w-[840px]">
          {!prefsResult.ok && (
            <p className="mb-2 text-body-12 text-err">
              The proof commands could not be read: {prefsResult.message}
            </p>
          )}
          <ProjectProof
            projectPath={project.path}
            initialVerification={verification}
            // La lecture en échec vaut NON-propriétaire : un panneau éditable
            // sur une lecture ratée offrirait un geste que le serveur
            // refuserait ensuite.
            isOwner={ownerResult.ok ? ownerResult.data.isOwner : false}
          />
        </div>
      )}
    </PageShell>
  );
}
