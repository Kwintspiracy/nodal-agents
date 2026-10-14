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
// La consigne et le relevé sont adressés au modèle, jamais montrés à
// l'utilisateur (invariant #2) : ils ne vivent que dans la requête de relance.

import type { ModelMessage } from 'ai';
import type { NodalLlmClient } from '@nodal-agents/llm';
import { cutForContext, elideBinary, framedForModel, unwrapUntrusted } from '@nodal-agents/shared';
import {
  EVICTED_TOOL_INPUT_MARKER,
  EVICTED_TOOL_RESULT_MARKER,
} from '../job/compaction-markers.ts';

export const ACTION_RECHECK =
  'Re-read your previous reply against the record above of what this run has already done. ' +
  'An action the record shows as done has happened: a reply that reports it commits to ' +
  'nothing, and you must not perform it again. ' +
  'If your reply committed to performing an action — running, launching, sending, fetching, ' +
  'creating, configuring, delegating, or any task or tool use — that the record does not show ' +
  'as done, then your text ALONE did nothing: call the tool that performs it NOW, conveying ' +
  'the request faithfully (its words and data, with no invented scope, method, or delivery). ' +
  'If your reply was pure conversation, a question, an answer, a report of what was done, or ' +
  'simply recalling a fact, do not call any tool — the reply stands as it is.';

/** Les appels listés depuis le DÉBUT du run quand il en a fait plus que le relevé n'en montre. */
export const RUN_RECORD_HEAD_CALLS = 5;
/** Les appels listés depuis la FIN du run, dans le même cas. */
export const RUN_RECORD_TAIL_CALLS = 15;
/** Les caractères gardés des arguments d'un appel. */
export const RUN_RECORD_ARGS_CHARS = 200;
/** Les caractères gardés du résultat d'un appel. */
export const RUN_RECORD_RESULT_CHARS = 200;

interface RecordedCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Un extrait du résultat d'un appel : déballé de son cadre, coupé, PUIS
 * recadré quand l'outil est un tiers (INJECT-001). Couper le texte encadré
 * pourrait retirer le délimiteur fermant.
 */
function excerpt(toolName: string, text: string): string {
  const content = oneLine(elideBinary(unwrapUntrusted(text)));
  return framedForModel(toolName, cutForContext(content, RUN_RECORD_RESULT_CHARS));
}

function argumentsOf(input: unknown): string {
  if (input === EVICTED_TOOL_INPUT_MARKER) return '(arguments elided from the transcript)';
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return cutForContext(oneLine(text), RUN_RECORD_ARGS_CHARS);
}

/**
 * L'issue d'un appel, lue sur la forme que le runner écrit : un bloc
 * `{ error }` est un échec (`mayHaveDelivered` : peut-être passé quand même),
 * un résultat retiré par la compaction n'est ni l'un ni l'autre. Tout le reste
 * est ce que l'outil a rendu, CITÉ, jamais résumé en « succès » : un marqueur
 * du runner (`[REJECTED]`, `[DEFERRED]`…) s'y lit tel qu'il est.
 */
function outcomeOf(toolName: string, output: unknown): string {
  if (output === undefined) return 'no result recorded';
  const out = output as { type?: unknown; value?: unknown } | null;
  const value = out?.value;
  if (out?.type === 'text' && value === EVICTED_TOOL_RESULT_MARKER) {
    return 'its result was elided from the transcript: the outcome is not known here';
  }
  if (out?.type === 'json' && value !== null && typeof value === 'object') {
    const v = value as { error?: unknown; mayHaveDelivered?: unknown };
    if (typeof v.error === 'string') {
      return v.mayHaveDelivered === true
        ? `failed, but it may have taken effect: ${excerpt(toolName, v.error)}`
        : `failed: ${excerpt(toolName, v.error)}`;
    }
    return `returned: ${excerpt(toolName, JSON.stringify(value))}`;
  }
  if (out?.type === 'error-text' && typeof value === 'string') {
    return `failed: ${excerpt(toolName, value)}`;
  }
  if (out?.type === 'error-json') return `failed: ${excerpt(toolName, JSON.stringify(value))}`;
  if (out?.type === 'text' && typeof value === 'string') {
    // Un `{ error }` trop long pour le budget arrive en texte, préfixe gardé
    // (le même repère que `isToolErrorBlock`, execute.ts).
    return value.startsWith('{"error":')
      ? `failed: ${excerpt(toolName, value)}`
      : `returned: ${excerpt(toolName, value)}`;
  }
  if (out?.type === 'content' && Array.isArray(value)) {
    const text = (value as Array<{ type?: unknown; text?: unknown } | null>)
      .map((p) =>
        p?.type === 'text' && typeof p.text === 'string' ? p.text : `[${String(p?.type)}]`,
      )
      .join(' ');
    return `returned: ${excerpt(toolName, text)}`;
  }
  return `returned: ${excerpt(toolName, JSON.stringify(output))}`;
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
    `${i + 1}. ${call.name} ${argumentsOf(call.input)} → ${outcomeOf(call.name, results.get(call.id))}`;
  const total = calls.length;
  if (total <= RUN_RECORD_HEAD_CALLS + RUN_RECORD_TAIL_CALLS) {
    return [
      `Record of this run — the ${total} tool call${total === 1 ? '' : 's'} made since the ` +
        'request, oldest first, each with its outcome:',
      ...calls.map(line),
    ].join('\n');
  }
  const firstHidden = RUN_RECORD_HEAD_CALLS + 1;
  const lastHidden = total - RUN_RECORD_TAIL_CALLS;
  return [
    `Record of this run — the ${total} tool calls made since the request, oldest first, each ` +
      `with its outcome. Only the first ${RUN_RECORD_HEAD_CALLS} and the last ` +
      `${RUN_RECORD_TAIL_CALLS} are listed: calls ${firstHidden} to ${lastHidden} are not shown.`,
    ...calls.slice(0, RUN_RECORD_HEAD_CALLS).map(line),
    `[… calls ${firstHidden} to ${lastHidden} not shown …]`,
    ...calls.slice(lastHidden).map((c, i) => line(c, lastHidden + i)),
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
