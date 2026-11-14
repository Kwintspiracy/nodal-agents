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
//  1. Un texte écrit AVANT un travail (un appel d'outil qui a tourné après lui,
//     autre que le signal de fin) n'est pas la réponse du job. Un texte et ses
//     appels du MÊME pas : le texte est écrit avant que les appels tournent ;
//     il ne tient que si ce pas est celui qui finit (`return_result`).
//  2. Sans texte frais, le `reason` d'un `return_result` en `success` EST la
//     réponse — sauf quand ce sont les outils d'envoi qui portent les réponses
//     du job (#649) : là, la réponse est ce qui est parti, et la relecture du
//     fil la lit dans les envois (#1075), jamais dans une phrase de signal.
//  3. Un tour de réparation répare un livrable ; il ne remplace pas la réponse.
//     La réponse d'un job passé par N réparations est celle d'avant la preuve,
//     SUIVIE de ce que chaque réparation a dit — composée ici, sans un mot du
//     runner entre les deux (invariant #2).
//
// `dashboard_publish` est la réponse ÉCRITE EXPLICITEMENT (« Set this job's
// RESULT ») : elle compte comme les mots de son pas, et pas comme un travail.
//
// Ce module ne lit QUE la transcription. Une transcription relue après une
// reprise (approbation, délégation) dit la même chose qu'en mémoire : aucun
// compteur à reconstruire.

import { DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import { isRepairBrief } from '../verification/repair-brief.ts';

/** Le signal de fin : il ne porte pas de travail. */
const END_SIGNAL = 'return_result';
/** La réponse publiée explicitement : des mots, pas un travail. */
const PUBLISH = 'dashboard_publish';

const SEND_TOOLS: ReadonlySet<string> = new Set(DELIVERY_TOOL_NAMES);

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
  let words = '';
  let fresh = false;
  // Le `reason` du DERNIER signal de fin de la section, `null` sans signal.
  let reason: string | null = null;
  for (const step of steps) {
    const ends = step.calls.some((c) => c.name === END_SIGNAL);
    const works = step.calls.some((c) => c.name !== END_SIGNAL && c.name !== PUBLISH);
    // Un travail périme les mots écrits AVANT lui.
    if (works) fresh = false;
    const stepWords = publishedText(step) || step.text;
    if (stepWords !== '') {
      words = stepWords;
      // Les mots d'un pas qui agit sans finir sont écrits avant ses appels.
      fresh = ends || !works;
    }
    const r = successReason(step);
    if (r !== null) reason = r;
  }
  if (words !== '' && fresh) return words;
  if (!repliesGoBySend && reason) return reason;
  return '';
}

/**
 * La réponse que le job a donnée en finissant, relue dans `turnMessages` — la
 * transcription DU TOUR COURANT (la tranche est celle de l'appelant :
 * `currentTurnMessages` ou `lastTextOfRun`). Les sections séparées par les
 * briefs de réparation sont mises bout à bout, chacune réduite à sa réponse ;
 * une section qui n'a rien dit n'ajoute rien, et une réponse identique à la
 * précédente n'est pas répétée. `''` : le job n'a donné aucune réponse.
 */
export function answerOfRun(turnMessages: readonly unknown[]): string {
  const sections: Step[][] = [[]];
  let repliesGoBySend = false;
  for (const m of turnMessages) {
    if (isRepairBrief(m)) {
      sections.push([]);
      continue;
    }
    const step = stepOf(m);
    if (!step) continue;
    if (step.calls.some((c) => SEND_TOOLS.has(c.name))) repliesGoBySend = true;
    sections[sections.length - 1]!.push(step);
  }
  const answers: string[] = [];
  for (const steps of sections) {
    const answer = answerOfSection(steps, repliesGoBySend);
    if (answer !== '' && answer !== answers[answers.length - 1]) answers.push(answer);
  }
  return answers.join('\n\n');
}
