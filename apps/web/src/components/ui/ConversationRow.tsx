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
// ⚠️ La maquette dessine aussi une pastille « Unread ». Elle n'est pas rendue :
// la base ne porte aucun état de lecture, et aucune ligne ne peut donc dire
// qu'elle n'est pas lue (invariant #4). Voir `conversation-rows.ts`.

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
  agentName: string | null;
  agentAvatarUrl: string | null;
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
};

/** Hauteur, gouttière et marges de la planche. Identiques avec ou sans lien. */
const ROW = 'flex h-14 items-center gap-3.5 bg-paper px-4';

export default function ConversationRow({
  id,
  rowKey,
  href,
  agentName,
  agentAvatarUrl,
  chatName,
  preview,
  time,
  waiting,
  running,
}: Props) {
  const corps = (
    <>
      <AgentAvatar name={agentName ?? ''} imageUrl={agentAvatarUrl} size="md" shape="square" />
      {/* min-w-0 : sans lui, le texte long refuse de se couper et pousse
          l'heure et la pastille hors de la ligne. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {/* Un agent sans nom lisible s'écrit « — », la convention du reste du
              tableau de bord : un blanc se lirait comme un défaut d'affichage. */}
          <span className="truncate text-medium-14 text-ink">{agentName ?? '—'}</span>
          <MonoMicroTag tone="ink" className="max-w-[18ch] shrink-0 truncate">
            {chatName}
          </MonoMicroTag>
          {href === null && (
            // L'état est DIT sur la ligne, pas seulement suggéré par l'absence
            // de lien : sur cinquante lignes, il fallait sinon deviner laquelle
            // n'ouvre rien (revue Codex, PR #48, passe 8).
            <MonoMicroTag tone="ink" className="shrink-0">
              unavailable
            </MonoMicroTag>
          )}
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
