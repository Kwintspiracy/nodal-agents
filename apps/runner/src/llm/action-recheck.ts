// llm/action-recheck.ts — relire une réponse qui promettait une action (#600).
//
// Un modèle répond en prose en ANNONÇANT une action (« Je délègue la réécriture
// à Dev-C. », « Je lance la recherche. ») sans émettre l'appel d'outil qui la
// ferait. Le texte seul ne fait rien. Le tool_choice n'est jamais forcé (#600) :
// un tour peut être une vraie réponse, et un appel forcé faisait planifier à un
// modèle de raisonnement toute une trajectoire en une seule réponse (64 à 546
// appels, ou le plafond de sortie).
//
// Un seul mécanisme pour le chat ET la boucle de job : tout tour qui finit en
// prose sans appel d'outil est relu UNE fois. Le modèle voit la demande, sa
// réponse, le RELEVÉ de ce que le run a déjà fait, et la consigne, avec les
// outils de l'appelant. Il appelle l'outil que sa réponse promettait, ou
// n'appelle rien et la réponse reste.
//
// La relance est LOCALE, jamais le tour rejoué : ni prompt système, ni
// historique, ni mémoire. Mesuré le 09/09 sur le chat, la relance complète
// coûtait ~9 300 jetons, autant que la réponse elle-même (18 500 par tour pour
// un bonjour).
//
// LE RELEVÉ (#711). Sans lui, la relance ne savait pas ce que le run avait
// déjà fait, et une réponse qui RAPPORTE une action faite (« Envoi effectué,
// messageId … ») se lisait comme une promesse : le modèle, ne voyant aucun
// appel, la refaisait. Le 12/10, quatre envois de trop sur sept, et une
// délégation terminée relancée par une racine. La question « ma réponse
// promettait-elle une action ? » dépend donc de la demande, de la réponse, ET
// de ce qui est déjà fait. Le relevé est borné, et il dit ce qu'il ne montre
// pas (invariant #4) : les premiers et les derniers appels, chacun réduit à
// ses arguments et à son issue, jamais l'historique entier.
//
// Un rapport ne vaut que si le relevé le porte (revue Nodal de #740, passe 1) :
// « Le rapport est envoyé. » sans aucun envoi au relevé est exactement la
// réponse que #600 existe pour rattraper, et l'action reste due.
//
// La consigne et le relevé sont adressés au modèle, jamais montrés à
// l'utilisateur (invariant #2) : ils ne vivent que dans la requête de relance.

import type { ModelMessage } from 'ai';
import type { NodalLlmClient } from '@nodal-agents/llm';
import { cutForContext, elideBinary, unwrapUntrusted, wrapUntrusted } from '@nodal-agents/shared';
import {
  EVICTED_TOOL_INPUT_MARKER,
  toolResultOutputText,
  toolResultShape,
} from '../job/tool-result-shape.ts';

export const ACTION_RECHECK =
  'Re-read your previous reply against the record above of what this run has done since the ' +
  'request. ' +
  'An action the record shows as done, or as possibly done with an uncertain outcome, has ' +
  'happened: do not perform it again. ' +
  "An action the record shows as refused by a person, or as waiting for a person's " +
  'decision, must not be performed now either. ' +
  'Any other action your reply reports or commits to — running, launching, sending, ' +
  'fetching, creating, configuring, delegating, or any task or tool use — that the record ' +
  'does not show as done was NOT done: your text ALONE does nothing, so call the tool that ' +
  'performs it NOW, conveying the request faithfully (its words and data, with no invented ' +
  'scope, method, or delivery). ' +
  'If your reply was pure conversation, a question, an answer, or simply recalling a fact, do ' +
  'not call any tool — the reply stands as it is.';

/** Les appels listés depuis le DÉBUT du run quand il en a fait plus que le relevé n'en montre. */
export const RUN_RECORD_HEAD_CALLS = 5;
/** Les appels listés depuis la FIN du run, dans le même cas. */
export const RUN_RECORD_TAIL_CALLS = 15;
/** Les caractères gardés des arguments d'un appel. */
export const RUN_RECORD_ARGS_CHARS = 200;
/** Les caractères gardés du résultat d'un appel. */
export const RUN_RECORD_RESULT_CHARS = 200;

/** La source que nomme le cadre du relevé. */
const RUN_RECORD_SOURCE = 'the tool calls of this run and what they returned';

interface RecordedCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Un extrait, sur une ligne : déballé de son propre cadre (un résultat de
 * tiers arrive encadré, et l'en-tête du cadre mangerait l'extrait), puis
 * coupé, la coupe dite. Il n'est PAS recadré ici : le relevé entier l'est.
 */
function excerpt(text: string, room: number): string {
  return oneLine(cutForContext(oneLine(elideBinary(unwrapUntrusted(text))), room));
}

function argumentsOf(input: unknown): string {
  if (input === EVICTED_TOOL_INPUT_MARKER) return '(arguments elided from the transcript)';
  return excerpt(
    typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    RUN_RECORD_ARGS_CHARS,
  );
}

/** Le texte d'un résultat : le message d'un bloc `{ error }` quand c'est un texte, sinon tout. */
function resultText(output: unknown): string {
  const value = (output as { value?: unknown } | null)?.value;
  if (value !== null && typeof value === 'object') {
    const err = (value as { error?: unknown }).error;
    if (typeof err === 'string') return err;
  }
  if (value === undefined) return JSON.stringify(output ?? null);
  // An output carrying images says them, never their base64 (`content`).
  return toolResultOutputText(output as { type?: unknown; value?: unknown });
}

/**
 * L'issue d'un appel, lue par LA lecture de la boucle (`toolResultShape`,
 * job/tool-result-shape.ts), jamais par une seconde grammaire. Ce que l'outil
 * a rendu est CITÉ, jamais résumé en « succès ». Un appel que le runner n'a
 * pas exécuté (en attente d'une personne, refusé, différé, expiré) est dit
 * non exécuté, avec ce qui l'a arrêté.
 */
function outcomeOf(output: unknown): string {
  if (output === undefined) return 'no result recorded';
  const cite = (): string => excerpt(resultText(output), RUN_RECORD_RESULT_CHARS);
  switch (toolResultShape(output)) {
    case 'error':
      return `failed: ${cite()}`;
    case 'may_have_delivered':
      return `outcome uncertain, it may have taken effect: ${cite()}`;
    case 'awaiting_approval':
      return 'not executed: it waits for a person’s decision';
    case 'rejected':
      return `not executed: a person refused it — ${cite()}`;
    case 'deferred':
      return `not executed: deferred — ${cite()}`;
    case 'expired':
      return 'not executed: its approval request expired without an answer';
    case 'elided':
      return 'its result was elided from the transcript: the outcome is not known here';
    case 'ok':
      return `returned: ${cite()}`;
  }
}

/**
 * Les lignes du relevé, encadrées UNE fois comme donnée (INJECT-001, revue
 * Nodal de #740) : arguments et résultats y sont écrits par des outils — la
 * sortie d'une commande, la prose d'un enfant —, et le relevé les fait entrer
 * dans le message qui porte la consigne. Quel que soit l'outil, ils y restent
 * des données, délimiteurs neutralisés par `wrapUntrusted`.
 */
function framed(lines: readonly string[]): string {
  return wrapUntrusted(RUN_RECORD_SOURCE, lines.join('\n'));
}

/**
 * Le relevé de ce que le run a fait depuis sa demande : chaque appel d'outil,
 * ses arguments et son issue, du plus ancien au plus récent.
 *
 * `run` est la transcription DEPUIS la demande (la frontière de
 * `findTaskBoundary`, job/state.ts), ou `null` quand l'appelant ne la trouve
 * pas : le relevé le dit alors, plutôt que de lister l'historique rejoué
 * comme si ce run l'avait fait.
 *
 * Borné : au-delà de `RUN_RECORD_HEAD_CALLS + RUN_RECORD_TAIL_CALLS` appels,
 * les premiers et les derniers, et la ligne qui dit lesquels manquent. Les
 * premiers parce qu'une action vers l'extérieur ouvre souvent le run, les
 * derniers parce que la réponse relue rapporte ce qui vient d'être fait.
 */
export function runRecord(run: readonly ModelMessage[] | null): string {
  if (run === null) {
    return (
      'Record of this run: not available. The request could not be located in the ' +
      'transcript of this run, so the tool calls made since it cannot be listed.'
    );
  }
  const calls: RecordedCall[] = [];
  const results = new Map<string, unknown>();
  for (const m of run) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as unknown[]) {
      const p = part as Record<string, unknown> | null;
      if (!p) continue;
      if (m.role === 'assistant' && p['type'] === 'tool-call') {
        calls.push({ id: String(p['toolCallId']), name: String(p['toolName']), input: p['input'] });
      } else if (m.role === 'tool' && p['type'] === 'tool-result') {
        results.set(String(p['toolCallId']), p['output']);
      }
    }
  }
  if (calls.length === 0) {
    return 'Record of this run: no tool has been called since the request.';
  }
  const line = (call: RecordedCall, i: number): string =>
    `${i + 1}. ${call.name} ${argumentsOf(call.input)} → ${outcomeOf(results.get(call.id))}`;
  const total = calls.length;
  if (total <= RUN_RECORD_HEAD_CALLS + RUN_RECORD_TAIL_CALLS) {
    return [
      `Record of this run — the ${total} tool call${total === 1 ? '' : 's'} made since the ` +
        'request, oldest first, each with its outcome:',
      framed(calls.map(line)),
    ].join('\n');
  }
  const firstHidden = RUN_RECORD_HEAD_CALLS + 1;
  const lastHidden = total - RUN_RECORD_TAIL_CALLS;
  return [
    `Record of this run — the ${total} tool calls made since the request, oldest first, each ` +
      `with its outcome. Only the first ${RUN_RECORD_HEAD_CALLS} and the last ` +
      `${RUN_RECORD_TAIL_CALLS} are listed: calls ${firstHidden} to ${lastHidden} are not shown.`,
    framed([
      ...calls.slice(0, RUN_RECORD_HEAD_CALLS).map(line),
      `[… calls ${firstHidden} to ${lastHidden} not shown …]`,
      ...calls.slice(lastHidden).map((c, i) => line(c, lastHidden + i)),
    ]),
  ].join('\n');
}

/**
 * Les trois messages de la relance : la demande, la réponse relue, puis le
 * relevé du run suivi de la consigne.
 */
export function actionRecheckMessages(
  request: string,
  reply: string,
  run: readonly ModelMessage[] | null,
): ModelMessage[] {
  return [
    { role: 'user', content: request },
    { role: 'assistant', content: reply },
    { role: 'user', content: `${runRecord(run)}\n\n${ACTION_RECHECK}` },
  ];
}

/**
 * Relit `reply` contre `request` et ce que le run a déjà fait (`run`, voir
 * `runRecord`), avec les outils de l'appelant. Rend la réponse de la relance
 * telle quelle : l'appelant lit ses appels d'outils (aucun = la réponse relue
 * reste la réponse), et décide de ses erreurs.
 */
export function recheckNarratedAction(
  client: NodalLlmClient,
  opts: {
    request: string;
    reply: string;
    run: readonly ModelMessage[] | null;
    tools: Parameters<NodalLlmClient['generateText']>[0]['tools'];
    abortSignal?: AbortSignal;
  },
): ReturnType<NodalLlmClient['generateText']> {
  return client.generateText(
    {
      messages: actionRecheckMessages(opts.request, opts.reply, opts.run),
      tools: opts.tools,
      toolChoice: 'auto',
    },
    opts.abortSignal ? { abortSignal: opts.abortSignal } : undefined,
  );
}
