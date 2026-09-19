// `/` — LE DÉFAUT DE NODAL : une conversation neuve (#248, décision de Quentin
// du 19/09).
//
// Ce pour quoi on ouvre Nodal, c'est parler à son agent. La racine rendait le
// Dashboard — un tableau de chiffres devant lequel il fallait encore choisir où
// aller. Elle rend maintenant l'écran vide du fil ; le Dashboard vit sur
// `/dashboard`, la même page, à une autre adresse.
//
// AUCUNE LIGNE N'EST ÉCRITE ICI. Ouvrir cette page ne crée pas de conversation :
// c'est le premier envoi qui la crée, puis l'écran s'en va sur `/chat/<id>`.
// C'est le fond de #248 — « New conversation » créait la ligne d'abord, et la
// boîte de réception se remplissait de fils vides jamais écrits.
//
// `?project=<id>` : le même écran, PORTANT un projet. C'est par là que passe le
// « New conversation » du dossier d'un projet — la conversation créée au premier
// envoi naît alors ancrée à ce projet. Un paramètre plutôt qu'une seconde route
// avec son propre en-tête : il n'y a qu'un écran de conversation neuve, et deux
// dessins auraient divergé au premier correctif.

import PageShell from '@/components/ui/PageShell';
import NewConversationScreen from './chat/NewConversationScreen.tsx';
import { getNewConversationAction } from '@/lib/conversation-actions.ts';
import { getAgentModelChoicesAction, getFeedDensityAction } from '@/lib/actions.ts';
import { DEFAULT_FEED_DENSITY } from '@/lib/feed-density.ts';

// Force dynamic — le ROOT, le nom du compte et la densité sont relus à chaque
// visite, comme les trois écrans de fil.
export const dynamic = 'force-dynamic';

export default async function NewConversationPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params.project;
  const projectId = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);

  const result = await getNewConversationAction(projectId);
  if (!result.ok) {
    // Un chargement en échec se DIT (inv. #4) : sans le ROOT ni le projet, une
    // saisie ouverte enverrait le message on ne sait où.
    return (
      <PageShell title="New conversation">
        <p className="text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }
  const { accountName, root, project } = result.data;

  // #138 — les listes de la saisie portent les réglages du ROOT, celui qui
  // recevra la conversation. Pas de ROOT : rien à régler, et pas de saisie.
  const choices = root !== null ? await getAgentModelChoicesAction(root.id) : null;
  const modelChoices = choices?.ok ? choices.data : null;
  // #132 — une densité illisible ne fait pas rougir l'écran : le défaut dessiné.
  const densityResult = await getFeedDensityAction();
  const density = densityResult.ok ? densityResult.data : DEFAULT_FEED_DENSITY;

  return (
    <NewConversationScreen
      accountName={accountName}
      root={root}
      project={project}
      density={density}
      llmKeyId={modelChoices?.llmKeyId ?? null}
      model={modelChoices?.model ?? null}
      reasoningEffort={modelChoices?.reasoningEffort ?? null}
      llmKeys={modelChoices?.llmKeys ?? []}
      requireTools={modelChoices?.requireTools ?? false}
    />
  );
}
