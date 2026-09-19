// Markdown — le texte d'un agent, rendu (P2bis, plan « De la maquette au
// produit »).
//
// Le fil montrait `**gras**`, `## titres` et les backticks tels quels : ce que
// le LLM écrit est du markdown, et l'écran l'affichait comme du texte brut.
// Ce composant le parse (`remark-parse` + GFM) et rend l'arbre mdast vers des
// éléments React, avec les tokens du design system — jamais une taille en
// pixels, jamais une couleur hors tokens.
//
// AUCUN HTML BRUT n'est jamais interprété : un nœud `html` du markdown se rend
// comme du TEXTE échappé, et une image se rend comme un lien vers son URL. Le
// texte vient d'un LLM et de ce qu'un outil a lu ; le laisser injecter des
// balises serait une faille, pas une fonctionnalité. `dangerouslySetInnerHTML`
// n'apparaît nulle part dans ce fichier — c'est la garantie.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Nodes, RootContent, TableCell, TableRow } from 'mdast';
import Table, { THead, Th, Tr, Td } from './ui/Table';
import CodeBlock from './ui/CodeBlock';

export type MarkdownTone = 'agent' | 'user';

const processor = unified().use(remarkParse).use(remarkGfm);

function parse(text: string): Nodes {
  return processor.parse(text) as Nodes;
}

/**
 * Le texte PLAT d'un markdown : sa première ligne non vide, les espaces
 * repliés. Sert aux titres de page (`## **PRD**, Podium` doit se lire
 * « PRD, Podium ») et à décider si un texte est « long » avant de le replier —
 * la longueur du markdown source compterait les astérisques.
 */
export function plainText(markdown: string): string {
  const tree = parse(markdown);
  // Le PREMIER bloc, pas l'arbre entier : `mdastToString` colle les blocs sans
  // séparateur, et « # Titre\n\nsuite » rendrait « Titresuite ».
  const first = 'children' in tree ? (tree.children as RootContent[])[0] : undefined;
  const flat = mdastToString(first ?? tree);
  const firstLine = flat.split('\n').find((l) => l.trim() !== '') ?? '';
  return firstLine.replace(/\s+/g, ' ').trim();
}

/** Une ligne lisible d'un markdown, et le BLOC d'où elle vient. */
export type PlainLine = {
  /** Le texte aplati, espaces repliés — jamais les astérisques du source. */
  text: string;
  /**
   * Le type du nœud mdast qui la porte : `paragraph`, `heading`, `list`,
   * `code`, `table`… Un lecteur qui n'accepte qu'une phrase s'en sert pour
   * écarter une puce ou un bloc de code SANS relire le markdown lui-même.
   */
  block: string;
};

/**
 * Les PREMIÈRES lignes lisibles d'un markdown, bloc par bloc, avec leur
 * provenance.
 *
 * Pourquoi cette fonction existe (#198) : `plainText` ne rend que la première
 * ligne du PREMIER bloc, si bien qu'un lecteur qui cherche quelque chose « à la
 * ligne suivante » sur son résultat ne trouve jamais rien. La règle du verdict
 * du fil portait exactement cette branche morte.
 *
 * Bloc par bloc, et jamais `mdastToString` sur l'arbre entier : il colle les
 * blocs sans séparateur, et « # Titre\n\nsuite » rendrait « Titresuite ». Les
 * sauts DANS un bloc comptent aussi, parce qu'un paragraphe peut porter
 * plusieurs lignes (« Verdict\nça passe » est un seul paragraphe).
 *
 * `max` borne le travail : un lecteur qui veut deux lignes ne paie pas
 * l'aplatissement d'un résultat de cinq cents lignes.
 */
export function plainLines(markdown: string, max: number): PlainLine[] {
  if (max <= 0) return [];
  const tree = parse(markdown);
  const blocks = 'children' in tree ? (tree.children as RootContent[]) : [];
  const out: PlainLine[] = [];
  for (const block of blocks) {
    for (const raw of mdastToString(block).split('\n')) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      out.push({ text, block: block.type });
      if (out.length === max) return out;
    }
  }
  return out;
}

export default function Markdown({
  text,
  tone = 'agent',
  className = '',
}: {
  text: string;
  tone?: MarkdownTone;
  className?: string;
}) {
  const tree = parse(text);
  const children = 'children' in tree ? (tree.children as RootContent[]) : [];
  return <div className={`break-words ${className}`}>{children.map(renderNode(tone))}</div>;
}

function renderNode(tone: MarkdownTone) {
  return function render(node: RootContent, index: number): React.ReactNode {
    return <MdNode key={index} node={node} tone={tone} />;
  };
}

function kids(node: { children?: RootContent[] }, tone: MarkdownTone): React.ReactNode[] {
  return (node.children ?? []).map((child, i) => <MdNode key={i} node={child} tone={tone} />);
}

/**
 * La PROSE, par voix (#135) — la largeur, la taille et l'encre de tout ce qui
 * est du texte courant : un paragraphe et une liste, jamais un titre ni du
 * code.
 *
 * L'agent parle en 13 px, dans sa couleur à lui (`feed/prose`, la dixième du
 * nuancier du fil). En 15 px il écrasait tout ce qui l'entoure — blocs
 * d'outil, cartes et lignes d'appel sont tous en 13 ou moins. La DEMANDE, elle,
 * ne bouge pas : sa bulle est courte, c'est la phrase que l'utilisateur relit,
 * et c'est elle qui donne l'échelle au fil.
 *
 * UNE fonction pour les deux sortes de blocs : une liste à puces écrite dans
 * une taille et une couleur autres que la phrase qui l'introduit se lit comme
 * un autre document.
 */
function prose(tone: MarkdownTone): string {
  return tone === 'agent'
    ? 'max-w-[68ch] text-body-13 text-feed-prose'
    : 'max-w-[68ch] text-body-15 text-ink';
}

/**
 * L'adresse d'un lien telle qu'on accepte de la poser dans un `href`, ou
 * `null`. Le texte vient d'un LLM ou d'un outil : `[ici](javascript:…)` serait
 * un clic qui exécute du code, `data:` une page forgée. Seuls `http`, `https`,
 * `mailto` et les adresses relatives (`/…`, `./…`, `#…`, `?…`, un nom nu sans
 * schéma) passent ; tout autre schéma — connu ou non — rend `null`.
 */
export function safeHref(url: string): string | null {
  // Les caractères de contrôle et les espaces sont retirés AVANT de lire le
  // schéma : un navigateur les ignore dans une URL, donc « java\nscript: »
  // ou « \tjavascript: » exécuteraient ce que la regex n'aurait pas vu.
  const cleaned = url.replace(/[\u0000-\u0020\u007f]/g, '');
  if (cleaned === '') return null;
  // « //evil.test » n'a pas de schéma mais quitte le site : pas un lien.
  if (cleaned.startsWith('//')) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (scheme === null) return cleaned;
  const name = scheme[1]?.toLowerCase();
  return name === 'http' || name === 'https' || name === 'mailto' ? cleaned : null;
}

function MdNode({ node, tone }: { node: RootContent; tone: MarkdownTone }): React.ReactNode {
  // P2bis — la prose de l'agent est à la MÊME encre que celle de
  // l'utilisateur (`text-ink`). Le design ne distingue pas les deux voix par
  // la couleur : ce qui les distingue, c'est l'avatar et la carte autour de la
  // demande. En `ink-2`, la parole de l'agent — le fond du fil — se lisait
  // comme une note de bas de page.
  //
  // #135 revient là-dessus pour la PROSE — paragraphes et listes : la voix de
  // l'agent a désormais sa taille (13 px) et sa couleur (`feed/prose`),
  // données par Quentin. Ce n'est pas `ink-2` qui revient — c'est une entrée
  // du nuancier du fil, au même titre que `feed/tool` ou `feed/model`.
  switch (node.type) {
    case 'paragraph':
      return <p className={`mb-3 last:mb-0 ${prose(tone)}`}>{kids(node, tone)}</p>;
    case 'heading':
      return node.depth <= 2 ? (
        <h2 className="mt-4 mb-2 text-title-15 text-ink first:mt-0">{kids(node, tone)}</h2>
      ) : (
        <h3 className="mt-3 mb-1.5 text-title-13 text-ink first:mt-0">{kids(node, tone)}</h3>
      );
    case 'strong':
      return <strong className="font-semibold text-ink">{kids(node, tone)}</strong>;
    case 'emphasis':
      return <em className="italic">{kids(node, tone)}</em>;
    case 'delete':
      return <del className="text-ink-4 line-through">{kids(node, tone)}</del>;
    case 'inlineCode':
      return (
        <code className="rounded-[5px] bg-hover px-1 py-0.5 text-mono-12 text-ink-2">
          {node.value}
        </code>
      );
    case 'code':
      return (
        <CodeBlock
          code={node.value}
          lang={node.lang ?? null}
          {...(node.meta !== null && node.meta !== undefined && node.meta !== ''
            ? { filename: node.meta }
            : {})}
        />
      );
    case 'break':
      return <br />;
    case 'thematicBreak':
      return <hr className="my-4 border-rule-2" />;
    case 'blockquote':
      return (
        <blockquote className="mb-3 border-l-2 border-rule pl-3 text-ink-3">
          {kids(node, tone)}
        </blockquote>
      );
    case 'list':
      return node.ordered === true ? (
        <ol className={`mb-3 list-decimal space-y-1 pl-5 ${prose(tone)}`}>{kids(node, tone)}</ol>
      ) : (
        <ul className={`mb-3 list-disc space-y-1 pl-5 ${prose(tone)}`}>{kids(node, tone)}</ul>
      );
    case 'listItem':
      // Une case à cocher est un ÉTAT, pas un contrôle : le fil est un compte
      // rendu, pas un formulaire. Un caractère, jamais un `<input>`.
      return (
        <li className={node.checked === null || node.checked === undefined ? '' : 'list-none'}>
          {node.checked === true && <span className="mr-1 text-mono-12 text-ok">✓</span>}
          {node.checked === false && <span className="mr-1 text-mono-12 text-ink-4">◻</span>}
          {kids(node, tone)}
        </li>
      );
    case 'link': {
      const href = safeHref(node.url);
      // Une URL qu'on ne suit pas (`javascript:`, `data:`, `vbscript:`…) n'est
      // pas un lien : le texte reste, l'adresse est dite entre parenthèses.
      if (href === null) {
        return (
          <>
            {kids(node, tone)}
            <span className="text-mono-11 text-ink-4"> ({node.url})</span>
          </>
        );
      }
      const external = /^(https?|mailto):/i.test(href);
      return (
        <a
          href={href}
          {...(node.title ? { title: node.title } : {})}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="text-ink underline decoration-rule underline-offset-2 hover:decoration-ink"
        >
          {kids(node, tone)}
        </a>
      );
    }
    case 'image': {
      // Pas de `<img>` : le fil ne charge pas une ressource distante décidée
      // par le texte d'un LLM. L'adresse est dite, et se suit d'un clic — si
      // c'est une adresse qu'on suit.
      const label =
        node.alt !== null && node.alt !== undefined && node.alt !== '' ? node.alt : node.url;
      const href = safeHref(node.url);
      if (href === null) return <span className="text-mono-11 text-ink-4">{label}</span>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink underline decoration-rule underline-offset-2 hover:decoration-ink"
        >
          {label}
        </a>
      );
    }
    case 'table':
      return <MdTable node={node} tone={tone} />;
    case 'text':
      return node.value;
    case 'html':
      // Le HTML du markdown se rend comme TEXTE. React échappe la valeur : la
      // balise s'affiche, elle ne s'exécute pas.
      return node.value;
    case 'footnoteReference':
      return <sup className="text-mono-11 text-ink-4">[{node.identifier}]</sup>;
    default:
      // Un nœud que cet écran ne dessine pas encore : son texte, jamais rien.
      return mdastToString(node);
  }
}

function MdTable({
  node,
  tone,
}: {
  node: Extract<RootContent, { type: 'table' }>;
  tone: MarkdownTone;
}) {
  const rows = node.children as TableRow[];
  const head = rows[0];
  const body = rows.slice(1);
  const align = (i: number): 'left' | 'right' => (node.align?.[i] === 'right' ? 'right' : 'left');
  return (
    <div className="mb-3 overflow-x-auto rounded-lg border border-rule-2">
      <Table frame={false}>
        {head && (
          <THead>
            {(head.children as TableCell[]).map((cell, i) => (
              <Th key={i} align={align(i)}>
                {kids(cell, tone)}
              </Th>
            ))}
          </THead>
        )}
        <tbody>
          {body.map((row, ri) => (
            <Tr key={ri}>
              {(row.children as TableCell[]).map((cell, ci) => (
                <Td key={ci} align={align(ci)} className="text-body-13 text-ink-2">
                  {kids(cell, tone)}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
