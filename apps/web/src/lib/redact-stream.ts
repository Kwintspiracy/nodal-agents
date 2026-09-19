// redact-stream.ts — la MÊME rédaction des secrets que le fil, sur un texte qui
// arrive par morceaux (#152).
//
// Le problème que ça ferme : `redactSecretsInText` regarde un texte entier. Un
// flux le livre en fragments, et un secret tombe à cheval sur deux d'entre eux
// (« sk-abc » dans l'un, « def… » dans l'autre). Masquer chaque fragment pris
// isolément ne verrait ni l'un ni l'autre, et le jeton passerait en clair — la
// fuite exacte que SECRET-001 existe pour fermer.
//
// La règle, et elle est simple : on n'émet jamais un fragment qui pourrait être
// le DÉBUT d'un secret. Toutes les formes que `redactSecretsInText` reconnaît
// sont sans espace, sauf deux (`Bearer <jeton>` et un bloc de clé privée). Donc
// couper sur une espace, en tenant compte de ces deux exceptions, ne peut jamais
// couper une correspondance en deux. Ce qui reste après la coupure attend le
// fragment suivant, ou la fin du flux.
//
// Le prix : le dernier mot en cours de frappe n'apparaît qu'une fois terminé.
// C'est ce que fait n'importe quel chat qui découpe par mots, et c'est le seul
// découpage où un secret ne peut pas se faufiler.

import { redactSecretsInText } from '@nodal-agents/shared';

/** Le mot qui précède une coupure candidate, en minuscules. */
function wordBefore(buffer: string, cut: number): string {
  let end = cut;
  while (end > 0 && /\s/.test(buffer[end - 1] ?? '')) end--;
  let start = end;
  while (start > 0 && !/\s/.test(buffer[start - 1] ?? '')) start--;
  return buffer.slice(start, end).toLowerCase();
}

/**
 * Jusqu'où peut-on émettre sans risquer de couper un secret en deux ?
 *
 * Rend un index dans `buffer` (0 = rien à émettre). Trois gardes :
 *   1. la coupure tombe APRÈS une espace — aucune forme sans espace ne l'enjambe ;
 *   2. le mot qui précède n'est pas `bearer` — `Bearer <jeton>` porte une espace
 *      en son milieu, c'est la seule forme courte qui le fasse ;
 *   3. rien ne sort à partir d'un `-----BEGIN` dont le `-----END` n'est pas
 *      encore arrivé — un bloc de clé privée est long et plein d'espaces.
 */
function safeCut(buffer: string): number {
  let limit = buffer.length;
  const begin = buffer.lastIndexOf('-----BEGIN');
  if (begin !== -1 && buffer.indexOf('-----END', begin) === -1) limit = begin;
  // Un `-----BEGIN` partiel en fin de tampon (« -----BEG ») doit attendre la
  // suite lui aussi, sinon il partirait avant qu'on sache ce qu'il ouvre.
  for (let n = '-----BEGIN'.length - 1; n > 0; n--) {
    if (buffer.endsWith('-----BEGIN'.slice(0, n))) {
      limit = Math.min(limit, buffer.length - n);
      break;
    }
  }

  for (let i = limit; i > 0; i--) {
    if (!/\s/.test(buffer[i - 1] ?? '')) continue;
    if (wordBefore(buffer, i - 1) === 'bearer') continue;
    return i;
  }
  return 0;
}

export interface StreamRedactor {
  /** Le texte masqué prêt à sortir pour ce fragment (souvent vide). */
  push(chunk: string): string;
  /** La fin du flux : tout ce qui restait, masqué. */
  flush(): string;
}

/** Un masqueur qui garde en réserve ce qui pourrait encore devenir un secret. */
export function createStreamRedactor(): StreamRedactor {
  let buffer = '';
  return {
    push(chunk: string): string {
      buffer += chunk;
      const cut = safeCut(buffer);
      if (cut === 0) return '';
      const out = redactSecretsInText(buffer.slice(0, cut));
      buffer = buffer.slice(cut);
      return out;
    },
    flush(): string {
      const out = buffer === '' ? '' : redactSecretsInText(buffer);
      buffer = '';
      return out;
    },
  };
}
