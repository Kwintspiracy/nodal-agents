// printer/received-text.ts — le texte de ce que l'imprimante du banc a REÇU (#794).
//
// Le juge d'un scénario d'impression cherche ce que la demande contenait dans
// les OCTETS reçus, pas dans les arguments de l'appel : un contenu composé, mais
// aussi un fichier imprimé tel quel (un .txt, une page HTML, un PDF). Ce qu'on
// ne sait pas lire est DIT (`problem`), jamais deviné ni compté pour vide.

import { extname } from 'node:path';
import { readHtml } from '../workflows/office';
import type { PrintRecord } from './record';

export interface ReceivedText {
  readonly text: string | null;
  /** Pourquoi le texte n'a pas pu être lu, quand `text` est null. */
  readonly problem: string | null;
}

const PLAIN_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log']);
const HTML_EXT = new Set(['.html', '.htm']);

function utf8(bytes: Buffer): ReceivedText {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), problem: null };
  } catch {
    return { text: null, problem: 'the received bytes are not valid UTF-8 text' };
  }
}

function html(bytes: Buffer): ReceivedText {
  const decoded = utf8(bytes);
  if (decoded.text === null) return decoded;
  // Le texte VISIBLE (entités décodées, ni balises ni styles), comme l'analyseur
  // du navigateur le lit : `caf&eacute;` est « café ».
  return { text: readHtml(decoded.text)[0]?.text ?? '', problem: null };
}

async function pdf(bytes: Buffer): Promise<ReceivedText> {
  try {
    // Chargé à la demande : pdfjs pèse, et seules les demandes de PDF en ont besoin.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      return { text: (await parser.getText()).text, problem: null };
    } finally {
      await parser.destroy();
    }
  } catch (e) {
    return {
      text: null,
      problem: `the received PDF could not be read as text: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function receivedText(
  source: PrintRecord['source'],
  bytes: Buffer,
): Promise<ReceivedText> {
  if (source.kind === 'content') {
    return source.contentFormat === 'html' ? html(bytes) : utf8(bytes);
  }
  const ext = extname(source.path).toLowerCase();
  if (ext === '.pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-') return pdf(bytes);
  if (HTML_EXT.has(ext)) return html(bytes);
  if (PLAIN_EXT.has(ext)) return utf8(bytes);
  return {
    text: null,
    problem: `the bench does not extract the text of a ${ext || 'extensionless'} file: what it contains cannot be checked`,
  };
}
