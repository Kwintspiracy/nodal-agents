// @nodal-agents/adapter-gmail — RFC 2822 message builder (base64url encoded)
//
// Builds raw RFC 2822 email messages suitable for Gmail API's `raw` field.
// Handles:
//   - Non-ASCII subjects (RFC 2047 encoded-word via base64)
//   - Plain text and HTML bodies
//   - File attachments (text content or pre-encoded base64 binary)
//   - Reply threading headers (In-Reply-To, References)
//
// No external dependencies — pure Node.js built-ins.

export interface AttachmentSpec {
  /** File name displayed in email, e.g. 'report.html' */
  filename: string;
  /** File content — plain string (text encoding) or base64 string (base64 encoding) */
  content: string;
  /** MIME type, e.g. 'text/html'. Inferred from filename if omitted. */
  mimeType?: string;
  /** How `content` is encoded: 'text' (default) or 'base64' */
  encoding?: 'text' | 'base64';
}

export interface Rfc2822Options {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: AttachmentSpec[];
}

// MIME type overrides — host-OS independent (Windows registry returns
// non-standard types for common extensions).
const MIME_OVERRIDES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

function inferMimeType(filename: string): string {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop()!.toLowerCase() : '';
  return MIME_OVERRIDES[ext] ?? 'application/octet-stream';
}

/**
 * Encode a header value for RFC 2047 if it contains non-ASCII characters.
 * Uses base64 encoded-word format: =?utf-8?B?...?=
 */
function encodeHeader(value: string): string {
  // Check if any character is outside ASCII range
  const hasNonAscii = [...value].some((ch) => ch.charCodeAt(0) > 127);
  if (!hasNonAscii) return value;
  const encoded = Buffer.from(value, 'utf-8').toString('base64');
  return `=?utf-8?B?${encoded}?=`;
}

/**
 * Generate a boundary string for multipart messages.
 */
function makeBoundary(): string {
  return `nodalai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Build a base64url-encoded RFC 2822 message.
 * Returns the encoded string ready to be used as Gmail API `raw` field.
 */
export function buildRfc2822Message(opts: Rfc2822Options): string {
  const { to, subject, body, from, cc, bcc, replyTo, inReplyTo, references, attachments } = opts;

  const hasAttachments = attachments && attachments.length > 0;
  const isHtml = body.includes('<') && body.includes('>') && /<[a-zA-Z][^>]*>/.test(body);

  let rawMessage: string;

  if (!hasAttachments) {
    // Simple single-part message
    const contentType = isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    const bodyBase64 = Buffer.from(body, 'utf-8').toString('base64');
    const lines: string[] = [];
    if (from) lines.push(`From: ${from}`);
    lines.push(`To: ${to}`);
    if (cc) lines.push(`Cc: ${cc}`);
    if (bcc) lines.push(`Bcc: ${bcc}`);
    if (replyTo) lines.push(`Reply-To: ${replyTo}`);
    lines.push(`Subject: ${encodeHeader(subject)}`);
    if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
    if (references) lines.push(`References: ${references}`);
    lines.push('MIME-Version: 1.0');
    lines.push(`Content-Type: ${contentType}`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    // RFC 2822 recommends 76-char line wrapping for base64 body
    lines.push(bodyBase64.match(/.{1,76}/g)?.join('\r\n') ?? bodyBase64);
    rawMessage = lines.join('\r\n');
  } else {
    // Multipart/mixed for attachments
    const boundary = makeBoundary();
    const bodyContentType = isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    const bodyBase64 = Buffer.from(body, 'utf-8').toString('base64');

    const headers: string[] = [];
    if (from) headers.push(`From: ${from}`);
    headers.push(`To: ${to}`);
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    if (replyTo) headers.push(`Reply-To: ${replyTo}`);
    headers.push(`Subject: ${encodeHeader(subject)}`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    headers.push('MIME-Version: 1.0');
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts: string[] = [];

    // Body part
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${bodyContentType}`,
        'Content-Transfer-Encoding: base64',
        '',
        bodyBase64.match(/.{1,76}/g)?.join('\r\n') ?? bodyBase64,
      ].join('\r\n'),
    );

    // Attachment parts
    for (const att of attachments) {
      const mimeType = att.mimeType ?? inferMimeType(att.filename);
      const encodedFilename = encodeHeader(att.filename);

      let attBytes: Buffer;
      if (att.encoding === 'base64') {
        attBytes = Buffer.from(att.content, 'base64');
      } else {
        attBytes = Buffer.from(att.content, 'utf-8');
      }
      const attBase64 = attBytes.toString('base64');

      parts.push(
        [
          `--${boundary}`,
          `Content-Type: ${mimeType}; name="${encodedFilename}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${encodedFilename}"`,
          '',
          attBase64.match(/.{1,76}/g)?.join('\r\n') ?? attBase64,
        ].join('\r\n'),
      );
    }

    rawMessage = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n') + `\r\n--${boundary}--`;
  }

  // base64url encode (RFC 4648 URL-safe, no padding)
  return Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode a base64url-encoded RFC 2822 message back to raw string.
 * Useful for testing round-trips.
 */
export function decodeRfc2822Message(encoded: string): string {
  // Re-add base64 padding if needed
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  const withPad = padded + '='.repeat(padLength);
  return Buffer.from(withPad, 'base64').toString('utf-8');
}

/**
 * Parse headers from a raw RFC 2822 message string.
 * Returns a map of header name (lowercase) → value.
 */
export function parseRawHeaders(raw: string): Record<string, string> {
  const headerSection = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const result: Record<string, string> = {};

  // Unfold continuation lines (RFC 2822 folding: CRLF followed by whitespace)
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  const lines = unfolded.split(/\r?\n/);

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const name = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      result[name] = value;
    }
  }

  return result;
}
