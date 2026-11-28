// @nodal-agents/adapter-gmail — MIME message builder for Gmail's `raw` field
//
// Gmail's API has no send/reply/forward verbs of its own: it takes an RFC 5322
// message, built by the client, in `raw` (base64url). This module builds that
// message with nodemailer's MailComposer — a maintained MIME implementation
// (header encoding of non-ASCII names and subjects, address lists, transfer
// encodings, multipart structure, message/rfc822 parts) — instead of the
// string concatenation the adapter used before (#1191).
//
// The body's type is DECLARED by the caller (`bodyFormat`), never guessed from
// its characters: a text body goes out as one text/plain part, byte for byte.

import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import type { MailAddress, MailBodyFormat } from '@nodal-agents/shared/mail-contract';
import { GmailAdapterError } from '../errors';

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

/** One attached part, as bytes. */
export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /**
   * Content-Transfer-Encoding to declare instead of letting the composer pick
   * one. An encapsulated message (message/rfc822) may only be 7bit, 8bit or
   * binary (RFC 2046 §5.2.1), and is carried as its stored bytes.
   */
  transferEncoding?: '8bit';
}

export interface BuildMimeOptions {
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress[];
  subject: string;
  body: string;
  bodyFormat: MailBodyFormat;
  /** Message-ID of the message answered (threading, RFC 5322 §3.6.4). */
  inReplyTo?: string;
  /** References chain, oldest first. */
  references?: string[];
  attachments?: MimeAttachment[];
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
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.eml': 'message/rfc822',
};

export function inferMimeType(filename: string): string {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop()!.toLowerCase() : '';
  return MIME_OVERRIDES[ext] ?? 'application/octet-stream';
}

/**
 * audit#2026-07-07 F11: reject a header-bound value that contains CR or LF.
 * A header value with an embedded line break is always a bug, never
 * legitimate input: fail loud (invariant #4) instead of stripping it.
 */
export function assertNoHeaderInjection(fieldName: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new GmailAdapterError(
      'gmail_validation_error',
      `'${fieldName}' contains a line break (CR/LF), which is not allowed in an email header.`,
    );
  }
}

/** The tool's attachment specs, as bytes with a MIME type. */
export function attachmentSpecsToMime(specs: AttachmentSpec[] | undefined): MimeAttachment[] {
  return (specs ?? []).map((spec) => ({
    filename: spec.filename,
    contentType: spec.mimeType ?? inferMimeType(spec.filename),
    content:
      spec.encoding === 'base64'
        ? Buffer.from(spec.content, 'base64')
        : Buffer.from(spec.content, 'utf-8'),
  }));
}

function toNodemailerAddresses(list: MailAddress[] | undefined): Mail.Address[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((a) => ({ name: a.name ?? '', address: a.address }));
}

function addressesForHeaderCheck(list: MailAddress[] | undefined): string[] {
  return (list ?? []).flatMap((a) => [a.address, a.name ?? '']);
}

/**
 * Build the RFC 5322 message, as bytes.
 *
 * The Bcc header is KEPT in the built message: Gmail's `messages.send` "sends
 * the specified message to the recipients in the To, Cc, and Bcc headers"
 * (users.messages/send reference) and removes the header itself.
 */
export async function buildMimeMessage(opts: BuildMimeOptions): Promise<Buffer> {
  assertNoHeaderInjection('subject', opts.subject);
  for (const [field, list] of [
    ['to', opts.to],
    ['cc', opts.cc],
    ['bcc', opts.bcc],
    ['replyTo', opts.replyTo],
  ] as const) {
    for (const v of addressesForHeaderCheck(list)) assertNoHeaderInjection(field, v);
  }
  if (opts.inReplyTo) assertNoHeaderInjection('inReplyTo', opts.inReplyTo);
  for (const r of opts.references ?? []) assertNoHeaderInjection('references', r);
  for (const att of opts.attachments ?? []) {
    assertNoHeaderInjection('attachment.filename', att.filename);
  }

  const mail: Mail.Options = {
    to: toNodemailerAddresses(opts.to),
    cc: toNodemailerAddresses(opts.cc),
    bcc: toNodemailerAddresses(opts.bcc),
    replyTo: toNodemailerAddresses(opts.replyTo),
    subject: opts.subject,
    // Exactly one body part, of the declared type. As a Buffer, so that an
    // empty body (a forward without a note) is still a part of that type
    // rather than dropped by the composer.
    ...(opts.bodyFormat === 'html'
      ? { html: Buffer.from(opts.body, 'utf-8') }
      : { text: Buffer.from(opts.body, 'utf-8') }),
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
    ...(opts.references && opts.references.length > 0 ? { references: opts.references } : {}),
    attachments: (opts.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      // Every file this module attaches is an attachment, never shown inline.
      contentDisposition: 'attachment' as const,
      ...(a.transferEncoding ? { contentTransferEncoding: a.transferEncoding } : {}),
    })),
  };

  const node = new MailComposer(mail).compile();
  node.keepBcc = true;
  return node.build();
}

/** base64url (RFC 4648 §5, no padding): the encoding of Gmail's `raw` field. */
export function toGmailRaw(message: Buffer): string {
  return message.toString('base64url');
}
