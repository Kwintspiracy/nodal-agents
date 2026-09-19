// ConversationRow — une ligne de la boîte de réception d'un dossier (#135).
//
// La maquette (composant `ConversationRow`) : 56 px de haut, l'avatar carré de
// l'agent, puis deux lignes — son nom et le nom du chat en étiquette mono, le
// dernier mot en dessous — l'heure à droite, et UN SEUL signe de ce qui s'y
// passe.
//
// Ce signe est unique par décision, pas par manque de place : une pastille
// « Question asked », une pastille « Approval pending », ou un point vert. Les
// trois ensemble ne se lisent plus, et ils disent trois choses de nature
// différente — deux attentes qui appellent la personne, un run qui n'attend
// rien d'elle. Le calcul de laquelle gagne vit dans `conversation-rows.ts`,
// pas ici : ce composant DESSINE, il ne décide pas.
//
// NON LU, ET PAS DE QUATRIÈME SIGNE (#209, 19/09/2026). La maquette dessinait
// une pastille « Unread » à droite. Elle n'est toujours pas rendue, et cette
// fois ce n'est plus faute de donnée — la base porte un état de lecture depuis
// la migration 0111 — mais par décision du propriétaire : une pastille de plus
// entrerait en concurrence avec les trois signes qui disent ce que le fil
// ATTEND, alors que « non lu » ne demande rien à personne. C'est le TITRE qui
// change de poids, comme dans n'importe quelle boîte de réception, et il n'y a
// aucun mot « Unread » à lire.
//
// Les DEUX poids existent déjà dans le design system, à la même taille et au
// même interlignage : `text-medium-14` (500) et `text-body-14` (400). La ligne
// non lue garde le poids fort — celui de toutes les lignes jusqu'ici — et la
// ligne LUE s'allège. Rien ne bouge de place quand un fil passe de l'un à
// l'autre, et aucun jeton n'a été ajouté au DS pour ça.
//
// UNE LIGNE PEUT N'AVOIR AUCUN AGENT (18/09). Dans « Nodal chats », toutes les
// conversations sont celles du même agent : son avatar et son nom, répétés sur
// chaque ligne, n'apprenaient rien et poussaient le titre — la seule chose qui
// distingue un fil d'un autre — dans une étiquette étroite. `agent: null` rend
// alors le titre en ligne principale, et rien d'autre. Les dossiers de canal
// gardent la ligne dessinée par la planche : là, l'agent CHANGE d'une ligne à
// l'autre.

import Link from 'next/link';
import AgentAvatar from './AgentAvatar';
import LiveDot from './LiveDot';
import StatusPill from './StatusPill';
import { MonoMicroTag } from './MonoMicroTag';

type Props = {
  /** La conversation ouverte au clic. `null` = aucune n'est désignée. */
  id: string | null;
  /**
   * L'identité de la LIGNE, pour la retrouver à l'écran. Distincte de `id` :
   * un chat sans fil courant désigné n'a pas de conversation, et deux lignes
   * dans ce cas se seraient partagé le même `data-testid`.
   */
  rowKey: string;
  /** Où mène la ligne. `null` → pas de lien, et la ligne le dit. */
  href: string | null;
  /**
   * L'agent de la ligne — son avatar et son nom. `null` quand la ligne n'en
   * montre aucun : ni avatar, ni nom, et le nom du chat devient la ligne
   * principale. `name: null` est autre chose : un agent est bien là, mais son
   * nom ne se lit pas, et la ligne écrit « — ».
   */
  agent: { name: string | null; avatarUrl: string | null } | null;
  /** Le nom du chat : la personne, le salon, ou le titre du fil. */
  chatName: string;
  /** Le dernier mot. `null` → la seconde ligne n'existe pas. */
  preview: string | null;
  /** L'heure, le jour ou la date. `null` → rien, jamais un tiret. */
  time: string | null;
  /** Ce que la conversation attend de la personne. */
  waiting: 'question' | 'approval' | null;
  /** Un run tourne dessus. Un point, JAMAIS un nombre. */
  running: boolean;
  /**
   * Le fil a bougé depuis que cette personne l'a ouvert, ou elle ne l'a jamais
   * ouvert (#209). Change le POIDS du titre, et rien d'autre.
   */
  unread: boolean;
};

/** Hauteur, gouttière et marges de la planche. Identiques avec ou sans lien. */
const ROW = 'flex h-14 items-center gap-3.5 bg-paper px-4';

export default function ConversationRow({
  id,
  rowKey,
  href,
  agent,
  chatName,
  preview,
  time,
  waiting,
  running,
  unread,
}: Props) {
  // La LIGNE PRINCIPALE — le titre du fil sans agent, le nom de l'agent avec.
  // Deux jetons du DS, même taille, même interlignage : seul le poids change.
  const titre = unread ? 'text-medium-14 text-ink' : 'text-body-14 text-ink';
  // L'état est DIT sur la ligne, pas seulement suggéré par l'absence de lien :
  // sur cinquante lignes, il fallait sinon deviner laquelle n'ouvre rien
  // (revue Codex, PR #48, passe 8).
  const indisponible = href === null && (
    <MonoMicroTag tone="ink" className="shrink-0">
      unavailable
    </MonoMicroTag>
  );

  const corps = (
    <>
      {agent !== null && (
        <AgentAvatar name={agent.name ?? ''} imageUrl={agent.avatarUrl} size="md" shape="square" />
      )}
      {/* min-w-0 : sans lui, le texte long refuse de se couper et pousse
          l'heure et la pastille hors de la ligne. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {agent === null ? (
            // Sans agent, le titre EST la ligne : il prend la place, la graisse
            // et la couleur qu'occupait le nom, et se coupe par le CSS plutôt
            // que dans une étiquette qui ne s'étire pas.
            <span className={`truncate ${titre}`} data-unread={unread ? 'yes' : 'no'}>
              {chatName}
            </span>
          ) : (
            <>
              {/* Un agent sans nom lisible s'écrit « — », la convention du reste
                  du tableau de bord : un blanc se lirait comme un défaut
                  d'affichage. */}
              <span className={`truncate ${titre}`} data-unread={unread ? 'yes' : 'no'}>
                {agent.name ?? '—'}
              </span>
              <MonoMicroTag tone="ink" className="max-w-[18ch] shrink-0 truncate">
                {chatName}
              </MonoMicroTag>
            </>
          )}
          {indisponible}
        </span>
        {preview !== null && <span className="truncate text-body-13 text-ink-3">{preview}</span>}
      </span>
      {time !== null && <span className="shrink-0 text-mono-11 text-ink-4">{time}</span>}
      {waiting === 'question' ? (
        <StatusPill variant="run" label="Question asked" className="shrink-0" />
      ) : waiting === 'approval' ? (
        <StatusPill variant="warn" label="Approval pending" className="shrink-0" />
      ) : running ? (
        <LiveDot variant="ok" size="md" />
      ) : null}
    </>
  );

  // Sans fil courant désigné, PAS de lien : on ne devine pas où mène ce chat.
  // La ligne reste entière et lisible (invariant #4 — jamais un repli
  // silencieux qui présente une estimation comme un fait).
  if (href === null) {
    return (
      <div className={ROW} data-testid={`conversation-row-${id ?? rowKey}`}>
        {corps}
      </div>
    );
  }

  return (
    <Link href={href} className={`${ROW} hover:bg-hover`} data-testid={`conversation-row-${id}`}>
      {corps}
    </Link>
  );
}
