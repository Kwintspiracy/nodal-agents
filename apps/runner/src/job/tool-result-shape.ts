// job/tool-result-shape.ts — ce que le runner écrit comme résultat d'outil, et
// la SEULE lecture de son issue.
//
// Deux lecteurs lisaient l'issue d'un appel chacun à sa façon : la garde de la
// boucle qui retient un `return_result` à côté d'un outil en échec
// (`isToolErrorBlock`, execute.ts), et le relevé que reçoit la relecture d'une
// réponse (#711, llm/action-recheck.ts). Leurs grammaires divergeaient (revue
// Nodal de la PR #740, passe 1) : `{ error: 500 }` était une erreur pour l'une
// et un résultat rendu pour l'autre. Une seule fonction les sert maintenant.
//
// Les marques écrites par le runner vivent ici aussi : la boucle les écrit, le
// relevé les lit, et un texte recopié à deux endroits finit par diverger.

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

/**
 * A tool result's output as text, for every reader that has only text to give:
 * a text value as written, a value serialized, and an output that carries
 * images (`content`, `ctx.attachImage`) as its text with each image said — an
 * image is not text, and where only text goes (a delegation's side results,
 * the reflection transcript, the run record a recheck reads) it is not
 * carried. That is said, never dropped, and the base64 never becomes text.
 */
export function toolResultOutputText(output: { type?: unknown; value?: unknown }): string {
  if (typeof output.value === 'string') return output.value;
  if (output.type === 'content' && Array.isArray(output.value)) {
    return (output.value as Array<{ type?: unknown; text?: unknown; url?: unknown }>)
      .map((v) => {
        if (v.type === 'text' && typeof v.text === 'string') return v.text;
        // A tool's image is kept as a file (job/model-images.ts): its path is
        // what can be read again.
        const at =
          typeof v.url === 'string' && v.url.startsWith('file:') ? fileURLToPath(v.url) : null;
        return at === null
          ? '[An image was attached to this result; it is not carried here.]'
          : `[An image was attached to this result, saved at ${at}; it is not carried here. Read it again to see it.]`;
      })
      .join('\n');
  }
  return JSON.stringify(output.value ?? null);
}

export type ToolResultShape =
  /** Ce que l'outil a rendu. */
  | 'ok'
  /** Un échec : un bloc `{ error }`, ou son texte coupé au budget (préfixe gardé). */
  | 'error'
  /** Un échec ambigu : l'envoi a peut-être eu lieu (`mayHaveDelivered`). */
  | 'may_have_delivered'
  | 'awaiting_approval'
  | 'rejected'
  | 'deferred'
  | 'expired'
  /** Retiré par la compaction : l'issue n'est plus dans la transcription. */
  | 'elided';

/**
 * L'issue d'un résultat d'outil, lue sur la forme que le runner écrit.
 *
 * Un `{ error }` trop long pour le budget arrive en TEXTE : `truncateForContext`
 * ne touche que ce qui suit le préfixe `{"error":`, qui reste donc un repère
 * sûr. Un `mayHaveDelivered` n'est pas un échec à corriger : le traiter comme
 * tel pousserait le modèle à renvoyer un message probablement parti.
 */
export function toolResultShape(output: unknown): ToolResultShape {
  const out = output as { type?: unknown; value?: unknown } | null | undefined;
  const value = out?.value;
  if (out?.type === 'json') {
    if (value === null || typeof value !== 'object') return 'ok';
    const v = value as Record<string, unknown>;
    if (v['mayHaveDelivered'] === true) return 'may_have_delivered';
    return 'error' in v ? 'error' : 'ok';
  }
  if (out?.type === 'text' && typeof value === 'string') {
    if (value.startsWith('{"error":')) return 'error';
    if (value === EVICTED_TOOL_RESULT_MARKER) return 'elided';
    if (value.startsWith(AWAITING_APPROVAL_MARK)) return 'awaiting_approval';
    if (value.startsWith(REJECTED_MARK)) return 'rejected';
    if (value.startsWith(DEFERRED_MARK)) return 'deferred';
    if (value.startsWith(EXPIRED_MARK)) return 'expired';
  }
  return 'ok';
}
