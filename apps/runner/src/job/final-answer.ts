// job/final-answer.ts — la réponse d'un job : ce qu'il dit quand il FINIT (#1083).
//
// Le `result` d'un job était le dernier texte que le runner avait vu, quel
// qu'il soit et quel que soit le moment où il avait été écrit. Deux défauts en
// sortaient, observés trois fois le même soir (14/11) :
//
//  - la NARRATION PÉRIMÉE : « le PDF fait 2 pages, je resserre et je relance le
//    rendu », puis huit rendus, une vérification, et `return_result` seul —
//    le parent recevait la phrase écrite AVANT le travail, et une impression
//    demandée n'a pas été lancée ;
//  - la NOTE DE RÉPARATION : un rapport complet, une preuve rouge, un tour de
//    réparation dont la réponse ne parle que de la réparation — et cette
//    réponse REMPLAÇAIT le rapport.
//
// La règle, une seule pour toutes les portes de fin (texte sans outil,
// `return_result`, l'échec sur un livrable promis non vérifié) :
//
//  1. Un texte n'est périmé que par un TRAVAIL d'un pas ULTÉRIEUR. Les appels
//     qui DISENT au lieu de faire ne sont pas un travail : le signal de fin, la
//     publication explicite (`dashboard_publish`) et les outils de livraison
//     (`DELIVERY_TOOL_NAMES`, l'ensemble que la plateforme tient déjà) ne
//     changent pas le produit de la tâche — 116 jobs relus écrivaient leur
//     réponse, puis l'envoyaient au pas suivant. Les appels écrits dans le MÊME pas
//     que lui ne le périment pas : un rapport complet écrit avec l'appel qui
//     enregistre son verdict, puis `return_result` seul, est une réponse —
//     81 des 2 217 jobs relus sur l'installation du propriétaire ont cette
//     forme, et la règle d'abord écrite ici leur retirait leur rapport.
//  2. Le `reason` d'un `return_result` en `success`, écrit dans un pas
//     ultérieur, est ce que le job dit APRÈS son dernier travail : il n'est pas
//     jeté. Sans texte frais, il EST la réponse ; après un texte écrit avec des
//     appels (donc avant d'en voir les résultats), il le SUIT ; après un texte
//     écrit seul dans son pas, il n'ajoute rien (le texte a tout vu). Sauf
//     quand la réponse est PARTIE par un envoi au chat qui a demandé, dans le
//     pas qui la donne (#1215) : là, la réponse est ce qui est parti, et la
//     relecture du fil la lit dans les envois (#1075), jamais dans une phrase
//     de signal. Ce fait est lu sur les appels rangés (`sendsToChat`,
//     chat-sends.ts), par pas et par destination, jamais sur un drapeau : un
//     envoi plus tôt, un envoi à un autre chat, une image en passant ne disent
//     rien de la réponse.
//  3. Un tour de réparation répare un livrable ; il ne remplace pas la réponse.
//     La réponse d'un job passé par N réparations est celle d'avant la preuve,
//     SUIVIE de ce que chaque réparation a dit — composée ici, sans un mot du
//     runner entre les deux (invariant #2).
//
// La règle parle de PAS, et ne nomme aucun outil à la main : ce qui DIT est le
// signal de fin, la publication et l'ensemble des outils de livraison de la
// plateforme. `dashboard_publish` donne aussi les mots de son pas : le texte
// qu'il pose comme résultat (« Set this job's RESULT »).
//
// Ce module ne lit QUE la transcription, et les envois que l'appelant a lus sur
// les lignes `tool_calls` (par identifiant d'appel). Une transcription relue
// après une reprise (approbation, délégation, redémarrage) dit la même chose
// qu'en mémoire : aucun compteur à reconstruire.
//
// LA RÉPONSE À LIVRER (#1215). Le harnais livre la réponse d'un job venu d'un
// chat, sauf ce qu'un envoi du job a déjà porté à ce chat. Une section dont le
// pas de réponse (le pas qui porte ses derniers mots ou son dernier travail,
// et ceux qui le suivent) tient un envoi CONFIRMÉ à ce chat est livrée ; un
// envoi dont l'issue est INCONNUE (la plateforme n'a pas répondu à une requête
// transmise) ne compte pas comme livré : son texte est à renvoyer, et
// l'appelant le dit.

import { DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import { isRepairBrief } from '../verification/repair-brief.ts';

/** Le signal de fin : il ne porte pas de travail. */
const END_SIGNAL = 'return_result';
/** La réponse publiée explicitement : ce sont les mots de son pas. */
const PUBLISH = 'dashboard_publish';

/** Les appels qui DISENT : ils ne périment aucun texte. */
const SAYING: ReadonlySet<string> = new Set([END_SIGNAL, PUBLISH, ...DELIVERY_TOOL_NAMES]);

interface ToolCallPart {
  id: string | null;
  name: string;
  input: unknown;
}

/** Ce qu'on sait d'un envoi de texte au chat qui a demandé (chat-sends.ts). */
export type SendOutcome = 'confirmed' | 'unknown';

/** Les envois de texte au chat qui a demandé, par identifiant d'appel. */
export type ChatSends = ReadonlyMap<string, SendOutcome>;

/** Aucun envoi au chat : un job sans chat, ou qui n'a rien envoyé. */
export const NO_CHAT_SENDS: ChatSends = new Map();

/** L'outil qui envoie un texte : le seul dont un envoi peut porter une réponse. */
const TEXT_SEND = 'telegram_send_message';

interface Step {
  text: string;
  calls: ToolCallPart[];
}

function stepOf(message: unknown): Step | null {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (!m || m.role !== 'assistant') return null;
  const c = m.content;
  if (typeof c === 'string') return { text: c.trim(), calls: [] };
  if (!Array.isArray(c)) return null;
  const texts: string[] = [];
  const calls: ToolCallPart[] = [];
  for (const p of c) {
    const part = p as {
      type?: unknown;
      text?: unknown;
      toolName?: unknown;
      toolCallId?: unknown;
      input?: unknown;
    } | null;
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    if (part.type === 'tool-call' && typeof part.toolName === 'string') {
      calls.push({
        id: typeof part.toolCallId === 'string' ? part.toolCallId : null,
        name: part.toolName,
        input: part.input,
      });
    }
  }
  return { text: texts.join('').trim(), calls };
}

/** Le texte qu'un `dashboard_publish` du pas a posé comme réponse, le dernier. */
function publishedText(step: Step): string {
  let out = '';
  for (const call of step.calls) {
    if (call.name !== PUBLISH) continue;
    const text = (call.input as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text.trim() !== '') out = text.trim();
  }
  return out;
}

function successReason(step: Step): string | null {
  let out: string | null = null;
  for (const call of step.calls) {
    if (call.name !== END_SIGNAL) continue;
    const input = call.input as { status?: unknown; reason?: unknown } | null;
    out =
      input?.status === 'success' && typeof input.reason === 'string' ? input.reason.trim() : '';
  }
  return out;
}

/**
 * La réponse d'UNE section de la transcription : du début du tour (ou d'un
 * brief de réparation) jusqu'à la section suivante. `reasonCounts` : un
 * `reason` peut-il être la réponse ? Pas quand la réponse est partie par un
 * envoi, ni pour les replis qui ne lisent pas les envois.
 */
function answerOfSection(steps: readonly Step[], reasonCounts: boolean): string {
  // Les derniers mots qui ne sont suivis d'AUCUN travail d'un pas ultérieur.
  let words = '';
  // Le pas qui les porte a-t-il aussi agi ? Ses mots précèdent alors les
  // résultats de ses appels.
  let wordsActed = false;
  // Le `reason` du dernier signal de fin APRÈS ces mots, `''` s'il n'en a pas.
  let reasonAfter = '';
  for (const step of steps) {
    const works = step.calls.some((c) => !SAYING.has(c.name));
    const stepWords = publishedText(step) || step.text;
    // Un travail périme les mots des pas d'AVANT lui, pas ceux de son pas.
    if (works) {
      words = '';
      wordsActed = false;
      reasonAfter = '';
    }
    if (stepWords !== '') {
      words = stepWords;
      wordsActed = works;
      reasonAfter = '';
      // Un `reason` du même pas que les mots est écrit avec eux : ils priment.
      continue;
    }
    const r = successReason(step);
    if (r !== null) reasonAfter = r;
  }
  const reason = reasonCounts ? reasonAfter : '';
  if (words === '') return reason;
  if (wordsActed && reason !== '' && reason !== words) return [words, reason].join('\n\n');
  return words;
}

/**
 * Les envois au chat du PAS DE RÉPONSE d'une section : le pas qui porte ses
 * derniers mots ou son dernier travail, et ceux qui le suivent (ils ne font que
 * dire). Un envoi d'avant (un accusé de réception suivi de travail ou de mots)
 * n'est pas la réponse.
 */
function answerStepSends(steps: readonly Step[], sends: ChatSends): SendOutcome[] {
  let from = 0;
  steps.forEach((step, i) => {
    const works = step.calls.some((c) => !SAYING.has(c.name));
    if (works || publishedText(step) !== '' || step.text !== '') from = i;
  });
  const out: SendOutcome[] = [];
  for (const step of steps.slice(from)) {
    for (const call of step.calls) {
      if (call.name !== TEXT_SEND || call.id === null) continue;
      const outcome = sends.get(call.id);
      if (outcome !== undefined) out.push(outcome);
    }
  }
  return out;
}

/** Le texte des envois au chat dont l'issue est inconnue, dans l'ordre. */
function unconfirmedTexts(steps: readonly Step[], sends: ChatSends): string[] {
  const texts: string[] = [];
  for (const step of steps) {
    for (const call of step.calls) {
      if (call.name !== TEXT_SEND || call.id === null || sends.get(call.id) !== 'unknown') continue;
      const text = (call.input as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text.trim() !== '') texts.push(text.trim());
    }
  }
  return texts;
}

/** La réponse du run, et ce qu'il reste à en livrer au chat qui a demandé. */
export interface RunAnswer {
  /** La réponse que le job a donnée en finissant : ce que son résultat porte. */
  readonly text: string;
  /**
   * `null` : aucun envoi du job n'a porté de réponse au chat, la réponse à
   * livrer est le résultat du job. Sinon, ce qui n'en est pas parti : les
   * réponses des sections qu'aucun envoi n'a portées, et le texte des envois
   * dont l'issue est inconnue (`''` : tout est parti).
   */
  readonly unsent: string | null;
  /** Un envoi du pas de réponse a une issue inconnue : son texte est à renvoyer. */
  readonly resendsUnconfirmed: boolean;
}

function joinAnswers(answers: readonly string[]): string {
  const out: string[] = [];
  for (const a of answers) if (a !== '' && a !== out[out.length - 1]) out.push(a);
  return out.join('\n\n');
}

function sectionsOf(turnMessages: readonly unknown[]): Step[][] {
  const sections: Step[][] = [[]];
  for (const m of turnMessages) {
    if (isRepairBrief(m)) {
      sections.push([]);
      continue;
    }
    const step = stepOf(m);
    if (!step) continue;
    sections[sections.length - 1]!.push(step);
  }
  return sections;
}

/**
 * La réponse que le job a donnée en finissant, relue dans `turnMessages` (la
 * transcription DU TOUR COURANT : la tranche est celle de l'appelant,
 * `currentTurnMessages` ou `lastTextOfRun`), et ce qu'il en reste à livrer au
 * chat qui a demandé, d'après `sends` (les envois à ce chat, lus sur les
 * lignes : `sendsToChat`). Les sections séparées par les briefs de réparation
 * sont mises bout à bout, chacune réduite à sa réponse ; une section qui n'a
 * rien dit n'ajoute rien, et une réponse identique à la précédente n'est pas
 * répétée.
 */
export function readRunAnswer(turnMessages: readonly unknown[], sends: ChatSends): RunAnswer {
  const answers: string[] = [];
  const unsent: string[] = [];
  let anySent = false;
  let resendsUnconfirmed = false;
  for (const steps of sectionsOf(turnMessages)) {
    const atAnswer = answerStepSends(steps, sends);
    if (atAnswer.includes('confirmed')) {
      anySent = true;
      answers.push(answerOfSection(steps, false));
      continue;
    }
    if (atAnswer.includes('unknown')) {
      anySent = true;
      resendsUnconfirmed = true;
      answers.push(answerOfSection(steps, false));
      unsent.push(...unconfirmedTexts(steps, sends));
      continue;
    }
    const answer = answerOfSection(steps, true);
    answers.push(answer);
    unsent.push(answer);
  }
  return {
    text: joinAnswers(answers),
    unsent: anySent ? joinAnswers(unsent) : null,
    resendsUnconfirmed,
  };
}

/**
 * La réponse que le job a donnée en finissant (`readRunAnswer`). `''` : le job
 * n'a donné aucune réponse.
 */
export function answerOfRun(turnMessages: readonly unknown[], sends: ChatSends): string {
  return readRunAnswer(turnMessages, sends).text;
}

/**
 * La réponse ÉCRITE du run, sans jamais promouvoir un `reason` : la lecture des
 * portes de repli qui ne lisent pas les envois (le remplissage de
 * `completeJob`, le repli de `finalizeJobSuccess`). Un `reason` ne devient la
 * réponse que là où les envois sont lus (la porte d'`execute.ts`, qui le passe
 * déjà quand le résultat est vide). Ainsi un seul endroit décide si un
 * `reason` compte (revue Nodal de #1087, F3).
 */
export function writtenAnswerOfRun(turnMessages: readonly unknown[]): string {
  return joinAnswers(sectionsOf(turnMessages).map((steps) => answerOfSection(steps, false)));
}
