// /spaces/[id] — LA PAGE D'UN PROJET (P8).
//
// Trois choses, dans cet ordre : l'étagère (le dossier, ses fichiers, sa
// preuve), ce qui s'est dit autour du projet, et la conversation qu'on
// continue en bas. C'est l'ordre d'une visite : on regarde où on est, on lit
// ce qui a été dit, on répond.
//
// La page du FIL D'UN JOB n'est plus ici : elle vit sur /scheduled/[id] pour un
// run d'automatisation, et dans /chat/[id] pour tout le reste.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import { getProjectPageAction } from '@/lib/project-actions.ts';
import { getConversationThreadAction } from '@/lib/conversation-actions.ts';
import type { VerificationUnconfiguredView } from '@/lib/verification-runs-view.ts';
import ProjectShelf from '../ProjectShelf.tsx';
import ProjectConversations from '../ProjectConversations.tsx';
import ProjectThread from '../ProjectThread.tsx';
import NewProjectConversationButton from '../NewProjectConversationButton.tsx';

// Force dynamic — le projet, son dossier et son fil sont relus à chaque requête.
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getProjectPageAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Project">
        <Link href="/spaces" className="text-xs text-ink-3 hover:text-ink-2">
          ← Spaces
        </Link>
        <p className="mt-4 text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { project, files, proof, conversations, projectConversationId } = result.data;

  // Le fil de la conversation du projet — la MÊME lecture que /chat/[id] (P7).
  const thread =
    projectConversationId === null
      ? null
      : await getConversationThreadAction(projectConversationId);

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

  const subtitle = [
    project.kind,
    project.agentName,
    `${conversations.length} ${conversations.length === 1 ? 'conversation' : 'conversations'}`,
  ]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(' · ');

  return (
    <PageShell
      title={project.name}
      subtitle={subtitle}
      toolbar={
        <div className="flex items-center gap-3">
          <Link href="/spaces" className="text-xs text-ink-3 hover:text-ink-2">
            ← Spaces
          </Link>
          {projectConversationId !== null && (
            <Link
              href={`/chat/${projectConversationId}`}
              className="text-xs text-ink-3 hover:text-ink-2"
            >
              Open in Chat
            </Link>
          )}
          <span className="ml-auto">
            <NewProjectConversationButton projectId={project.id} />
          </span>
        </div>
      }
    >
      <ProjectShelf project={project} files={files} proof={proof} unconfigured={unconfigured} />

      <div className="mx-auto mt-8 max-w-[840px]">
        <p className="mb-2 text-label-11 uppercase tracking-wider text-ink-4">Conversations</p>
        {conversations.length === 0 ? (
          <EmptyState
            title="No conversation yet"
            description="Write below, and this project gets its own."
            compact
          />
        ) : (
          <ProjectConversations rows={conversations} />
        )}
      </div>

      {/* Le fil et la saisie : un échec de lecture y est DIT, et retire la
          saisie (revue passe 30, constat 1). */}
      <ProjectThread
        projectId={project.id}
        conversationId={projectConversationId}
        thread={thread}
      />
    </PageShell>
  );
}
