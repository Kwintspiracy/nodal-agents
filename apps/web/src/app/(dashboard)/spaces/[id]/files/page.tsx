// /spaces/[id]/files — LE DOSSIER D'UN PROJET : où il est, ce qu'il contient,
// sa preuve, et les conversations qui y ont travaillé (P8, sorti de la page du
// projet le 07/09).
//
// Ce que Quentin appelle « les réglages de mon projet » : ça se consulte, ça
// ne se lit pas en ouvrant le projet. La page du projet (/spaces/[id]) est sa
// conversation ; le bouton « Files » de l'en-tête mène ici, et « ← <projet> »
// ramène au fil.

import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import BackButton from '@/components/ui/BackButton';
import EmptyState from '@/components/ui/EmptyState';
import { getProjectPageAction } from '@/lib/project-actions.ts';
import type { VerificationUnconfiguredView } from '@/lib/verification-runs-view.ts';

import ProjectShelf from '../../ProjectShelf.tsx';
import ProjectConversations from '../../ProjectConversations.tsx';
import NewProjectConversationButton from '../../NewProjectConversationButton.tsx';

// Force dynamic — le dossier est relu à chaque requête.
export const dynamic = 'force-dynamic';

export default async function ProjectFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getProjectPageAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Project">
        <BackButton parent="/spaces" label="Workspaces" className="text-xs hover:text-ink-2" />
        <p className="mt-4 text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { project, files, proof, conversations } = result.data;

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

  return (
    <PageShell
      title={project.name}
      subtitle={project.path}
      toolbar={
        <div className="flex items-center gap-3">
          {/* #232 — le fil du projet est le PARENT de son dossier, pas la seule
              destination : on revient d'abord à la page d'où l'on vient. */}
          <BackButton
            parent={`/spaces/${project.id}`}
            label={`Back to ${project.name}`}
            className="text-body-13 hover:text-ink-2"
          />
          <span className="ml-auto">
            <NewProjectConversationButton projectId={project.id} />
          </span>
        </div>
      }
    >
      <ProjectShelf project={project} files={files} proof={proof} unconfigured={unconfigured} />

      {/* Les conversations qui portent un travail du projet, la plus récente
          en tête : la page du projet ouvre sur la première, les autres se
          lisent d'ici. */}
      <div className="mx-auto mt-8 max-w-[840px]">
        <p className="mb-2 text-label-11 uppercase tracking-wider text-ink-4">Conversations</p>
        {conversations.length === 0 ? (
          <EmptyState
            title="No conversation yet"
            description="Open the project and write: it gets its own."
            compact
          />
        ) : (
          <ProjectConversations rows={conversations} />
        )}
      </div>
    </PageShell>
  );
}
