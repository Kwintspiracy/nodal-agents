// ThreadHeader — l'en-tête d'un écran de fil (#135, cadre « Thread, folded »).
//
// Trois écrans lisent le même fil : la conversation (/chat/[id]), le projet
// (/spaces/[id]) et le run (/scheduled/[id]). Ils portaient jusqu'ici le titre
// d'affichage du design system — un h1 de 28 px — alors que la maquette dessine
// une LIGNE DE FAITS : l'avatar de l'agent, son nom suivi de ce dont il est
// question, puis d'où ça vient et depuis quand.
//
// Le composant ne déduit rien : il reçoit un titre et un sous-titre déjà
// composés. C'est la seule façon que les trois écrans partagent la géométrie
// sans partager leur sémantique — le titre d'un projet est son nom, celui d'un
// run sa première ligne, celui d'une conversation le nom de l'agent et le
// sujet.

import AgentAvatar from '@/components/ui/AgentAvatar';

export default function ThreadHeader({
  avatarName,
  avatarUrl = null,
  title,
  subtitle,
}: {
  /** De quoi tirer les initiales quand l'agent n'a pas d'image. */
  avatarName: string;
  /** L'image de l'agent, quand il en a une. */
  avatarUrl?: string | null;
  /** La ligne du haut : « <agent> · <sujet> », le nom du projet, … */
  title: string;
  /** La ligne du bas : provenance, chemin, ouverture du fil. */
  subtitle: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <AgentAvatar name={avatarName} imageUrl={avatarUrl} size="md" shape="square" />
      <div className="flex min-w-0 flex-col gap-0.5">
        {/* Un `h1`, et pas un paragraphe : c'est le TITRE de la page. Le mode
            `header` de `PageHeader` remplace le titre d'affichage, donc l'écran
            n'en a plus d'autre — un fil sans h1 n'a plus de nom pour un lecteur
            d'écran ni pour le parcours de fumée. */}
        <h1 className="truncate text-title-16 text-ink">{title}</h1>
        <p className="truncate text-mono-11 text-ink-4">{subtitle}</p>
      </div>
    </div>
  );
}
