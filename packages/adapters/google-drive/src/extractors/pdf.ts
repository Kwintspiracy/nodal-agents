// @nodalai/adapter-google-drive — PDF extractor using pdf-parse

import { PDFParse } from 'pdf-parse';

/**
 * Extract text from a PDF buffer using pdf-parse.
 * Returns the extracted text content.
 * Scanned/image-only PDFs will return empty string.
 *
 * pdf-parse v2 exposes a `PDFParse` class instead of a default function.
 * Buffer extends Uint8Array, so it satisfies the `data` field's TypedArray type.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}
