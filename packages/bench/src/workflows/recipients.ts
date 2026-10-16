// workflows/recipients.ts — à qui un scénario peut faire envoyer quelque chose.
//
// Revue Reviewer A de #756 (passes 1 et 2). La protection du banc n'est pas
// une liste de noms d'outils : c'est qu'aucun destinataire réel n'existe dans
// le banc, et que tout scénario DÉCLARE où il envoie (`sends`). Deux lectures,
// une seule règle, lues par recipients.test.ts (toutes les demandes, toutes
// les fixtures) et par runTrial (ce qui est réellement parti) :
//
//   - `realRecipients` : une adresse hors domaine réservé, un numéro de
//     téléphone, un identifiant de chat, sauf destinataire de test déclaré ;
//   - `destinationProblems` : une demande d'envoi adressée au propriétaire
//     (« envoie-la-moi », « send it to me », « envoie-le sur Telegram » sans
//     destinataire nommé) alors que le scénario ne déclare pas `owner`.

import type { Sends } from './types';

/**
 * Les destinataires de test déclarés : les seules adresses, numéros ou chats
 * réels qu'une demande ou une fixture du banc a le droit de nommer. Vide tant
 * que le propriétaire n'a pas décidé des comptes de test (entité « banc »).
 */
export const BENCH_TEST_RECIPIENTS: readonly string[] = [];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
/** Un numéro : international (+33 6 12 34 56 78) ou national à dix chiffres (06 12 34 56 78). */
const PHONE =
  /(?<![\w.,])(?:\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){7,12}|0[1-9](?:[\s.-]?\d{2}){4})(?![\w]|[.,]\d)/g;
/** Un identifiant de chat (Telegram, Discord, WhatsApp) : neuf chiffres d'affilée ou plus. */
const CHAT_ID = /(?<![\w.,-])-?\d{9,}(?![\w]|[.,]\d)/g;
/** Les domaines réservés pour ne jamais exister (RFC 2606, RFC 6761). */
const RESERVED = /(^|\.)(invalid|test|example|localhost)$|(^|\.)example\.(com|net|org)$/i;

/** Tous les identifiants de destinataire d'un texte, réservés compris. */
export function recipientIds(text: string): string[] {
  return [EMAIL, PHONE, CHAT_ID].flatMap((re) => [...text.matchAll(re)].map((m) => m[0].trim()));
}

/** Les destinataires d'un texte qui ne sont ni réservés ni déclarés. */
export function realRecipients(text: string): string[] {
  const declared = new Set(BENCH_TEST_RECIPIENTS.map((r) => r.toLowerCase()));
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL))
    if (!RESERVED.test(m[1]!) && !declared.has(m[0].toLowerCase())) out.push(m[0]);
  for (const re of [PHONE, CHAT_ID])
    for (const m of text.matchAll(re)) if (!declared.has(m[0].trim())) out.push(m[0].trim());
  return out;
}

// Les verbes d'envoi, en français et en anglais (formes courantes, impératif compris).
const FR_VERB =
  'envo(?:ie|ies|ient|yer|yez|yons|yé|yée)|partag(?:e|er|ez)|publi(?:e|er|ez)|transf[éè]r(?:e|er|ez)|transmet(?:s|tre|tez)?|post(?:e|er|ez)|diffus(?:e|er|ez)';
// « email » est aussi un nom (un en-tête `nom,email`) : il n'est un verbe que suivi de son complément.
const EN_VERB =
  'send|share|publish|forward|deliver|post|e-?mail(?=\\s+(?:it|them|this|that|me|the)\\b)';
const SEND_VERB = new RegExp(`(?<![\\p{L}])(?:${FR_VERB}|${EN_VERB})(?![\\p{L}])`, 'iu');
/** Le verbe tourné vers celui qui demande : « envoie-la-moi », « me l'envoyer », « send it to me ». */
const TO_ME = new RegExp(
  `(?:${FR_VERB})(?:-(?:la|le|les|lui|en))?-moi(?![\\p{L}])` +
    `|(?<![\\p{L}])m(?:e\\s+|['’])(?:l(?:e|a|es)?\\s*['’]?\\s*)?(?:${FR_VERB})` +
    `|(?<![\\p{L}])(?:${EN_VERB})\\s+(?:(?:it|them|this|that|the \\w+)\\s+)?(?:back\\s+)?(?:to\\s+)?me(?![\\p{L}])`,
  'iu',
);
/** Un canal de messagerie : sans destinataire nommé, un envoi « sur Telegram » va au propriétaire. */
const CHANNEL =
  /(?<![\p{L}])(?:telegram|whatsapp|signal|slack|discord|sms|e-?mail|mail|courriel)(?![\p{L}])/iu;

/** Une phrase : le texte coupé aux fins de phrase et aux retours à la ligne. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() !== '');
}

/**
 * Pourquoi une demande d'envoi contredit la destination déclarée. Une phrase
 * qui demande d'envoyer au propriétaire (le verbe tourné vers « moi » / « me »,
 * ou un canal sans destinataire nommé) exige `sends: 'owner'`. Une phrase qui
 * nomme seulement des destinataires réservés (`bench@example.invalid`) est un
 * envoi que personne ne peut recevoir : `nothing` y suffit.
 */
export function destinationProblems(text: string, sends: Sends): string[] {
  if (sends === 'owner') return [];
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (!SEND_VERB.test(s)) continue;
    const toOwner = TO_ME.test(s) || (CHANNEL.test(s) && recipientIds(s).length === 0);
    if (toOwner)
      out.push(
        `asks to send to the owner ("${s.trim().slice(0, 80)}") but declares sends: ${sends}`,
      );
  }
  return out;
}
