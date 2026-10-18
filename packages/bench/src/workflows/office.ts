// workflows/office.ts — lire un livrable de bureau comme on lirait un vrai fichier.
//
// Un juge ne croit jamais qu'un document « contient » quelque chose parce que
// le modèle le dit : il OUVRE le fichier. Les lectures passent par les
// bibliothèques que le produit utilise lui-même (mammoth pour le texte d'un
// Word, pdf-parse pour un PDF, exceljs pour un classeur dans disk.ts) ; la
// structure (styles de titres, tableaux, ordre des diapositives) est lue dans
// le XML OOXML lui-même, que ces bibliothèques ne rendent pas.
//
// Tout ce qui lève ici (fichier corrompu, pas un zip) remonte au juge, qui le
// dit en une raison de rouge : un livrable illisible n'est jamais « vide ».

import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { imageSize } from 'image-size';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { CellValue, SheetGrid } from './disk';

// ─── XML ─────────────────────────────────────────────────────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Le texte d'un fragment OOXML : ses runs `<x:t>`, tabulations et sauts de ligne compris. */
function runText(xml: string, ns: 'w' | 'a'): string {
  const re = new RegExp(
    `<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:tab\\s*/>|<${ns}:br\\s*/>`,
    'g',
  );
  let out = '';
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else out += m[0].includes(':tab') ? '\t' : '\n';
  }
  return out;
}

async function zipText(buf: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file(path);
  if (!f) throw new Error(`not an Office file: ${path} is missing`);
  return f.async('string');
}

// ─── Word ────────────────────────────────────────────────────────────────────

export interface DocxParagraph {
  /** L'identifiant du style (`Heading1`, `Titre1`, `Title`…), null sans style. */
  readonly style: string | null;
  /** Niveau de plan explicite (`w:outlineLvl`), null sans. */
  readonly outline: number | null;
  /** Un élément de liste (numérotée ou à puces). */
  readonly listItem: boolean;
  readonly text: string;
}

export interface DocxView {
  /** Le texte brut, tel que mammoth (l'outil `docx_read` du produit) le rend. */
  readonly text: string;
  /** Les paragraphes du corps, dans l'ordre, HORS tableaux. */
  readonly paragraphs: DocxParagraph[];
  /** Chaque tableau : ses lignes, chaque ligne ses cellules (texte). */
  readonly tables: string[][][];
}

function docxParagraph(xml: string): DocxParagraph {
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(xml)?.[1] ?? null;
  const outline = /<w:outlineLvl\s+w:val="(\d+)"/.exec(xml)?.[1];
  return {
    style,
    outline: outline === undefined ? null : Number(outline),
    listItem: /<w:numPr\b/.test(xml),
    text: runText(xml, 'w'),
  };
}

/** Un titre : un style de titre (anglais ou français), ou un niveau de plan. */
export function isHeading(p: DocxParagraph): boolean {
  return p.outline !== null || /^(heading|titre|title)\s*\d*$/i.test(p.style ?? '');
}

export async function readDocx(path: string): Promise<DocxView> {
  const buf = readFileSync(path);
  const xml = await zipText(buf, 'word/document.xml');
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? '';
  const paragraphs: DocxParagraph[] = [];
  const tables: string[][][] = [];
  // Un tableau d'abord (ses paragraphes lui appartiennent), sinon un paragraphe.
  for (const m of body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p(?=[\s>])[\s\S]*?<\/w:p>/g)) {
    const block = m[0];
    if (block.startsWith('<w:tbl')) {
      const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) =>
          [...c[0].matchAll(/<w:p(?=[\s>])[\s\S]*?<\/w:p>/g)]
            .map((p) => runText(p[0], 'w'))
            .join('\n')
            .trim(),
        ),
      );
      tables.push(rows);
    } else paragraphs.push(docxParagraph(block));
  }
  const text = (await mammoth.extractRawText({ buffer: buf })).value;
  return { text, paragraphs, tables };
}

// ─── PowerPoint ──────────────────────────────────────────────────────────────

export interface PptxSlide {
  /** Les paragraphes non vides de la diapositive, dans l'ordre du XML. */
  readonly paragraphs: string[];
}

/**
 * Les diapositives dans l'ordre de la PRÉSENTATION (`p:sldIdLst`), pas dans
 * l'ordre des fichiers : une diapositive ajoutée puis déplacée garde son nom
 * de fichier.
 */
export async function readPptx(path: string): Promise<PptxSlide[]> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const read = async (p: string): Promise<string> => {
    const f = zip.file(p);
    if (!f) throw new Error(`not a PowerPoint file: ${p} is missing`);
    return f.async('string');
  };
  const pres = await read('ppt/presentation.xml');
  const rels = await read('ppt/_rels/presentation.xml.rels');
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t.replace(/^\/?ppt\//, ''));
  }
  const slides: PptxSlide[] = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const t = rid ? target.get(rid) : undefined;
    if (!t) throw new Error(`the presentation lists a slide (${rid ?? '?'}) with no file`);
    const xml = await read(`ppt/${t}`);
    const paragraphs = [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p\s[\s\S]*?<\/a:p>/g)]
      .map((p) => runText(p[0], 'a').trim())
      .filter((x) => x !== '');
    slides.push({ paragraphs });
  }
  return slides;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

export interface PdfView {
  readonly pages: number;
  /** Le texte de chaque page, dans l'ordre. */
  readonly pageTexts: string[];
  readonly text: string;
}

/** Lit un PDF avec pdf-parse (la bibliothèque de l'extracteur PDF du produit). */
export async function readPdf(path: string): Promise<PdfView> {
  const parser = new PDFParse({ data: readFileSync(path) });
  try {
    const r = await parser.getText();
    return { pages: r.total, pageTexts: r.pages.map((p) => p.text), text: r.text };
  } finally {
    await parser.destroy();
  }
}

// ─── Images ──────────────────────────────────────────────────────────────────

export interface ImageView {
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

/** Le format et les dimensions lus dans l'en-tête du fichier, pas dans son nom. */
export function readImage(path: string): ImageView {
  const r = imageSize(readFileSync(path));
  if (!r.type || !r.width || !r.height) throw new Error('not an image the bench can read');
  return { type: r.type, width: r.width, height: r.height };
}

// ─── HTML ────────────────────────────────────────────────────────────────────

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface HtmlElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  /** Le texte de l'élément et de ses descendants, blancs normalisés. */
  readonly text: string;
  /** Les éléments ancêtres, du plus proche au plus lointain. */
  readonly ancestors: string[];
  /** Les enfants éléments, dans l'ordre. */
  readonly children: HtmlElement[];
}

export const normalizeSpace = (s: string): string => s.replace(/\s+/g, ' ').trim();

function isElement(n: Node): n is Element {
  return 'tagName' in n;
}

function textOf(n: Node): string {
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value;
  if (isElement(n) && (n.tagName === 'script' || n.tagName === 'style')) return '';
  const kids = 'childNodes' in n ? (n.childNodes as Node[]) : [];
  // Le contenu d'un <template> vit hors de l'arbre : il n'est pas affiché.
  return kids.map(textOf).join(' ');
}

/**
 * Parse une page HTML avec parse5 (l'analyseur du navigateur, celui du runner)
 * et rend la liste PLATE de ses éléments, dans l'ordre du document.
 */
export function readHtml(source: string): HtmlElement[] {
  const doc = parse(source);
  const out: HtmlElement[] = [];
  const walk = (n: Node, ancestors: string[]): HtmlElement | null => {
    if (!isElement(n)) {
      if ('childNodes' in n) for (const c of n.childNodes as Node[]) walk(c, ancestors);
      return null;
    }
    const attrs: Record<string, string> = {};
    for (const a of n.attrs) attrs[a.name.toLowerCase()] = a.value;
    const children: HtmlElement[] = [];
    const el: HtmlElement = {
      tag: n.tagName.toLowerCase(),
      attrs,
      text: normalizeSpace(textOf(n)),
      ancestors,
      children,
    };
    out.push(el);
    for (const c of n.childNodes as Node[]) {
      const k = walk(c, [el.tag, ...ancestors]);
      if (k) children.push(k);
    }
    return el;
  };
  walk(doc, []);
  return out;
}

// ─── Formules d'un classeur ──────────────────────────────────────────────────

/**
 * La valeur d'une cellule telle qu'Excel l'afficherait : un nombre, un texte,
 * ou le résultat d'une formule. Une formule SANS résultat en cache (exceljs,
 * openpyxl n'en écrivent pas) est CALCULÉE ici : quatre opérations, parenthèses,
 * références (`B2`, `Notes!B2`, `'Ma feuille'!B2`), plages, et SUM, AVERAGE,
 * MIN, MAX, ROUND, PRODUCT. Une formule hors de cet ensemble rend une erreur
 * dite, jamais un nombre deviné.
 */
export type Evaluated = { ok: true; value: number | string } | { ok: false; why: string };

const MAX_DEPTH = 50;

export function evaluateCell(
  sheets: readonly SheetGrid[],
  sheetName: string,
  address: string,
  depth = 0,
): Evaluated {
  const sheet = sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase());
  if (!sheet) return { ok: false, why: `no sheet "${sheetName}"` };
  const cell: CellValue | undefined = sheet.cells[address.toUpperCase()];
  if (!cell) return { ok: false, why: `${sheetName}!${address} is empty` };
  if (cell.kind === 'number') return { ok: true, value: cell.value };
  if (cell.kind === 'text') return { ok: true, value: cell.value };
  if (cell.kind === 'other')
    return { ok: false, why: `${sheetName}!${address} holds ${cell.value}` };
  if (typeof cell.result === 'number' || typeof cell.result === 'string')
    return { ok: true, value: cell.result };
  if (depth > MAX_DEPTH) return { ok: false, why: 'formula references loop' };
  try {
    return { ok: true, value: new Formula(cell.formula, sheets, sheet.name, depth).run() };
  } catch (e) {
    return { ok: false, why: `=${cell.formula}: ${String(e instanceof Error ? e.message : e)}` };
  }
}

function colIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function colName(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

class Formula {
  private i = 0;
  private readonly src: string;
  constructor(
    formula: string,
    private readonly sheets: readonly SheetGrid[],
    private readonly sheet: string,
    private readonly depth: number,
  ) {
    this.src = formula.replace(/^=/, '');
  }

  run(): number {
    const v = this.expr();
    this.ws();
    if (this.i < this.src.length) throw new Error(`cannot read "${this.src.slice(this.i)}"`);
    return v;
  }

  private ws(): void {
    while (this.src[this.i] === ' ') this.i++;
  }
  private expr(): number {
    let v = this.term();
    for (;;) {
      this.ws();
      const c = this.src[this.i];
      if (c !== '+' && c !== '-') return v;
      this.i++;
      const r = this.term();
      v = c === '+' ? v + r : v - r;
    }
  }
  private term(): number {
    let v = this.factor();
    for (;;) {
      this.ws();
      const c = this.src[this.i];
      if (c !== '*' && c !== '/') return v;
      this.i++;
      const r = this.factor();
      v = c === '*' ? v * r : v / r;
    }
  }
  private factor(): number {
    this.ws();
    const c = this.src[this.i];
    if (c === '-') {
      this.i++;
      return -this.factor();
    }
    if (c === '(') {
      this.i++;
      const v = this.expr();
      this.ws();
      if (this.src[this.i] !== ')') throw new Error('missing )');
      this.i++;
      return v;
    }
    const num = /^\d+(?:\.\d+)?/.exec(this.src.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    const fn = /^([A-Z]+)\(/i.exec(this.src.slice(this.i));
    if (fn) {
      this.i += fn[0].length;
      const args: number[][] = [];
      for (;;) {
        this.ws();
        if (this.src[this.i] === ')') break;
        args.push(this.argument());
        this.ws();
        if (this.src[this.i] === ',' || this.src[this.i] === ';') this.i++;
        else if (this.src[this.i] !== ')') throw new Error('missing ) after arguments');
      }
      this.i++;
      return this.call(fn[1]!.toUpperCase(), args);
    }
    const values = this.reference();
    if (values.length !== 1) throw new Error('a range outside a function');
    return values[0]!;
  }
  /** Un argument : une plage ou une expression. */
  private argument(): number[] {
    const save = this.i;
    try {
      const r = this.reference();
      this.ws();
      const next = this.src[this.i];
      if (next === ',' || next === ';' || next === ')') return r;
    } catch {
      /* pas une référence : une expression */
    }
    this.i = save;
    return [this.expr()];
  }
  private reference(): number[] {
    const m =
      /^(?:(?:'([^']+)'|([A-Za-z0-9_À-ÿ]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/i.exec(
        this.src.slice(this.i),
      );
    if (!m) throw new Error(`cannot read "${this.src.slice(this.i)}"`);
    this.i += m[0].length;
    const sheet = m[1] ?? m[2] ?? this.sheet;
    const c1 = colIndex(m[3]!);
    const r1 = Number(m[4]);
    const c2 = m[5] ? colIndex(m[5]) : c1;
    const r2 = m[6] ? Number(m[6]) : r1;
    const out: number[] = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        const addr = `${colName(c)}${r}`;
        const v = evaluateCell(this.sheets, sheet, addr, this.depth + 1);
        const single = r1 === r2 && c1 === c2;
        if (!v.ok) {
          // Une cellule vide dans une plage ne compte pas (comme Excel) ; seule, c'est une erreur.
          if (!single && /is empty$/.test(v.why)) continue;
          throw new Error(v.why);
        }
        if (typeof v.value !== 'number') {
          if (single) throw new Error(`${sheet}!${addr} is text, not a number`);
          continue;
        }
        out.push(v.value);
      }
    }
    return out;
  }
  private call(name: string, args: number[][]): number {
    const all = args.flat();
    switch (name) {
      case 'SUM':
        return all.reduce((a, b) => a + b, 0);
      case 'PRODUCT':
        return all.reduce((a, b) => a * b, 1);
      case 'AVERAGE':
        if (all.length === 0) throw new Error('AVERAGE of nothing');
        return all.reduce((a, b) => a + b, 0) / all.length;
      case 'MIN':
        return Math.min(...all);
      case 'MAX':
        return Math.max(...all);
      case 'ROUND': {
        const [x, d] = [args[0]?.[0], args[1]?.[0] ?? 0];
        if (x === undefined) throw new Error('ROUND of nothing');
        const f = 10 ** d;
        return Math.round(x * f) / f;
      }
      default:
        throw new Error(`the function ${name} is not one the bench computes`);
    }
  }
}
