// /spaces/[id]/files — LA PAGE D'UN PROJET, son dossier OUVERT (#143).
//
// Plus un second écran : le même que `/spaces/[id]`, avec le panneau « Files &
// proof » ouvert d'office. Cette adresse est dans des liens déjà envoyés et
// dans la barre d'un run de code, et elle veut dire « montre-moi le dossier » —
// y répondre par une page dont le panneau est refermé serait une promesse non
// tenue. La personne peut le refermer ensuite, et son choix redevient le sien.

import ProjectScreen from '../../ProjectScreen.tsx';

// Force dynamic — le dossier est relu à chaque requête.
export const dynamic = 'force-dynamic';

export default async function ProjectFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Le panneau est ouvert par défaut partout depuis le 20/09 : cette adresse
  // rend la même page, et reste pour les liens déjà envoyés.
  return <ProjectScreen id={id} />;
}
