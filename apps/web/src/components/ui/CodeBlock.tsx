// CodeBlock — un bloc de code du markdown, dessiné comme une carte du fil
// (P2bis). L'en-tête porte la langue en pastille, le nom du fichier et la
// copie ; le corps numérote ses lignes, garde les espaces et défile.
//
// COLORATION : JSON, ET RIEN D'AUTRE. Aucune bibliothèque de coloration ne vit
// dans ce dépôt et il n'en entrera pas — une grammaire par langage dans le fil
// coûte plus qu'elle ne rend. Le JSON fait exception parce qu'il se découpe
// sans grammaire (`lib/json-tokens.ts`, une cinquantaine de lignes pures) et
// parce que c'est ce qu'on lit vraiment ici : l'entrée et le résultat d'un
// appel d'outil. Les autres langues gardent les numéros de ligne et la
// gouttière, qui font déjà l'essentiel : on sait qu'on lit du code, et on peut
// en citer une ligne.
//
// Sans `'use client'` : aucun hook ici, le seul morceau interactif est
// `CopyButton`, déjà un composant client. Rendu côté serveur par le markdown
// du fil, et côté navigateur quand un composant client (`ToolBlock`) l'importe
// — les deux sont valides pour un composant sans état.

import { Fragment } from 'react';
import { MonoMicroTag } from './MonoMicroTag';
import CopyButton from './CopyButton';
import { tokenizeJson, type JsonTokenKind } from '@/lib/json-tokens';

/** La couleur de chaque jeton. `space` n'en a pas : il prend celle du bloc. */
const TOKEN_CLASS: Readonly<Record<JsonTokenKind, string | null>> = {
  key: 'text-code-key',
  string: 'text-code-string',
  number: 'text-code-number',
  keyword: 'text-code-keyword',
  punct: 'text-code-punct',
  bracket: 'text-code-bracket',
  space: null,
};

export default function CodeBlock({
  code,
  lang = null,
  filename = null,
  className = 'mb-3',
  lineNumbers = true,
}: {
  code: string;
  lang?: string | null;
  filename?: string | null;
  /**
   * L'espacement extérieur du bloc. Par défaut la marge du markdown ; un
   * appelant qui pose déjà son propre espacement (le corps d'un appel d'outil)
   * passe `''`, plutôt que d'espérer qu'une classe en écrase une autre.
   */
  className?: string;
  /**
   * La gouttière de numéros de ligne. Un bloc de code du markdown les garde :
   * on peut citer une ligne. L'entrée ou le résultat d'un appel d'outil ne les
   * veut pas (Quentin, 18/09) : c'est une charge utile, pas un fichier.
   */
  lineNumbers?: boolean;
}) {
  // La dernière ligne d'un bloc de code se termine presque toujours par un
  // saut : le compter donnerait un numéro de plus que de lignes écrites.
  const lines = code.replace(/\n$/, '').split('\n');
  const body = lines.join('\n');
  return (
    <div
      className={`overflow-hidden rounded-xl border border-rule-2 bg-code-bg text-code-text ${className}`}
    >
      <div className="flex h-[36px] items-center gap-2.5 border-b border-rule-2 px-3.5">
        {lang !== null && lang !== '' && <MonoMicroTag tone="ink">{lang}</MonoMicroTag>}
        {filename !== null && filename !== '' && (
          <span className="min-w-0 truncate text-mono-12 text-ink">{filename}</span>
        )}
        <CopyButton
          value={code}
          className="ml-auto h-auto border-0 bg-transparent px-0 text-mono-11 text-ink-4"
        />
      </div>
      <div className="max-h-[480px] overflow-auto">
        {lineNumbers ? (
          <div className="grid grid-cols-[36px_1fr] py-2">
            <div className="pr-2 text-right text-mono-13 text-ink-4 select-none" aria-hidden>
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="pr-4 text-mono-13">
              {lang === 'json' ? <Coloured code={body} /> : body}
            </pre>
          </div>
        ) : (
          <pre className="px-4 py-3 text-mono-13 whitespace-pre-wrap break-words">
            {lang === 'json' ? <Coloured code={body} /> : body}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Le même texte, jeton par jeton. Un texte qui n'est pas du JSON en ressort
 * entier et sans couleur — `tokenizeJson` ne jette jamais.
 */
function Coloured({ code }: { code: string }) {
  return (
    <>
      {tokenizeJson(code).map((token, i) => {
        const cls = TOKEN_CLASS[token.kind];
        return cls === null ? (
          <Fragment key={i}>{token.text}</Fragment>
        ) : (
          <span key={i} className={cls}>
            {token.text}
          </span>
        );
      })}
    </>
  );
}
