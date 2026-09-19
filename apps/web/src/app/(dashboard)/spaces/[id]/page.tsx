// /spaces/[id] — LA PAGE D'UN PROJET : son ACTIVITÉ (#143, planche 444:347 v2).
//
// Ouvrir un projet, c'était atterrir dans le fil de SA conversation (P8,
// 07/09). Ce n'est plus le cas, et la planche v2 dit pourquoi : un projet a
// PLUSIEURS conversations, et des sessions qui n'en ont aucune — les runs
// lancés depuis le CLI, le serveur MCP ou un harnais dans son dossier, ce que
// l'onglet Code listait. Atterrir dans une seule de ces histoires cachait
// toutes les autres.
//
// Donc UNE liste, la plus récente d'abord, deux sortes de lignes. Une ligne de
// conversation ouvre le fil (`/chat/<id>`), où les sessions se déplient comme
// avant ; une ligne de session sans conversation ouvre la page du run
// (`/code/<id>`). Le fil n'a pas déménagé : il est là où il a toujours été.
//
// Le DOSSIER et la PREUVE sont sur l'autre onglet (`/spaces/[id]/files`).

import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import { getProjectActivityAction, getProjectFactsAction } from '@/lib/project-actions.ts';
import { listApprovalsAction } from '@/lib/actions.ts';
import { projectFactsLine } from '../project-header.ts';
import { activityRows } from '../activity-rows.ts';
import ProjectToolbar from '../ProjectToolbar.tsx';
import ProjectActivity from '../ProjectActivity.tsx';

// Force dynamic — le projet et son activité sont relus à chaque requête.
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [factsResult, activityResult, approvals] = await Promise.all([
    getProjectFactsAction(id),
    getProjectActivityAction(id),
    // Ce qui attend la personne — la MÊME lecture et la même attribution que
    // le menu de la barre latérale, jamais une seconde vérité.
    listApprovalsAction({ status: 'pending' }),
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
    <PageShell
      title={facts.name}
      subtitle={projectFactsLine(facts)}
      toolbar={
        <ProjectToolbar
          projectId={facts.id}
          projectPath={facts.path}
          projectName={facts.name}
          active="activity"
          // `null` quand la lecture a ÉCHOUÉ : l'onglet s'affiche sans chiffre
          // plutôt qu'avec un zéro qui affirmerait qu'il ne s'est rien passé.
          activityCount={activityResult.ok ? activityResult.data.total : null}
        />
      }
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
    </PageShell>
  );
}
