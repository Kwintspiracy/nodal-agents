// ProjectToolbar — la barre d'un projet ouvert (#143).
//
// Les trois gestes du projet : ouvrir une conversation, le renommer, et montrer
// ou cacher son dossier et sa preuve.
//
// PAS de « ‹ Workspaces » ici (Quentin, 19/09). Cette page porte l'en-tête
// ordinaire du tableau de bord — titre, sous-titre, barre d'outils, et le filet
// dessous — comme presque toutes les autres. Un bandeau de retour posé au-
// dessus de la barre en faisait un motif à part, que rien d'autre ne dessine.
//
// PAS D'ONGLETS non plus, depuis le 19/09 : « Files & proof » n'est plus un
// second écran, c'est un panneau qui s'ouvre À CÔTÉ des conversations.

import NewProjectConversationButton from './NewProjectConversationButton.tsx';
import RenameProjectButton from './RenameProjectButton.tsx';
import { ProjectPanelButton } from './ProjectPanel.tsx';

export default function ProjectToolbar({
  projectId,
  projectPath,
  projectName,
}: {
  projectId: string;
  projectPath: string;
  projectName: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <NewProjectConversationButton projectId={projectId} />
      <RenameProjectButton projectPath={projectPath} currentName={projectName} />
      <ProjectPanelButton />
    </div>
  );
}
