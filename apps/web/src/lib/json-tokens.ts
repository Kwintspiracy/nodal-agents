// json-tokens — découpe un JSON DÉJÀ mis en forme en jetons colorables.
//
// Ce n'est PAS un parseur : on ne construit aucune valeur, on lit le texte de
// gauche à droite et on nomme ce qu'on voit. C'est ce qui permet de tenir en
// cinquante lignes, sans dépendance, là où une bibliothèque de coloration
// embarquerait une grammaire par langage dans le fil.
//
// Une clé n'est pas un type : c'est une CHAÎNE SUIVIE DE `:`. En JSON, une
// chaîne-valeur est toujours suivie d'une virgule, d'une fermeture ou de la fin
// — jamais d'un deux-points. Le test le tient par les deux bouts : une chaîne
// qui CONTIENT un `:` ou un guillemet échappé n'est pas prise pour une clé.
//
// Rien ne casse sur un texte qui n'est pas du JSON : au premier caractère
// qu'on ne sait pas nommer, on rend le texte ENTIER en un seul jeton non
// coloré. Le bloc affiche alors du texte brut, ce qu'il est.

export type JsonTokenKind = 'key' | 'string' | 'number' | 'keyword' | 'punct' | 'bracket' | 'space';

export type JsonToken = { kind: JsonTokenKind; text: string };

const KEYWORDS = ['true', 'false', 'null'] as const;

/** Fin d'une chaîne ouverte en `start` (le guillemet), échappements compris. */
function endOfString(text: string, start: number): number | null {
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') return i + 1;
  }
  return null;
}

/** Fin d'un nombre JSON commencé en `start`, ou `null` si ce n'en est pas un. */
function endOfNumber(text: string, start: number): number | null {
  const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(start));
  return m === null || m[0] === '' ? null : start + m[0].length;
}

/**
 * Les jetons de `text`, supposé être du JSON mis en forme. Un texte qui n'est
 * pas du JSON revient entier, en un unique jeton `space` — le composant qui
 * l'affiche ne colore rien et ne perd rien.
 */
export function tokenizeJson(text: string): JsonToken[] {
  if (text === '') return [];
  const out: JsonToken[] = [];
  const plain: JsonToken[] = [{ kind: 'space', text }];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      out.push({ kind: 'space', text: text.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      const end = endOfString(text, i);
      if (end === null) return plain;
      let after = end;
      while (after < text.length && /\s/.test(text[after] as string)) after += 1;
      out.push({ kind: text[after] === ':' ? 'key' : 'string', text: text.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']') {
      out.push({ kind: 'bracket', text: c });
      i += 1;
      continue;
    }
    if (c === ':' || c === ',') {
      out.push({ kind: 'punct', text: c });
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const end = endOfNumber(text, i);
      if (end === null) return plain;
      out.push({ kind: 'number', text: text.slice(i, end) });
      i = end;
      continue;
    }
    const word = KEYWORDS.find((k) => text.startsWith(k, i));
    if (word !== undefined) {
      out.push({ kind: 'keyword', text: word });
      i += word.length;
      continue;
    }
    return plain;
  }
  return out;
}

/**
 * Au-delà de cette taille, une sortie d'outil n'est plus mise en forme : parser
 * et réécrire le texte le double en mémoire à CHAQUE rendu du fil, et un fil
 * assemble jusqu'à vingt fils de délégués (Reviewer C, #155). Le texte brut
 * reste lisible et copiable ; seule l'indentation manque.
 */
export const PRETTY_JSON_MAX_CHARS = 32_000;

/**
 * `text` mis en forme sur deux espaces s'il est du JSON, `null` sinon. C'est le
 * seul endroit qui DÉCIDE qu'une sortie d'outil est du JSON — un appelant qui
 * reçoit `null` affiche le texte tel quel, sans pastille de langue. Un texte
 * plus long que `PRETTY_JSON_MAX_CHARS` rend `null` aussi, sans être parsé.
 */
export function prettyJson(text: string): string | null {
  if (text.length > PRETTY_JSON_MAX_CHARS) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}
