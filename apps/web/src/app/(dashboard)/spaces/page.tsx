// /spaces — LA SEULE PAGE DES PROJETS (#143).
//
// Spaces listait des jobs ; il a listé des PROJETS déclarés (P8) ; il liste
// maintenant TOUS les projets — ceux du registre et les dossiers où un agent a
// écrit sans que personne les ait déclarés. Deux pages listaient la même chose
// sous deux origines (`/code` dérivait, `/spaces` déclarait), et l'origine
// n'intéresse personne au moment de chercher son projet : elle est devenue un
// attribut de la ligne.
//
// Un job n'est toujours pas un espace : il commence, il finit, il disparaît de
// l'écran. Son fil vit là où il a un sens — dans sa conversation (/chat/<id>)
// ou, pour un run d'automatisation, sur /scheduled/<id>.

import { listCodingProcessesAction, listCodeProjectPrefsAction } from '@/lib/actions.ts';
import {
  listExcludedProjectPathsAction,
  listProjectsAction,
  listProofsForPathsAction,
} from '@/lib/project-actions.ts';
import { mergeWorkspaces, workspacesSubtitle } from '@/lib/workspaces.ts';
import type { WorkspaceProofRun } from '@/lib/workspaces.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import WorkspacesList from './WorkspacesList.tsx';
import NewProjectButton from './NewProjectButton.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function SpacesPage() {
  // Quatre lectures BORNÉES, une par liste, jamais une par ligne : le registre,
  // les sessions de code (la détection, plafonnée comme dans l'onglet Code),
  // les deux gestes du propriétaire avec l'état de configuration des preuves,
  // et les dossiers qu'il a ÉCARTÉS (#385).
  const [projectsResult, sessionsResult, prefsResult, excludedResult] = await Promise.all([
    listProjectsAction(),
    listCodingProcessesAction(),
    listCodeProjectPrefsAction(),
    listExcludedProjectPathsAction(),
  ]);

  // Une lecture en ÉCHEC ne se traduit pas par « rien à montrer » : elle se
  // dit. Le registre est la source principale — sans lui la page n'a rien à
  // rendre. Un échec de la DÉTECTION ou des préférences, lui, ne vide pas la
  // page : il retire les lignes détectées, et la page le dit en une phrase
  // plutôt que de laisser croire qu'aucun agent n'a jamais écrit nulle part.
  const projects = projectsResult.ok ? projectsResult.data : [];
  const prefs = prefsResult.ok ? prefsResult.data : [];
  const excluded = excludedResult.ok ? excludedResult.data : [];
  const excludedKeys = new Set(excluded.map((e) => e.key));
  // SANS la liste des dossiers écartés, la détection ne se rend PAS (#385).
  // Elle ne peut pas être filtrée, et la rendre entière ramènerait dans la
  // liste des dossiers que quelqu'un a retirés — un « smart fallback » qui
  // défait le geste au moment précis où il compte (invariant #4). La page le
  // dit, comme elle le dit déjà d'une détection en panne.
  const sessions = sessionsResult.ok && excludedResult.ok ? sessionsResult.data : [];
  const detectionError = !sessionsResult.ok
    ? sessionsResult.message
    : !prefsResult.ok
      ? prefsResult.message
      : !excludedResult.ok
        ? excludedResult.message
        : null;

  // Les dossiers DÉTECTÉS peuvent porter une preuve eux aussi : une séquence se
  // configure par clé de dossier, pas par appartenance au registre. Une
  // quatrième lecture bornée, et seulement s'il y a des dossiers détectés.
  const firstPass = mergeWorkspaces({ projects, sessions, prefs, excludedKeys });
  const detectedPaths = [...firstPass.rows, ...firstPass.hiddenRows]
    .filter((r) => r.kind === 'detected')
    .map((r) => r.path);
  const proofRuns = new Map<string, WorkspaceProofRun>();
  if (detectedPaths.length > 0) {
    const proofs = await listProofsForPathsAction(detectedPaths);
    if (proofs.ok) {
      for (const p of proofs.data) proofRuns.set(p.key, { verdict: p.verdict, at: p.at });
    }
  }
  const view =
    proofRuns.size > 0
      ? mergeWorkspaces({ projects, sessions, prefs, proofRuns, excludedKeys })
      : firstPass;

  const vide = view.rows.length === 0 && view.hiddenRows.length === 0 && excluded.length === 0;

  return (
    <PageShell
      // « Projects » (#364) : c'est le « See all » de la section PROJECTS de la
      // barre, et un « workspace » est autre chose — le dossier de travail d'un
      // agent. La ROUTE reste `/spaces` : un libellé n'a pas besoin de casser
      // une URL.
      title="Projects"
      {...(projectsResult.ok ? { subtitle: workspacesSubtitle(view.counts) } : {})}
      toolbar={
        <div className="flex items-center justify-end">
          <NewProjectButton />
        </div>
      }
    >
      {!projectsResult.ok ? (
        <p className="text-sm text-err">{projectsResult.message}</p>
      ) : (
        <>
          {detectionError !== null && (
            <p className="mb-3 text-body-12 text-err">
              Detected folders are missing from this list: {detectionError}
            </p>
          )}
          {vide ? (
            <EmptyState
              title="No project yet"
              description="Create one, or let an agent write in one of its folders: it shows up here."
            />
          ) : (
            <WorkspacesList view={view} excluded={excluded} />
          )}
        </>
      )}
    </PageShell>
  );
}
