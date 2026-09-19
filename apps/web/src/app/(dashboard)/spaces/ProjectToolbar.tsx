// ProjectToolbar — la barre d'un projet ouvert (#143).
//
// Où l'on est, et les deux gestes du projet. Partagée par `/spaces/[id]` et
// `/spaces/[id]/files` : deux barres auraient divergé au premier correctif, et
// l'onglet actif est le seul détail qui change.
//
// PAS de « ‹ Workspaces » ici (Quentin, 19/09). Cette page porte l'en-tête
// ordinaire du tableau de bord — titre, sous-titre, barre d'outils, et le filet
// dessous — comme presque toutes les autres. Un bandeau de retour posé au-
// dessus de la barre en faisait un motif à part, que rien d'autre ne dessine.

import NewProjectConversationButton from './NewProjectConversationButton.tsx';
import RenameProjectButton from './RenameProjectButton.tsx';
import ProjectTabs, { type ProjectTab } from './ProjectTabs.tsx';

export default function ProjectToolbar({
  projectId,
  projectPath,
  projectName,
  active,
  conversationsCount,
}: {
  projectId: string;
  projectPath: string;
  projectName: string;
  active: ProjectTab;
  conversationsCount: number | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ProjectTabs projectId={projectId} active={active} conversationsCount={conversationsCount} />
      <div className="flex items-center gap-2">
        <NewProjectConversationButton projectId={projectId} />
        <RenameProjectButton projectPath={projectPath} currentName={projectName} />
      </div>
    </div>
  );
}
