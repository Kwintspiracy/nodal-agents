// @nodal-agents/adapter-google-drive — file text extractor dispatcher

import { DriveAdapterError } from '../errors';
import { extractDocxText } from './docx';
import { extractPdfText } from './pdf';
import { extractXlsxText } from './xlsx';
import { extractPptxText } from './pptx';
import { extractPlainText } from './plain';

/** 25 MB file size cap — refuse extraction above this to avoid OOM */
export const FILE_SIZE_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Dispatch file text extraction based on MIME type and/or filename extension.
 * Enforces a 25 MB cap. Returns extracted plain text.
 *
 * @throws DriveAdapterError with code 'drive_file_too_large' if buffer > 25 MB.
 * @throws DriveAdapterError with code 'drive_pptx_extraction_unsupported' for PPTX.
 */
export async function extractFileText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  if (buffer.byteLength > FILE_SIZE_CAP_BYTES) {
    throw new DriveAdapterError(
      'drive_file_too_large',
      `File exceeds the 25 MB extraction limit (${Math.round(buffer.byteLength / 1024 / 1024)} MB).`,
    );
  }

  const mime = mimeType.toLowerCase();
  const name = filename.toLowerCase();

  // .docx
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    return extractDocxText(buffer);
  }

  // PDF
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    return extractPdfText(buffer);
  }

  // .xlsx
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    name.endsWith('.xlsx')
  ) {
    return extractXlsxText(buffer);
  }

  // .pptx
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    name.endsWith('.pptx')
  ) {
    return extractPptxText(buffer);
  }

  // JSON — pretty-print
  if (mime === 'application/json' || name.endsWith('.json')) {
    try {
      const text = buffer.toString('utf-8');
      const parsed: unknown = JSON.parse(text);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return extractPlainText(buffer);
    }
  }

  // Plain text variants (text/*, CSV, XML, JS, TS)
  if (
    mime.startsWith('text/') ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/typescript'
  ) {
    return extractPlainText(buffer);
  }

  // Fallback: attempt UTF-8 decode — if it works, it's probably text
  try {
    // Validate first 1000 bytes — fast check for binary
    const probe = buffer.slice(0, 1000).toString('utf-8');
    // If there are too many replacement characters, it's binary
    const replacements = (probe.match(/�/g) ?? []).length;
    if (replacements > 20) {
      throw new DriveAdapterError(
        'drive_unknown',
        `Binary file format (${mimeType || 'unknown'}) — cannot extract text.`,
      );
    }
    return extractPlainText(buffer);
  } catch (err) {
    if (err instanceof DriveAdapterError) throw err;
    throw new DriveAdapterError(
      'drive_unknown',
      `Binary file format (${mimeType || 'unknown'}) — cannot extract text.`,
    );
  }
}
