// @nodal-agents/adapter-gmail — MIME payload parser
//
// Extracts human-readable text from Gmail message payloads.
// Strategy:
//   1. text/plain preferred
//   2. text/html fallback (HTML tags stripped)
//   3. Recurse into multipart/* parts
// Returns empty string if no text content found.

import type { gmail_v1 } from 'googleapis';

/**
 * Decode a base64url-encoded string to UTF-8 text.
 * Gmail API returns body data as base64url without padding.
 */
export function decodeBase64Url(encoded: string): string {
  if (!encoded) return '';
  // Add padding
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  const withPad = padded + '='.repeat(padLength);
  try {
    return Buffer.from(withPad, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Strip HTML tags from a string, collapsing whitespace.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Decode body data from a Gmail message part.
 */
function decodePartBody(part: gmail_v1.Schema$MessagePart): string {
  const data = part.body?.data;
  if (!data) return '';
  return decodeBase64Url(data);
}

/**
 * Extract plain text from a Gmail message payload.
 * Prefers text/plain; falls back to text/html (tags stripped).
 * Recurses into multipart/* parts.
 */
export function extractTextFromPayload(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  const mime = payload.mimeType ?? '';

  if (mime.startsWith('text/plain')) {
    return decodePartBody(payload);
  }

  if (mime.startsWith('text/html')) {
    return stripHtml(decodePartBody(payload));
  }

  if (mime.startsWith('multipart/')) {
    const parts = payload.parts ?? [];

    // Try text/plain first
    for (const part of parts) {
      if ((part.mimeType ?? '').startsWith('text/plain')) {
        const text = extractTextFromPayload(part);
        if (text.trim()) return text;
      }
    }

    // Try text/html
    for (const part of parts) {
      if ((part.mimeType ?? '').startsWith('text/html')) {
        const text = extractTextFromPayload(part);
        if (text.trim()) return text;
      }
    }

    // Recurse into nested multipart
    for (const part of parts) {
      if ((part.mimeType ?? '').startsWith('multipart/')) {
        const text = extractTextFromPayload(part);
        if (text.trim()) return text;
      }
    }
  }

  return '';
}

export interface MessageAttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Extract attachment metadata (not the binary data) from a Gmail message payload.
 * Returns array of {attachmentId, filename, mimeType, size}.
 */
export function extractAttachmentInfos(
  payload: gmail_v1.Schema$MessagePart | undefined,
  infos: MessageAttachmentInfo[] = [],
): MessageAttachmentInfo[] {
  if (!payload) return infos;

  // A part has an attachment if it has a non-empty attachmentId in body
  const attachmentId = payload.body?.attachmentId;
  if (attachmentId && payload.filename) {
    infos.push({
      attachmentId,
      filename: payload.filename,
      mimeType: payload.mimeType ?? 'application/octet-stream',
      size: payload.body?.size ?? 0,
    });
  }

  for (const part of payload.parts ?? []) {
    extractAttachmentInfos(part, infos);
  }

  return infos;
}

/**
 * Parse the headers list from a Gmail message part into a key→value map.
 * Keys are normalized to lowercase.
 */
export function parseGmailHeaders(
  payload: gmail_v1.Schema$MessagePart | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of payload?.headers ?? []) {
    if (h.name && h.value != null) {
      result[h.name.toLowerCase()] = h.value;
    }
  }
  return result;
}

/** A file a message carries: an attachment, or an inline part such as an image in the body. */
export interface CarriedFileInfo {
  filename: string;
  mimeType: string;
  inline: boolean;
}

/**
 * Every named file part of a message, attachments and inline parts alike, so a
 * forward can say what it carried. A part counts as inline when its
 * Content-Disposition says so, or when it has a Content-ID and no disposition
 * (the form an image referenced by `cid:` in an HTML body takes).
 */
export function extractCarriedFiles(
  payload: gmail_v1.Schema$MessagePart | undefined,
  out: CarriedFileInfo[] = [],
): CarriedFileInfo[] {
  if (!payload) return out;
  if (payload.filename) {
    const headers = parseGmailHeaders(payload);
    const disposition = (headers['content-disposition'] ?? '').trim().toLowerCase();
    const inline =
      disposition.startsWith('inline') ||
      (disposition === '' && headers['content-id'] !== undefined);
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? 'application/octet-stream',
      inline,
    });
  }
  for (const part of payload.parts ?? []) extractCarriedFiles(part, out);
  return out;
}
