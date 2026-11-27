// file-ops/text-file.ts — LA couche texte de tous les outils de fichiers.
//
// Un outil de fichier ne lit plus d'octets « comme de l'UTF-8 » et n'écrit
// plus d'UTF-8 « parce que c'est ce qu'il sait faire ». Il passe ici, qui :
//
//  1. CONSTATE LA FORME du fichier : son encodage, sa marque d'ordre des octets
//     (BOM), ses fins de ligne (`TextForm`) ;
//  2. REND DU TEXTE à l'outil, seulement quand ce texte, réencodé, redonne le
//     fichier OCTET POUR OCTET (`decodeText`) — sinon rien n'est rendu, et la
//     raison est dite ;
//  3. RÉÉCRIT DANS LA MÊME FORME (`encodeText`), et refuse un caractère que
//     l'encodage du fichier ne sait pas porter au lieu de le remplacer par « ? ».
//
// Ce qui n'est pas du texte est refusé comme texte, jugé sur son CONTENU (un
// octet NUL, ou un encodage qu'on ne peut pas établir), jamais sur ses deux
// premiers octets ; le refus dit ce que c'est et quel outil le lit.
//
// LES OUTILS. Le décodage est celui de la plateforme (`TextDecoder`, l'ICU de
// Node, en mode `fatal` : une séquence invalide lève au lieu de devenir U+FFFD).
// L'encodage est `iconv-lite`, la bibliothèque d'encodage de l'écosystème Node.
// La détection d'un encodage sans BOM qui n'est pas de l'UTF-8 valide est
// `chardet`, le détecteur d'ICU porté en JavaScript. Aucune table de
// caractères n'est écrite ici (invariant #7, dans l'esprit).
//
// LES LIMITES, assumées et dites (invariant #4) :
//  - un encodage 8 bits sans BOM (windows-1252, windows-1251, …) se DEVINE :
//    sous `MIN_DETECTION_CONFIDENCE`, la couche refuse et demande l'encodage
//    (`encoding`) plutôt que de deviner ; au-dessus, une erreur de devinette
//    entre deux pages de code laisse les octets intacts (le décodage est
//    bijectif, la vérification aller-retour le prouve), seuls les caractères
//    montrés ou insérés en dépendent ;
//  - l'UTF-16 SANS BOM n'est pas reconnu (ses octets NUL le font refuser comme
//    binaire), sauf si l'encodage est donné ;
//  - l'UTF-32 n'est pas pris en charge (le décodeur de la plateforme ne le
//    connaît pas) ; un encodage à états (ISO-2022-JP) non plus : la
//    vérification aller-retour les refuse.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { analyse } from 'chardet';
import iconv from 'iconv-lite';
import JSZip from 'jszip';
import {
  formatBytes,
  isPdf,
  sniffAttachmentMediaType,
  sniffImageMediaType,
} from '../../model-images';
import type { ToolContext } from '../../types';
import { lastContentSeenByJob } from '../../verification/tool-call-reads';

export type LineEndings = 'lf' | 'crlf' | 'mixed' | 'none';

const NUL = String.fromCharCode(0);

/** Comment un fichier texte est écrit. */
export interface TextForm {
  /** Le nom canonique WHATWG de l'encodage (`new TextDecoder(x).encoding`). */
  readonly encoding: string;
  /** Le fichier commence-t-il par une marque d'ordre des octets ? */
  readonly bom: boolean;
  /**
   * Ses fins de ligne. `lf` / `crlf` : un texte réécrit y est ramené ;
   * `mixed` / `none` : il est écrit tel qu'il est donné.
   */
  readonly lineEndings: LineEndings;
}

/**
 * La forme d'un fichier NOUVEAU : UTF-8 sans BOM, et les fins de ligne telles
 * que l'outil les donne (`none` : rien n'est converti) — comme avant cette
 * couche.
 */
export const NEW_FILE_FORM: TextForm = { encoding: 'utf-8', bom: false, lineEndings: 'none' };

/**
 * Un encodage DEVINÉ n'est retenu que s'il est sûr, ce qui veut dire trois
 * choses à la fois :
 *  - sa confiance (0-100, celle de `chardet`) est au moins celle-ci ;
 *  - elle vaut au moins `MIN_DETECTION_LEAD` fois celle du suivant (un autre
 *    encodage) : deux pages de code presque aussi probables, c'est ne pas savoir ;
 *  - le texte qu'il donne ne porte aucun caractère de contrôle qu'un texte
 *    n'écrit pas (C0 hors tabulation, fins de ligne, saut de page et échappement ;
 *    C1) : c'est ce qui sépare un bruit d'octets d'un texte.
 * Mesuré le 2026-11-27 sur `chardet` 2.2 : quatre lignes de CSV français en
 * windows-1252 donnent 32 contre 16, du russe en windows-1251 37 contre 15, du
 * Shift-JIS et du GB18030 100 ; une seule ligne française donne windows-1257 à
 * 25 (faux) et est refusée ; un bruit d'octets donne windows-1254 à 60 et est
 * refusé par ses caractères de contrôle.
 */
export const MIN_DETECTION_CONFIDENCE = 30;
export const MIN_DETECTION_LEAD = 1.5;

/** Les caractères de contrôle qu'un texte n'écrit pas (C0 sauf \t \n \v \f \r ESC, DEL, C1). */
const NOT_TEXT_CONTROLS = /[\u0000-\u0008\u000e-\u001a\u001c-\u001f\u007f-\u009f]/;

const BOMS: ReadonlyArray<{ readonly encoding: string; readonly bytes: readonly number[] }> = [
  { encoding: 'utf-8', bytes: [0xef, 0xbb, 0xbf] },
  { encoding: 'utf-16le', bytes: [0xff, 0xfe] },
  { encoding: 'utf-16be', bytes: [0xfe, 0xff] },
];

const bomOf = (encoding: string): Buffer => {
  const b = BOMS.find((x) => x.encoding === encoding);
  return Buffer.from(b?.bytes ?? []);
};

function detectBom(bytes: Uint8Array): { encoding: string; length: number } | null {
  for (const b of BOMS) {
    if (b.bytes.every((v, i) => bytes[i] === v))
      return { encoding: b.encoding, length: b.bytes.length };
  }
  return null;
}

/**
 * Le nom canonique d'un encodage nommé par un modèle ou un détecteur, ou
 * `null` quand la plateforme ne le connaît pas ou que la couche ne sait pas
 * l'écrire (`iconv-lite`).
 */
export function canonicalEncoding(label: string): string | null {
  let name: string;
  try {
    name = new TextDecoder(label.trim()).encoding;
  } catch {
    return null;
  }
  // 'replacement' est l'étiquette WHATWG des encodages dangereux (ISO-2022-KR,
  // HZ…) : ce n'est pas un encodage, c'est un refus.
  if (name === 'replacement' || !iconv.encodingExists(name)) return null;
  return name;
}

/** Ce que la couche répond à « donne-moi ce fichier comme texte ». */
export type DecodedText =
  | { readonly ok: true; readonly text: string; readonly form: TextForm }
  | {
      readonly ok: false;
      /**
       * `binary` : ce n'est pas du texte. `undetermined` : l'encodage ne peut
       * pas être établi avec confiance. `invalid` : les octets ne sont pas
       * valides dans l'encodage établi ou donné. `unknown_encoding` : le nom
       * donné n'est pas un encodage connu.
       */
      readonly kind: 'binary' | 'undetermined' | 'invalid' | 'unknown_encoding';
      /** Ce qu'il en est, en une phrase sans le chemin (l'outil le préfixe). */
      readonly detail: string;
    };

/** Le refus d'un contenu qui n'est pas du texte, sans le chemin. */
function binary(detail: string): DecodedText {
  return { ok: false, kind: 'binary', detail };
}

/** Les fins de ligne d'un texte décodé. Un `\r` seul n'est pas une fin de ligne. */
export function detectLineEndings(text: string): LineEndings {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

/**
 * `text` ramené aux fins de ligne `eol`. `lf` et `crlf` convertissent toutes
 * les fins de ligne ; `mixed` et `none` laissent le texte tel qu'il est.
 */
export function withLineEndings(text: string, eol: LineEndings): string {
  if (eol === 'lf') return text.replace(/\r\n/g, '\n');
  if (eol === 'crlf') return text.replace(/\r?\n/g, '\r\n');
  return text;
}

/** L'encodage d'un échantillon sans BOM, établi ou refusé. */
type Established =
  | { readonly ok: true; readonly encoding: string; readonly bomLength: number }
  | Extract<DecodedText, { ok: false }>;

/**
 * Établit l'encodage de `sample` : la BOM s'il y en a une, sinon l'encodage
 * donné, sinon l'UTF-8 quand les octets en sont, sinon la meilleure
 * proposition de `chardet` au-dessus du seuil — et rien d'autre.
 *
 * `complete` : `sample` est-il le fichier entier ? Un début de fichier peut
 * couper un caractère multi-octets en son milieu : la validité UTF-8 d'un
 * début se juge en flux.
 */
export function establishEncoding(
  sample: Uint8Array,
  complete: boolean,
  declared?: string,
): Established {
  // Un fichier dont la signature déclare un format qui n'est pas du texte (une
  // image, un PDF : la même règle que `file_read`, `sniffAttachmentMediaType`)
  // est ce format. Sans cela, un petit PDF sans octet NUL se « devinait » en
  // page de code et se réécrivait comme du texte.
  if (sniffAttachmentMediaType(sample.subarray(0, 32)) !== null) {
    return { ok: false, kind: 'binary', detail: 'its signature declares another format' };
  }
  const bom = detectBom(sample);
  if (declared !== undefined) {
    const name = canonicalEncoding(declared);
    if (name === null) {
      return {
        ok: false,
        kind: 'unknown_encoding',
        detail:
          `"${declared}" is not an encoding this tool can read and write ` +
          '(examples: "utf-8", "utf-16le", "windows-1252", "shift_jis", "gbk")',
      };
    }
    if (bom !== null && bom.encoding !== name) {
      return {
        ok: false,
        kind: 'invalid',
        detail: `it starts with a ${bom.encoding} byte-order mark, so it is not ${name}`,
      };
    }
    return { ok: true, encoding: name, bomLength: bom?.length ?? 0 };
  }
  if (bom !== null) return { ok: true, encoding: bom.encoding, bomLength: bom.length };
  if (sample.includes(0)) {
    return { ok: false, kind: 'binary', detail: 'it contains NUL bytes' };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: !complete });
    return { ok: true, encoding: 'utf-8', bomLength: 0 };
  } catch {
    // Pas de l'UTF-8 : un encodage hérité, à établir par le détecteur.
  }
  // Les propositions du détecteur qui donnent un texte : un nom que la couche
  // sait lire et écrire, des octets valides dans cet encodage, aucun caractère
  // de contrôle qu'un texte n'écrit pas. Un même encodage sous deux noms
  // (ISO-8859-1 et windows-1252 pour la plateforme) ne compte qu'une fois.
  const candidates = analyse(sample);
  const best = candidates[0];
  const readable: Array<{ name: string; confidence: number }> = [];
  for (const c of candidates) {
    const name = canonicalEncoding(c.name);
    if (name === null || name === 'utf-8' || readable.some((r) => r.name === name)) continue;
    let text: string;
    try {
      text = new TextDecoder(name, { fatal: true }).decode(sample, { stream: !complete });
    } catch {
      continue;
    }
    if (NOT_TEXT_CONTROLS.test(text)) continue;
    readable.push({ name, confidence: c.confidence });
  }
  const [first, second] = readable;
  if (
    first !== undefined &&
    first.confidence >= MIN_DETECTION_CONFIDENCE &&
    first.confidence >= MIN_DETECTION_LEAD * (second?.confidence ?? 0)
  ) {
    return { ok: true, encoding: first.name, bomLength: 0 };
  }
  return {
    ok: false,
    kind: 'undetermined',
    detail:
      'its encoding could not be determined with confidence' +
      (best === undefined ? '' : ` (best guess: ${best.name}, ${best.confidence}%)`),
  };
}

/**
 * Le fichier `bytes` comme texte, avec sa forme — ou le refus, et pourquoi.
 *
 * LA GARANTIE : un `ok: true` veut dire que `encodeText(text, form)` redonne
 * `bytes` à l'octet près. La couche le vérifie avant de répondre ; un fichier
 * pour lequel ce n'est pas vrai n'est pas rendu comme texte.
 */
export function decodeText(bytes: Uint8Array, declared?: string): DecodedText {
  const est = establishEncoding(bytes, true, declared);
  if (!est.ok) return est;
  const body = bytes.subarray(est.bomLength);
  let text: string;
  try {
    text = new TextDecoder(est.encoding, { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { ok: false, kind: 'invalid', detail: `its bytes are not valid ${est.encoding}` };
  }
  if (text.includes(NUL)) return binary('it contains NUL characters');
  const back = iconv.encode(text, est.encoding, { addBOM: false });
  if (!Buffer.from(body.buffer, body.byteOffset, body.byteLength).equals(back)) {
    return {
      ok: false,
      kind: 'invalid',
      detail:
        `read as ${est.encoding}, it does not encode back to the same bytes, ` +
        'so it cannot be read or rewritten as text without changing it',
    };
  }
  return {
    ok: true,
    text,
    form: { encoding: est.encoding, bom: est.bomLength > 0, lineEndings: detectLineEndings(text) },
  };
}

/** Les caractères de `text` que `encoding` ne sait pas porter (au plus 5). */
function unrepresentable(text: string, encoding: string): string[] {
  const out: string[] = [];
  for (const ch of new Set(text)) {
    if (!roundTrips(ch, encoding)) out.push(ch);
    if (out.length >= 5) break;
  }
  return out;
}

function roundTrips(text: string, encoding: string): boolean {
  try {
    return (
      new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
        iconv.encode(text, encoding, { addBOM: false }),
      ) === text
    );
  } catch {
    return false;
  }
}

/**
 * Le texte `text` dans l'encodage de `form`, SANS BOM ni conversion des fins
 * de ligne : le morceau qu'un outil insère au milieu d'un fichier. Refuse un
 * caractère que l'encodage ne porte pas, en le nommant.
 */
export function encodeFragment(
  text: string,
  encoding: string,
): { ok: true; bytes: Buffer } | { ok: false; detail: string } {
  if (!roundTrips(text, encoding)) {
    const chars = unrepresentable(text, encoding)
      .map((c) => JSON.stringify(c))
      .join(', ');
    return { ok: false, detail: `${encoding} cannot represent ${chars || 'this text'}` };
  }
  return { ok: true, bytes: iconv.encode(text, encoding, { addBOM: false }) };
}

/**
 * Le texte entier `text` écrit dans la forme `form` : ses fins de ligne
 * ramenées à celles du fichier, son encodage, sa BOM.
 */
export function encodeText(
  text: string,
  form: TextForm,
): { ok: true; bytes: Buffer } | { ok: false; detail: string } {
  const body = encodeFragment(withLineEndings(text, form.lineEndings), form.encoding);
  if (!body.ok) return body;
  return {
    ok: true,
    bytes: form.bom ? Buffer.concat([bomOf(form.encoding), body.bytes]) : body.bytes,
  };
}

/** La forme d'un fichier dont l'encodage est imposé par l'outil (`encoding`). */
export function formForEncoding(encoding: string, existing: TextForm | null): TextForm {
  // La couche ne reconnaît l'UTF-16 que par sa BOM : elle l'écrit donc avec.
  const bom =
    existing !== null && existing.encoding === encoding
      ? existing.bom
      : encoding === 'utf-16le' || encoding === 'utf-16be';
  return { encoding, bom, lineEndings: existing?.lineEndings ?? 'none' };
}

/** Ce qu'est un contenu qui n'est pas du texte, et quel outil le lit. */
export async function describeNotText(
  bytes: Uint8Array,
  fileSize: number = bytes.length,
): Promise<string> {
  const head = bytes.subarray(0, 32);
  const size = formatBytes(fileSize);
  const image = sniffImageMediaType(head);
  if (image !== null) {
    return `an image (${image}, ${size}); file_read returns it as an image to a model that takes images`;
  }
  if (isPdf(head)) return `a PDF document (${size}); file_read reads it by pages`;
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    const parts = await JSZip.loadAsync(bytes)
      .then((zip) => new Set(Object.keys(zip.files)))
      .catch(() => new Set<string>());
    if (parts.has('word/document.xml')) return `a Word document (${size}); read it with docx_read`;
    if (parts.has('xl/workbook.xml')) return `an Excel workbook (${size}); read it with xlsx_read`;
    if (parts.has('ppt/presentation.xml'))
      return `a PowerPoint presentation (${size}); read it with pptx_read`;
    return `a ZIP archive (${size})`;
  }
  return `binary data (${size})`;
}

/**
 * La phrase qu'un outil rend quand `decoded` est un refus : ce qu'est le
 * fichier, et le geste suivant. `nothing` dit ce qui n'a pas été fait
 * (« Nothing was written. »).
 */
export async function notTextReason(
  displayPath: string,
  bytes: Uint8Array,
  decoded: Extract<DecodedText, { ok: false }>,
  nothing: string,
  fileSize: number = bytes.length,
): Promise<string> {
  if (decoded.kind === 'binary') {
    const what = await describeNotText(bytes, fileSize);
    return `"${displayPath}" is not text (${decoded.detail}): it is ${what}. ${nothing}`;
  }
  if (decoded.kind === 'unknown_encoding') return `${decoded.detail}. ${nothing}`;
  return (
    `"${displayPath}" cannot be used as text: ${decoded.detail}. ${nothing} ` +
    'If you know its encoding, call again with "encoding" set to it (for example "windows-1252" ' +
    'or "shift_jis").'
  );
}

/**
 * LA GARDE DU CONTENU VU. Un remplacement (`file_edit`, `file_write` sur un
 * fichier qui existe) ne s'applique qu'au contenu que CE JOB a vu : si le job
 * a déjà lu ou écrit ce fichier, son contenu actuel (`currentSha256`, les
 * octets que l'outil vient de lire) doit être celui qu'il a vu en dernier
 * (`lastContentSeenByJob`). Sinon l'appel est refusé et dit de relire.
 *
 * Un fichier que le job n'a jamais vu garde la règle d'avant (écrasé, sous la
 * porte du dossier partagé). Hors job (`jobId` absent), il n'y a pas de vue :
 * rien n'est comparé.
 *
 * Rend la raison du refus, ou `null` quand l'appel peut continuer.
 */
export async function changedSinceSeen(
  ctx: ToolContext,
  absPath: string,
  currentSha256: string,
  displayPath: string,
): Promise<string | null> {
  if (!ctx.jobId) return null;
  const seen = await lastContentSeenByJob(ctx.db, ctx.jobId, absPath);
  if (seen === null || seen === currentSha256) return null;
  return (
    `"${displayPath}" changed since this job last read or wrote it. Nothing was written. ` +
    'Read it again with file_read, then make the change on what it holds now.'
  );
}

/** Les octets lus du début d'un fichier pour en établir la forme. */
export const FORM_SAMPLE_BYTES = 64 * 1024;

/**
 * Un fichier qui existe, lu en flux : l'empreinte de TOUS ses octets, et son
 * début (`FORM_SAMPLE_BYTES`) pour en établir la forme. Mémoire bornée quelle
 * que soit sa taille. `null` : il n'existe pas.
 */
export async function readExistingFile(
  path: string,
): Promise<{ sha256: string; head: Buffer; size: number } | null> {
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let kept = 0;
  let size = 0;
  try {
    await new Promise<void>((resolveRead, reject) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
        if (kept < FORM_SAMPLE_BYTES) {
          const part = chunk.subarray(0, FORM_SAMPLE_BYTES - kept);
          head.push(part);
          kept += part.length;
        }
      });
      stream.on('end', () => resolveRead());
      stream.on('error', reject);
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return { sha256: hash.digest('hex'), head: Buffer.concat(head), size };
}

/**
 * La forme d'un fichier établie sur son début `head` (le fichier entier quand
 * `complete`). Pour un outil qui REMPLACE le contenu : il lui faut la forme,
 * pas le texte. Le fichier entier passe par `decodeText` (aller-retour
 * vérifié) ; un début seul est décodé en flux.
 */
export function formOfHead(
  head: Uint8Array,
  complete: boolean,
  declared?: string,
): { ok: true; form: TextForm } | Extract<DecodedText, { ok: false }> {
  if (complete) {
    const decoded = decodeText(head, declared);
    return decoded.ok ? { ok: true, form: decoded.form } : decoded;
  }
  const est = establishEncoding(head, false, declared);
  if (!est.ok) return est;
  let text: string;
  try {
    text = new TextDecoder(est.encoding, { fatal: true, ignoreBOM: true }).decode(
      head.subarray(est.bomLength),
      { stream: true },
    );
  } catch {
    return { ok: false, kind: 'invalid', detail: `its bytes are not valid ${est.encoding}` };
  }
  if (text.includes(NUL)) return binary('it contains NUL characters');
  return {
    ok: true,
    form: { encoding: est.encoding, bom: est.bomLength > 0, lineEndings: detectLineEndings(text) },
  };
}

/** L'encodage tel qu'un résultat le dit au modèle : « utf-8 », « utf-16le+bom ». */
export function encodingLabel(encoding: string, bom: boolean): string {
  return bom ? `${encoding}+bom` : encoding;
}

/** Les `size` premiers octets d'un fichier (moins s'il est plus court). */
export async function readFileHead(path: string, size: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
