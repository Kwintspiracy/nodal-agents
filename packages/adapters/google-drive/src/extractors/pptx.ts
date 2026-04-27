// @nodalai/adapter-google-drive — PPTX extractor
// No clean Node.js PPTX text extraction library exists that is well-maintained
// and handles the full OOXML spec reliably. We return a typed error so the caller
// can surface a clear, actionable message rather than crashing or returning garbage.

import { DriveAdapterError } from '../errors.js';

/**
 * Attempt PPTX text extraction.
 * Currently unsupported — throws a typed DriveAdapterError so callers can handle
 * gracefully. When a suitable Node library becomes available, replace this implementation.
 *
 * @throws DriveAdapterError with code 'drive_pptx_extraction_unsupported'
 */
export function extractPptxText(_buffer: Buffer): never {
  throw new DriveAdapterError(
    'drive_pptx_extraction_unsupported',
    'PPTX text extraction is not yet supported. Export the file to Google Slides or PDF first.',
  );
}
