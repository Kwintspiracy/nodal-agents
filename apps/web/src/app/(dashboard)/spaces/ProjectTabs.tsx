// ProjectTabs — les deux onglets d'un projet ouvert (#143).
//
//   ACTIVITY      — ce qui s'est passé : les conversations et les sessions.
//   FILES & PROOF — le dossier, ses fichiers, et la preuve du projet.
//
// Ce sont deux ROUTES, pas deux états : chacune se partage, se met en favori et
// s'ouvre dans un onglet du navigateur. D'où des LIENS, et pas `PillTabs` — le
// composant du design system est un interrupteur contrôlé qui rend des
// `<button>`, et un bouton ne s'ouvre pas dans un nouvel onglet. La géométrie
// et les couleurs sont les siennes, à l'identique (variante `dark-active`), et
// c'est la seule chose que ce fichier emprunte.

import Link from 'next/link';

/** Le puits et la pastille active — les valeurs de `PillTabs variant="dark-active"`. */
const WELL = 'inline-flex gap-0.5 rounded-md p-[3px] bg-black/[0.04]';
const TAB =
  'inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-medium-12 transition-colors';
const ACTIVE = 'bg-ink text-canvas';
const IDLE = 'text-ink-3 hover:text-ink';

export type ProjectTab = 'activity' | 'files';

export default function ProjectTabs({
  projectId,
  active,
  activityCount,
}: {
  projectId: string;
  active: ProjectTab;
  /**
   * Combien de lignes l'onglet Activity porte. `null` quand la lecture a
   * ÉCHOUÉ : l'onglet s'affiche alors SANS chiffre, plutôt qu'avec un zéro
   * qui affirmerait qu'il ne s'est rien passé (invariant #4).
   */
  activityCount: number | null;
}) {
  return (
    <div className={WELL} role="tablist">
      <Link
        href={`/spaces/${projectId}`}
        role="tab"
        aria-selected={active === 'activity'}
        className={`${TAB} ${active === 'activity' ? ACTIVE : IDLE}`}
      >
        Activity
        {activityCount !== null && (
          <span className="text-mono-11 opacity-70">· {activityCount}</span>
        )}
      </Link>
      <Link
        href={`/spaces/${projectId}/files`}
        role="tab"
        aria-selected={active === 'files'}
        className={`${TAB} ${active === 'files' ? ACTIVE : IDLE}`}
      >
        Files &amp; proof
      </Link>
    </div>
  );
}
