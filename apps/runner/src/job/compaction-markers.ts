// job/compaction-markers.ts — ce que la compaction (Guard 1c, execute.ts) met
// à la place d'un résultat ou d'arguments d'outil retirés de la transcription.
//
// Lus par la compaction qui les écrit, et par le relevé du run que reçoit la
// relecture d'une réponse (#711, llm/action-recheck.ts) : un résultat retiré
// n'y passe ni pour un succès ni pour un échec, il est dit retiré.

export const EVICTED_TOOL_RESULT_MARKER =
  '[earlier tool result elided to fit the context window — re-run the tool if you need this data again]';
export const EVICTED_TOOL_INPUT_MARKER =
  '[earlier tool-call arguments elided to fit the context window]';
