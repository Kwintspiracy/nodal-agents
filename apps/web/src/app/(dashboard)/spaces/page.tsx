// /spaces — LE REGISTRE DES PROJETS (P8).
//
// Spaces listait des jobs ; il liste maintenant des PROJETS. Un job n'est pas
// un espace : il commence, il finit, il disparaît de l'écran. Un projet reste —
// c'est un dossier, un agent responsable, des conversations et une preuve. Le
// fil d'un job vit là où il a un sens : dans sa conversation (/chat/<id>) ou,
// pour un run d'automatisation, sur /scheduled/<id>.

import { listProjectsAction } from '@/lib/project-actions.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import ProjectsTable from './ProjectsTable.tsx';
import NewProjectButton from './NewProjectButton.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function SpacesPage() {
  const result = await listProjectsAction();
  const projects = result.ok ? result.data : [];

  return (
    <PageShell
      title="Spaces"
      subtitle="Your projects: a folder each, with its conversations and its proof."
      toolbar={
        <div className="flex items-center justify-end">
          <NewProjectButton />
        </div>
      }
    >
      {!result.ok ? (
        <p className="text-sm text-err">{result.message}</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No project yet"
          description="Create one, or let an agent produce something in a registered folder."
        />
      ) : (
        <ProjectsTable rows={projects} />
      )}
    </PageShell>
  );
}
