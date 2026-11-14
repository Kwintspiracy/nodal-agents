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
//     quand ce sont les outils d'envoi qui portent les réponses du job
//     (#649) : là, la réponse est ce qui est parti, et la relecture du fil la
//     lit dans les envois (#1075), jamais dans une phrase de signal. Ce fait
//     est celui de la LIVRAISON du job (`replyTo`, la ligne `delivery:`), que
//     l'appelant passe : un job qui répond par son résultat et envoie une image
//     en passant ne répond pas par un envoi.
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
// Ce module ne lit QUE la transcription. Une transcription relue après une
// reprise (approbation, délégation) dit la même chose qu'en mémoire : aucun
// compteur à reconstruire.

import { DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import { isRepairBrief } from '../verification/repair-brief.ts';

/** Le signal de fin : il ne porte pas de travail. */
const END_SIGNAL = 'return_result';
/** La réponse publiée explicitement : ce sont les mots de son pas. */
const PUBLISH = 'dashboard_publish';

const SEND_TOOLS: ReadonlySet<string> = new Set(DELIVERY_TOOL_NAMES);

/** Les appels qui DISENT : ils ne périment aucun texte. */
const SAYING: ReadonlySet<string> = new Set([END_SIGNAL, PUBLISH, ...DELIVERY_TOOL_NAMES]);

interface ToolCallPart {
  name: string;
  input: unknown;
}

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
      input?: unknown;
    } | null;
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    if (part.type === 'tool-call' && typeof part.toolName === 'string') {
      calls.push({ name: part.toolName, input: part.input });
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
 * brief de réparation) jusqu'à la section suivante.
 */
function answerOfSection(steps: readonly Step[], repliesGoBySend: boolean): string {
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
  const reason = repliesGoBySend ? '' : reasonAfter;
  if (words === '') return reason;
  if (wordsActed && reason !== '' && reason !== words) return [words, reason].join('\n\n');
  return words;
}

/**
 * La réponse que le job a donnée en finissant, relue dans `turnMessages` — la
 * transcription DU TOUR COURANT (la tranche est celle de l'appelant :
 * `currentTurnMessages` ou `lastTextOfRun`). Les sections séparées par les
 * briefs de réparation sont mises bout à bout, chacune réduite à sa réponse ;
 * une section qui n'a rien dit n'ajoute rien, et une réponse identique à la
 * précédente n'est pas répétée. `''` : le job n'a donné aucune réponse.
 */
export function answerOfRun(turnMessages: readonly unknown[], repliesGoBySend: boolean): string {
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
  const answers: string[] = [];
  for (const steps of sections) {
    const answer = answerOfSection(steps, repliesGoBySend);
    if (answer !== '' && answer !== answers[answers.length - 1]) answers.push(answer);
  }
  return answers.join('\n\n');
}

/**
 * La lecture de REPLI de « les réponses de ce job partent par un envoi », pour
 * les portes qui ne tiennent pas la livraison du job (le remplissage de
 * `completeJob`, le repli de `finalizeJobSuccess`) : un envoi est dans la
 * transcription. Elles ne sont atteintes qu'après la porte d'`execute.ts`, qui
 * lit, elle, la livraison (`replyTo`) et passe déjà la réponse quand le
 * résultat est vide ; elles ne voient donc que des runs sans réponse, où ce
 * drapeau ne change rien.
 */
export function repliesWentBySend(turnMessages: readonly unknown[]): boolean {
  return turnMessages.some((m) => (stepOf(m)?.calls ?? []).some((c) => SEND_TOOLS.has(c.name)));
}
