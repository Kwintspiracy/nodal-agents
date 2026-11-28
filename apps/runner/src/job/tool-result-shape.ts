// job/tool-result-shape.ts — ce que le runner écrit comme résultat d'outil.
//
// L'ISSUE d'un appel ne se lit plus ici (#1184) : elle est écrite une fois par
// la porte, dans `tool_calls.outcome`, et lue par `readCallOutcome`
// (@nodal-agents/shared). La forme d'un bloc de transcription ne dit plus si un
// appel a marché ; deux grammaires de cette forme avaient divergé (revue Nodal
// de la PR #740, passe 1), et une troisième rangeait en succès tout outil qui
// RENDAIT son échec.
//
// Les marques écrites par le runner vivent ici : la boucle les écrit et les
// relit, et un texte recopié à deux endroits finit par diverger.

import { fileURLToPath } from 'node:url';

/** Un appel suspendu le temps qu'une personne approuve ou réponde. */
export const AWAITING_APPROVAL_MARK = '[AWAITING_APPROVAL]';
/** Un appel qu'une personne a refusé. */
export const REJECTED_MARK = '[REJECTED]';
/** Un appel du même tour qu'un appel en attente d'approbation, non exécuté. */
export const DEFERRED_MARK = '[DEFERRED]';
/** Une demande d'approbation (ou une question) restée sans réponse jusqu'à son échéance. */
export const EXPIRED_MARK = '[EXPIRED]';

/** Ce que la compaction (Guard 1c, execute.ts) met à la place d'un résultat retiré. */
export const EVICTED_TOOL_RESULT_MARKER =
  '[earlier tool result elided to fit the context window — re-run the tool if you need this data again]';
/** …et à la place des gros arguments de l'appel dont le résultat est retiré. */
export const EVICTED_TOOL_INPUT_MARKER =
  '[earlier tool-call arguments elided to fit the context window]';

/** A `file:` URL as a path; null for one no path can be read from (relative, bad `%`). */
function pathOfFileUrl(url: string): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * A tool result's output as text, for every reader that has only text to give:
 * a text value as written, a value serialized, and an output that carries
 * files (`content`, `ctx.attachForModel`: an image, a PDF) as its text with
 * each file said — a file is not text, and where only text goes (a
 * delegation's side results, the reflection transcript) it is not carried.
 * That is said, never dropped, and the base64 never becomes text.
 */
export function toolResultOutputText(output: { type?: unknown; value?: unknown }): string {
  if (typeof output.value === 'string') return output.value;
  if (output.type === 'content' && Array.isArray(output.value)) {
    return (output.value as Array<{ type?: unknown; text?: unknown; url?: unknown }>)
      .map((v) => {
        if (v.type === 'text' && typeof v.text === 'string') return v.text;
        // A tool's file is kept as a file (job/model-images.ts): its path is
        // what can be read again. An image is an `image-*` part, a document a
        // `file-*` one.
        const what =
          typeof v.type === 'string' && v.type.startsWith('file') ? 'A document' : 'An image';
        const at =
          typeof v.url === 'string' && v.url.startsWith('file:') ? pathOfFileUrl(v.url) : null;
        return at === null
          ? `[${what} was attached to this result; it is not carried here.]`
          : `[${what} was attached to this result, saved at ${at}; it is not carried here. Read it again to see it.]`;
      })
      .join('\n');
  }
  return JSON.stringify(output.value ?? null);
}

/**
 * Was this result removed from the transcript by the compaction (Guard 1c)?
 * A fact of the TRANSCRIPT, not of the call: what became of a call is its
 * row's outcome (`tool_calls.outcome`, #1184), and nothing here reads it.
 */
export function isElidedToolResult(output: unknown): boolean {
  const out = output as { type?: unknown; value?: unknown } | null | undefined;
  return out?.type === 'text' && out.value === EVICTED_TOOL_RESULT_MARKER;
}
