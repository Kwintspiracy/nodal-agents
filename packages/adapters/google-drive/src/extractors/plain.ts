// @nodalai/adapter-google-drive — plain text extractor

/**
 * Decode a Buffer as UTF-8 text. Used for text/*, JSON, CSV, and unknown
 * formats that appear to be text.
 */
export function extractPlainText(buffer: Buffer): string {
  return buffer.toString('utf-8');
}
