import {
  listCodingProcessesAction,
  listCodeProjectPrefsAction,
  getCodeTabStatusAction,
  getCodeTabOwnerAction,
} from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import { projectKey } from '@nodal-agents/shared';
import CodeProcessesTable from './CodeProcessesTable.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function CodePage() {
  const [result, prefsResult, statusResult, ownerResult] = await Promise.all([
    listCodingProcessesAction(),
    listCodeProjectPrefsAction(),
    getCodeTabStatusAction(),
    getCodeTabOwnerAction(),
  ]);
  const rows = result.ok ? result.data : [];
  // Une lecture de préférences en ÉCHEC ne se traduit pas par « rien de rangé »
  // (revue Codex, 26/08) : ce repli remontrait tous les projets masqués et
  // perdrait tous les noms choisis, sans que rien ne le dise. L'écran
  // afficherait un état plausible et faux — exactement ce que l'invariant #4
  // interdit. On remonte donc l'erreur comme pour la liste des sessions.
  const prefs = prefsResult.ok ? prefsResult.data : [];
  const readError = !result.ok ? result.message : !prefsResult.ok ? prefsResult.message : undefined;
  const hidden = new Set(prefs.filter((p) => p.hidden).map((p) => projectKey(p.projectPath)));

  // Vue PAR PROJET (décision Quentin 25/08) : le sous-titre compte les projets,
  // pas les sessions — c'est l'unité que la page raconte. Les projets masqués
  // n'entrent pas dans le compte : ils ne sont pas dans la liste non plus.
  const visible = rows.filter((r) => !(r.projectPath && hidden.has(projectKey(r.projectPath))));
  // MÊME clé que la table (revue Codex, 26/08) : sur Windows, deux sessions du
  // même dossier peuvent porter des casses différentes. La table les groupe en
  // une carte ; compter les chemins bruts annoncerait deux projets pour une
  // seule carte affichée.
  const projectCount = new Set(
    visible.map((r) => (r.projectPath ? projectKey(r.projectPath) : '__other__')),
  ).size;

  return (
    <PageShell
      title="Code"
      subtitle={`${projectCount} project${projectCount !== 1 ? 's' : ''} · ${visible.length} session${visible.length !== 1 ? 's' : ''}`}
    >
      <CodeProcessesTable
        initialRows={rows}
        initialPrefs={prefs}
        // La lecture en échec vaut NON-propriétaire : un panneau de preuve
        // éditable par défaut sur une lecture ratée offrirait un geste que le
        // serveur refuserait ensuite. Le refus est le repli sûr, et il est
        // dit à l'écran (« owner only »).
        isOwner={ownerResult.ok ? ownerResult.data.isOwner : false}
        // `null` quand la lecture a ÉCHOUÉ — pas 0. Retomber sur 0 ferait
        // affirmer « aucun dossier attaché » à un espace qui en a peut-être
        // plein : un repli silencieux vers un état plausible est exactement ce
        // que l'invariant #4 interdit.
        workspaceCount={statusResult.ok ? statusResult.data.workspaceCount : null}
        hiddenWorkspaceCount={statusResult.ok ? statusResult.data.hiddenWorkspaceCount : 0}
        error={readError}
      />
    </PageShell>
  );
}
