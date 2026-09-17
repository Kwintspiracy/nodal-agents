'use client';

// ThreadComposer — la saisie en bas d'un fil du dashboard (P7).
//
// Sa forme depuis #135 : un cadre à DEUX rangées — la zone de texte en haut,
// pleine largeur, trois lignes à vide et grandissant avec le texte ; sous elle
// une rangée d'actions avec l'envoi à droite. Texte à 14 px, sur sa propre
// surface (`bg-feed-composer`), pas sur le papier du fil.
//
// C'est ce qui reste du chat à deux volets : une zone de texte et un envoi.
// L'envoi est SYNCHRONE côté runner (il génère la réponse et écrit les deux
// tours), donc l'écran attend puis se rafraîchit — le fil relu montre la
// réponse, ses actions et, s'il y a lieu, ce qui est sorti du chat.
//
// Un fil venu d'un canal n'a pas ce composant : répondre depuis le web vers
// Telegram ou Slack se vérifie canal par canal, et P7 ne le fait pas. La page
// le dit en toutes lettres plutôt que d'offrir un champ qui ne partirait pas.

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextArea from '@/components/ui/TextArea';
import { sendChatMessageAction } from '@/lib/actions.ts';
import ModelEffortChip, { type ComposerLlmKey } from './ModelEffortChip.tsx';

/** Au-delà, la zone défile au lieu de grandir : le fil reste visible. */
const COMPOSER_MAX_HEIGHT_PX = 200;

/** Une ligne de `text-body-14` (14 px / 20 px d'interligne). */
const COMPOSER_LINE_HEIGHT_PX = 20;

/** Le nombre de lignes du cadre à vide (#135). */
export const COMPOSER_ROWS = 3;

/**
 * Le plancher : la zone ne redescend JAMAIS sous ses trois lignes, même vide.
 * `fitToContent` remesure la zone vidée après un envoi, et sans ce plancher
 * elle retombait à une ligne.
 */
export const COMPOSER_MIN_HEIGHT_PX = COMPOSER_ROWS * COMPOSER_LINE_HEIGHT_PX;

/** La zone épouse son texte : trois lignes à vide, autant qu'il en faut ensuite. */
function fitToContent(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  const wanted = Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT_PX);
  el.style.height = `${Math.min(wanted, COMPOSER_MAX_HEIGHT_PX)}px`;
}

export default function ThreadComposer({
  conversationId,
  agentName,
  placeholder,
  onBeforeSend,
  agentId,
  llmKeyId,
  model,
  reasoningEffort,
  llmKeys,
}: {
  conversationId: string;
  /** À qui on écrit — le placeholder le dit. Absent : « Reply… ». */
  agentName?: string | null;
  /**
   * Le placeholder en toutes lettres, quand « Reply to X… » serait faux :
   * la page d'un projet dont la saisie va OUVRIR une conversation dit
   * « Write to X… » (revue Codex, passe 60).
   */
  placeholder?: string;
  /**
   * P8 — la page d'un projet sans conversation. Appelé AVANT l'envoi, il rend
   * l'id de la conversation qui doit recevoir le message (elle vient d'être
   * créée). Une prop plutôt qu'un second composeur : la saisie ne change pas,
   * seul son point d'arrivée change. S'il lève, rien n'est envoyé et l'écran
   * le dit (inv. #4).
   */
  onBeforeSend?: () => Promise<string>;
  /**
   * #138 — les trois listes « provider / modèle / effort ». Les champs vont
   * ensemble : sans agent (la page d'un projet qui n'en a pas encore), il n'y
   * a rien à régler et les listes ne s'affichent pas — plutôt qu'un réglage
   * posé sur personne.
   */
  agentId?: string | null;
  llmKeyId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  llmKeys?: ComposerLlmKey[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [isPending, startTransition] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);

  /** Y a-t-il quelque chose à envoyer, maintenant ? La couleur du bouton le dit. */
  const canSend = !isPending && message.trim() !== '';

  function send(): void {
    const text = message.trim();
    if (text === '') return;
    startTransition(async () => {
      let target = conversationId;
      if (onBeforeSend) {
        try {
          target = await onBeforeSend();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not open the conversation');
          return;
        }
      }
      if (target === '') {
        toast.error('No conversation to write to');
        return;
      }
      const r = await sendChatMessageAction({ conversationId: target, message: text });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setMessage('');
      // La zone se remesure VIDE : React ne vide le DOM qu'à la réconciliation,
      // et mesurer avant laissait une zone haute après l'envoi (revue Codex,
      // passes 57-58). On vide donc la valeur du DOM soi-même avant de mesurer
      // — l'état contrôlé la remet à '' au rendu suivant, sans conflit.
      if (box.current) {
        box.current.value = '';
        fitToContent(box.current);
      }
      router.refresh();
    });
  }

  // P2bis — un CADRE, pas un champ posé à côté d'un bouton : le design pose
  // la saisie sur sa propre surface, collée en bas de la zone de contenu,
  // juste au-dessus de la barre d'état. Trois lignes à vide, comme la
  // maquette — et une ZONE de texte, pas un champ : un collage multi-ligne
  // garde ses retours, Maj+Entrée en ajoute un, et la zone grandit avec le
  // texte (revue Codex, passe 56 : le champ d'une ligne aplatissait tout).
  // Entrée envoie.
  return (
    // Ancrée, pas collante : la page de conversation est un écran de hauteur
    // fixe (PageShell `fill`) — la saisie est hors de la zone qui défile, donc
    // toujours en bas, avec deux lignes de fil comme avec deux cents.
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2 rounded-xl border border-rule bg-feed-composer px-4 pt-3 pb-2.5">
      <TextArea
        ref={box}
        bare
        rows={COMPOSER_ROWS}
        value={message}
        onChange={(e) => {
          setMessage(e.target.value);
          fitToContent(e.target);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          placeholder !== undefined
            ? placeholder
            : agentName !== undefined && agentName !== null && agentName !== ''
              ? `Reply to ${agentName}…`
              : 'Reply…'
        }
        disabled={isPending}
        containerClassName="min-w-0"
        // `block` : en ligne, la zone laisse 5 px de descente sous elle dans
        // son conteneur, et la rangée d'actions se calait sur CE bas-là.
        // `min-h-[60px]` = COMPOSER_MIN_HEIGHT_PX, le plancher de trois lignes
        // tenu aussi en CSS, avant que `fitToContent` ait mesuré quoi que ce soit.
        // `placeholder:text-ink-2/70` : `ink-4`, l'indication par défaut de
        // `TextArea bare`, ne fait que ~2,6:1 sur la surface feed/composer
        // (revue Reviewer C) ; aucun token ne se tient entre ink-4 et ink-2.
        className="block max-h-[200px] min-h-[60px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-body-14 placeholder:text-ink-2/70"
      />
      {/* La rangée d'actions, telle que Quentin l'a dessinée (Figma
          `ThreadComposer` 355:2928) : la pastille « provider · modèle ·
          effort » à gauche, l'envoi à droite, sur UNE ligne — la pastille fait
          30 px, la hauteur du bouton. */}
      <div className="flex items-center justify-end gap-2">
        {agentId !== undefined && agentId !== null && agentId !== '' && (
          // La `key` porte les valeurs venues du serveur : quand le réglage
          // change AILLEURS (l'écran de l'agent), la page relue remonte le
          // composant sur elles. Pas d'effet qui recopierait les props dans
          // l'état — c'est le rendu en cascade que la règle React refuse.
          <ModelEffortChip
            key={`${llmKeyId ?? ''}:${model ?? ''}:${reasoningEffort ?? ''}`}
            agentId={agentId}
            llmKeyId={llmKeyId ?? null}
            model={model ?? ''}
            reasoningEffort={reasoningEffort ?? null}
            llmKeys={llmKeys ?? []}
          />
        )}
        {/* L'envoi CHANGE DE COULEUR quand il y a quelque chose à envoyer :
            c'est le signal, pas un libellé de plus. Le bouton d'encre de la
            planche dès que le texte n'est pas vide — c'est le contraste le
            plus tranché sur cette surface ; neutre le reste du temps, où
            cliquer ne ferait rien. */}
        <PrimaryButton
          variant={canSend ? 'ink' : 'neutral'}
          size="sm"
          onClick={send}
          disabled={!canSend}
        >
          {isPending ? 'Sending…' : 'Send'}
        </PrimaryButton>
      </div>
    </div>
  );
}
