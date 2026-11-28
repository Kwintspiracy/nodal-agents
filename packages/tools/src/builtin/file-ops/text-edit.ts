// file-ops/text-edit.ts — un remplacement exact dans un fichier texte, qui ne
// touche QUE les octets du texte remplacé.
//
// La couche texte (`text-file.ts`) a rendu le fichier comme texte et sa forme.
// Ici, le remplacement :
//
//  - se cherche sur une vue du texte où chaque CRLF est ramené à LF, et la
//    citation du modèle aussi : un modèle qui cite trois lignes d'un fichier
//    Windows avec des `\n` trouve son texte (B05-22). La correspondance est
//    ramenée aux positions du vrai texte ;
//  - prend les fins de ligne de l'endroit qu'il remplace (CRLF s'il en
//    contient, LF s'il en contient, sinon celles qui dominent dans le fichier) ;
//  - est encodé dans l'encodage du fichier, et refusé, caractère nommé, quand
//    cet encodage ne le porte pas ;
//  - est ÉPISSÉ dans les octets d'origine : tout ce qui est hors des passages
//    remplacés est COPIÉ du fichier lu, jamais réencodé. Les octets que l'outil
//    n'a pas changés reviennent identiques, par construction.

import iconv from 'iconv-lite';
import { encodeFragment, withLineEndings, type TextForm } from './text-file';

export type SpliceResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly replacements: number }
  | { readonly ok: false; readonly why: 'not_found' | 'ambiguous' }
  | { readonly ok: false; readonly why: 'unrepresentable'; readonly detail: string };

/** La vue LF de `text`, et l'indice (dans cette vue) de chaque `\n` dont un `\r` a été retiré. */
function lfView(text: string): { view: string; removed: number[] } {
  const parts: string[] = [];
  const removed: number[] = [];
  let last = 0;
  for (let i = text.indexOf('\r\n'); i !== -1; i = text.indexOf('\r\n', i + 2)) {
    parts.push(text.slice(last, i));
    removed.push(i - removed.length);
    last = i + 1;
  }
  parts.push(text.slice(last));
  return { view: parts.join(''), removed };
}

/** Le nombre d'éléments de `sorted` strictement inférieurs à `n`. */
function countBelow(sorted: readonly number[], n: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < n) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const encodedLength = (text: string, encoding: string): number =>
  encoding === 'utf-8'
    ? Buffer.byteLength(text, 'utf8')
    : iconv.encode(text, encoding, { addBOM: false }).length;

/**
 * Remplace `old_string` par `new_string` dans le fichier `file` (ses octets
 * lus), dont la couche texte a rendu `text` et `form`.
 */
export function spliceEdit(
  file: Uint8Array,
  text: string,
  form: TextForm,
  edit: { readonly old_string: string; readonly new_string: string; readonly replace_all: boolean },
): SpliceResult {
  const { view, removed } = lfView(text);
  const needle = edit.old_string.replace(/\r\n/g, '\n');
  const starts: number[] = [];
  const first = view.indexOf(needle);
  if (first === -1) return { ok: false, why: 'not_found' };
  if (edit.replace_all) {
    for (let i = first; i !== -1; i = view.indexOf(needle, i + needle.length)) starts.push(i);
  } else {
    if (view.indexOf(needle, first + 1) !== -1) return { ok: false, why: 'ambiguous' };
    starts.push(first);
  }
  const toText = (n: number): number => n + countBelow(removed, n);
  // Les fins de ligne qui dominent dans le fichier : celles d'un remplacement
  // qui tombe sur un passage sans fin de ligne.
  const lfOnly = (view.match(/\n/g)?.length ?? 0) - removed.length;
  const dominant = removed.length > lfOnly ? 'crlf' : 'lf';

  const bomLength = form.bom ? file.length - encodedLength(text, form.encoding) : 0;
  const out: Uint8Array[] = [file.subarray(0, bomLength)];
  let atText = 0;
  let atByte = bomLength;
  for (const s of starts) {
    const from = toText(s);
    const to = toText(s + needle.length);
    const passage = text.slice(from, to);
    const eol = passage.includes('\r\n') ? 'crlf' : passage.includes('\n') ? 'lf' : dominant;
    const replacement = encodeFragment(withLineEndings(edit.new_string, eol), form.encoding);
    if (!replacement.ok) return { ok: false, why: 'unrepresentable', detail: replacement.detail };
    const gap = encodedLength(text.slice(atText, from), form.encoding);
    out.push(file.subarray(atByte, atByte + gap), replacement.bytes);
    atByte += gap + encodedLength(passage, form.encoding);
    atText = to;
  }
  // Ce qui reste est copié tel quel. La longueur réencodée du reste doit être
  // exactement celle des octets qui restent : la couche texte l'a garanti
  // (aller-retour vérifié, encodage sans états). Le contraire est un défaut de
  // la plateforme, et il se dit au lieu d'écrire un fichier faux.
  if (encodedLength(text.slice(atText), form.encoding) !== file.length - atByte) {
    throw new Error(
      `text layer: the byte offsets of "${form.encoding}" text do not add up; nothing was written`,
    );
  }
  out.push(file.subarray(atByte));
  return { ok: true, bytes: Buffer.concat(out), replacements: starts.length };
}
