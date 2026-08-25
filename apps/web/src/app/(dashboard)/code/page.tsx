import {
  listCodingProcessesAction,
  listArchivedCodeProjectsAction,
  countDevTeamAgentsAction,
} from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import CodeProcessesTable from './CodeProcessesTable.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function CodePage() {
  const [result, archivedResult, devTeamResult] = await Promise.all([
    listCodingProcessesAction(),
    listArchivedCodeProjectsAction(),
    countDevTeamAgentsAction(),
  ]);
  const rows = result.ok ? result.data : [];
  // Vue PAR PROJET (décision Quentin 25/08) : le sous-titre compte les
  // projets, pas les sessions — c'est l'unité que la page raconte désormais.
  const projectCount = new Set(rows.map((r) => r.projectPath ?? '__other__')).size;

  return (
    <PageShell
      title="Code"
      subtitle={`${projectCount} project${projectCount !== 1 ? 's' : ''} · ${rows.length} session${rows.length !== 1 ? 's' : ''}`}
    >
      <CodeProcessesTable
        initialRows={rows}
        initialArchivedPaths={archivedResult.ok ? archivedResult.data : []}
        devTeamCount={devTeamResult.ok ? devTeamResult.data : 0}
        error={!result.ok ? result.message : undefined}
      />
    </PageShell>
  );
}
