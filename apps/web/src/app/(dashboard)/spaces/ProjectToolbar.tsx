// ProjectToolbar — la barre des DEUX onglets d'un projet (#143).
//
// D'où l'on vient, où l'on est, et les deux gestes du projet. Partagée par
// `/spaces/[id]` et `/spaces/[id]/files` : deux barres auraient divergé au
// premier correctif, et l'onglet actif est le seul détail qui change.

import Link from 'next/link';
import NewProjectConversationButton from './NewProjectConversationButton.tsx';
import RenameProjectButton from './RenameProjectButton.tsx';
import ProjectTabs, { type ProjectTab } from './ProjectTabs.tsx';

export default function ProjectToolbar({
  projectId,
  projectPath,
  projectName,
  active,
  activityCount,
}: {
  projectId: string;
  projectPath: string;
  projectName: string;
  active: ProjectTab;
  activityCount: number | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Link
        href="/spaces"
        className="inline-flex w-fit items-center gap-1.5 text-body-13 text-ink-3 transition-colors hover:text-ink-2"
      >
        <span className="text-body-15 leading-none!">‹</span>
        Workspaces
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ProjectTabs projectId={projectId} active={active} activityCount={activityCount} />
        <div className="flex items-center gap-2">
          <NewProjectConversationButton projectId={projectId} />
          <RenameProjectButton projectPath={projectPath} currentName={projectName} />
        </div>
      </div>
    </div>
  );
}
