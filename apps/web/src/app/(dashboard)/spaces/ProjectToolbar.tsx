// ProjectToolbar — LES GESTES d'un projet ouvert (#143).
//
// Trois : ouvrir une conversation, le renommer, montrer ou cacher son dossier
// et sa preuve. Ils vivent dans la rangée d'actions (`ActionRow`), SOUS la
// `WorkBar` — jamais sur la ligne du retour (#242, constat du 19/09 : un
// retour entouré de boutons n'est plus un retour), jamais dans un bandeau
// pleine largeur au-dessus du panneau.
//
// PAS de retour ici : il est dans la barre, et nulle part ailleurs.
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
    <>
      <NewProjectConversationButton projectId={projectId} />
      <RenameProjectButton projectPath={projectPath} currentName={projectName} />
      <ProjectPanelButton />
    </>
  );
}
