// @nodalai/adapter-google-drive — PDF extractor using pdf-parse

import pdfParse from 'pdf-parse';

/**
 * Extract text from a PDF buffer using pdf-parse.
 * Returns the extracted text content.
 * Scanned/image-only PDFs will return empty string.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return data.text;
}
