// @nodalai/adapter-google-drive — DOCX extractor using mammoth

import mammoth from 'mammoth';

/**
 * Extract plain text from a .docx buffer using mammoth.
 * Extracts paragraph text and table cells. Strips HTML tags.
 *
 * @throws Does not throw — returns empty string on empty documents.
 */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
