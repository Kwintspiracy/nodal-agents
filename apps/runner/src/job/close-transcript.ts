// job/close-transcript.ts — les appels d'outil d'une transcription restés sans résultat (#561).
//
// La règle de #561 : chaque tool_use d'un tour repart avec son tool_result,
// quelle que soit la sortie. La boucle l'applique là où elle construit le
// message d'outils d'un tour (`closeTurn`). Une transcription PERSISTÉE à la
// fin d'un run — un échec, une annulation — doit la tenir aussi : sinon
// `validateMessageStructure` la refuse (`unmatched_tool_use`,
// `unresolved_tail`) dès que quelqu'un la relit comme une conversation.

import type { ModelMessage } from 'ai';

/** Un appel d'outil d'une transcription, par son id et son nom. */
export interface ToolCallRef {
  toolCallId: string;
  toolName: string;
}

/** Les appels d'outil de `messages` qu'aucun tool_result ne suit, dans l'ordre. */
export function unansweredToolCalls(messages: readonly ModelMessage[]): ToolCallRef[] {
  const appels: ToolCallRef[] = [];
  const rendus = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ReadonlyArray<{
      type?: string;
      toolCallId?: string;
      toolName?: string;
    }>) {
      if (!part.toolCallId) continue;
      if (m.role === 'assistant' && part.type === 'tool-call') {
        appels.push({ toolCallId: part.toolCallId, toolName: part.toolName ?? '' });
      }
      if (m.role === 'tool' && part.type === 'tool-result') rendus.add(part.toolCallId);
    }
  }
  return appels.filter((a) => !rendus.has(a.toolCallId));
}
