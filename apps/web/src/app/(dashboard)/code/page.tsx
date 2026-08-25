import {
  listCodingProcessesAction,
  listCodeProjectPrefsAction,
  getCodeTabStatusAction,
} from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import { projectKey } from '@/lib/project-key.ts';
import CodeProcessesTable from './CodeProcessesTable.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function CodePage() {
  const [result, prefsResult, statusResult] = await Promise.all([
    listCodingProcessesAction(),
    listCodeProjectPrefsAction(),
    getCodeTabStatusAction(),
  ]);
  const rows = result.ok ? result.data : [];
  const prefs = prefsResult.ok ? prefsResult.data : [];
  const hidden = new Set(prefs.filter((p) => p.hidden).map((p) => projectKey(p.projectPath)));

  // Vue PAR PROJET (décision Quentin 25/08) : le sous-titre compte les projets,
  // pas les sessions — c'est l'unité que la page raconte. Les projets masqués
  // n'entrent pas dans le compte : ils ne sont pas dans la liste non plus.
  const visible = rows.filter((r) => !(r.projectPath && hidden.has(projectKey(r.projectPath))));
  const projectCount = new Set(visible.map((r) => r.projectPath ?? '__other__')).size;

  return (
    <PageShell
      title="Code"
      subtitle={`${projectCount} project${projectCount !== 1 ? 's' : ''} · ${visible.length} session${visible.length !== 1 ? 's' : ''}`}
    >
      <CodeProcessesTable
        initialRows={rows}
        initialPrefs={prefs}
        // `null` quand la lecture a ÉCHOUÉ — pas 0. Retomber sur 0 ferait
        // affirmer « aucun dossier attaché » à un espace qui en a peut-être
        // plein : un repli silencieux vers un état plausible est exactement ce
        // que l'invariant #4 interdit.
        workspaceCount={statusResult.ok ? statusResult.data.workspaceCount : null}
        error={!result.ok ? result.message : undefined}
      />
    </PageShell>
  );
}
