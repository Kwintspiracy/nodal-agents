// @nodal-agents/shared/mail-contract — what "send", "reply", "reply to all" and
// "forward" mean, written once for every mail connector (#1191, #1192, #1193).
//
// Each mail adapter (Gmail, Outlook today) implements these operations with its
// provider's own means; the meaning lives here, and the conformance suite in
// @nodal-agents/test-kit (`runMailContractSuite`) holds every adapter to it with
// the same cases and the same assertions.
//
//   - The body's type is DECLARED by the caller (`body_format`), never guessed
//     from its characters: a text body is sent as text, byte for byte.
//   - A reply goes where a mail client sends it: Reply-To before From; a reply
//     to one's own message goes to that message's recipients; reply to all
//     keeps the other participants and removes oneself.
//   - A forward carries the original whole (body and attachments). A provider
//     that cannot carry it makes the tool fail; a reduced copy is never sent.
//   - Every operation returns what was actually done: the recipients used, the
//     thread, the attachments sent.
//
// Exposed as a subpath (`@nodal-agents/shared/mail-contract`), not from the
// package index: it carries an address-list parser, which only mail adapters
// need.

import { z } from 'zod';
import addressparser from 'nodemailer/lib/addressparser';

// ── Body ────────────────────────────────────────────────────────────────────

export const MAIL_BODY_FORMATS = ['text', 'html'] as const;
export type MailBodyFormat = (typeof MAIL_BODY_FORMATS)[number];

/** The `body_format` argument every mail tool that takes a body exposes. */
export const mailBodyFormatSchema = z
  .enum(MAIL_BODY_FORMATS)
  .optional()
  .describe(
    "How the body is written: 'text' (default) sends it as plain text exactly as written; " +
      "'html' sends it as HTML. Never inferred from the body's content.",
  );

/** The declared format, with the contract's default. */
export function resolveMailBodyFormat(format: MailBodyFormat | undefined): MailBodyFormat {
  return format ?? 'text';
}

// ── Addresses ───────────────────────────────────────────────────────────────

export interface MailAddress {
  /** Display name, when the address carried one. */
  name?: string;
  address: string;
}

export class MailAddressError extends Error {
  readonly code = 'mail_invalid_address';
  constructor(message: string) {
    super(message);
    this.name = 'MailAddressError';
  }
}

/**
 * Parse an RFC 5322 address list ("Doe, Jane" <jane@x.com>, bob@y.com) into
 * addresses. Uses nodemailer's address parser (a maintained implementation)
 * rather than a split on commas: a display name may contain a comma, and a
 * "Name <address>" entry is one recipient, not an address.
 *
 * Groups ("Team: a@x, b@y;") are flattened to their members. An entry with no
 * address (a bare word) fails loud: sending to it would be refused by the
 * provider after the person approved it.
 */
export function parseMailAddressList(value: string | undefined | null): MailAddress[] {
  if (!value || value.trim().length === 0) return [];
  const parsed = addressparser(value, { flatten: true });
  const out: MailAddress[] = [];
  for (const entry of parsed) {
    const address = (entry.address ?? '').trim();
    if (!address || !address.includes('@')) {
      throw new MailAddressError(
        `'${entry.name || address || value}' is not an e-mail address (expected name@domain).`,
      );
    }
    const name = (entry.name ?? '').trim();
    out.push(name ? { name, address } : { address });
  }
  return out;
}

/** Lower-cased address, the key two entries are the same mailbox by. */
export function mailboxKey(address: string): string {
  return address.trim().toLowerCase();
}

function dedupe(list: MailAddress[], exclude: Set<string>): MailAddress[] {
  const seen = new Set<string>(exclude);
  const out: MailAddress[] = [];
  for (const a of list) {
    const key = mailboxKey(a.address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// ── Reply ───────────────────────────────────────────────────────────────────

/** The participants of the message being answered, as the provider stores them. */
export interface MailOriginalParticipants {
  from: MailAddress[];
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
}

export interface MailReplyRecipients {
  to: MailAddress[];
  cc: MailAddress[];
}

export class MailNoRecipientError extends Error {
  readonly code = 'mail_no_recipient';
  constructor(message: string) {
    super(message);
    this.name = 'MailNoRecipientError';
  }
}

/**
 * Who a reply goes to, the way a mail client decides it:
 *
 *   - the message was written by the mailbox owner (every From address is one
 *     of `ownAddresses`): the reply goes to that message's recipients (its To;
 *     with `replyAll`, its Cc too) — a follow-up on one's own message reaches
 *     the people it was sent to, not oneself;
 *   - otherwise: to its Reply-To when it has one, else to its From (RFC 5322
 *     §3.6.2); with `replyAll`, the original To and Cc become the Cc.
 *
 * The owner's own addresses are removed from both lists and duplicates are
 * dropped. A reply that would reach nobody fails loud.
 */
export function resolveReplyRecipients(
  original: MailOriginalParticipants,
  ownAddresses: readonly string[],
  replyAll: boolean,
): MailReplyRecipients {
  const own = new Set(ownAddresses.map(mailboxKey));
  const fromOwner =
    original.from.length > 0 && original.from.every((a) => own.has(mailboxKey(a.address)));

  let to: MailAddress[];
  let cc: MailAddress[];
  if (fromOwner) {
    to = original.to;
    cc = replyAll ? original.cc : [];
  } else {
    to = original.replyTo.length > 0 ? original.replyTo : original.from;
    cc = replyAll ? [...original.to, ...original.cc] : [];
  }

  to = dedupe(to, own);
  cc = dedupe(cc, new Set([...own, ...to.map((a) => mailboxKey(a.address))]));
  if (to.length === 0 && cc.length > 0) {
    to = cc;
    cc = [];
  }
  if (to.length === 0) {
    throw new MailNoRecipientError(
      'This reply has no recipient: the message has no sender or recipient other than this mailbox.',
    );
  }
  return { to, cc };
}

/** Prefix the subject with "Re: " unless it already carries it. */
export function replySubject(original: string): string {
  return /^re:/i.test(original.trim()) ? original : `Re: ${original}`;
}

/** Prefix the subject with "Fwd: " unless it already carries a forward prefix. */
export function forwardSubject(original: string): string {
  return /^fwd?:/i.test(original.trim()) ? original : `Fwd: ${original}`;
}

// ── What every operation reports ────────────────────────────────────────────

export interface MailAttachmentReport {
  filename: string;
  mimeType: string;
  /** True for a part shown inside the body (an inline image) rather than listed. */
  inline: boolean;
}

/**
 * The result of a send, reply or forward: what was actually done, so the agent
 * and the person can check it. `messageId` / `threadId` are null when the
 * provider does not return them (Graph's send actions answer 202 with no body).
 */
export interface MailSendReport {
  sent: true;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyFormat: MailBodyFormat;
  messageId: string | null;
  threadId: string | null;
  /** Files attached by this send (not those of a forwarded original). */
  attachments: MailAttachmentReport[];
  /** Set on a forward: the original carried whole, and the files it held. */
  forwarded?: {
    messageId: string;
    attachments: MailAttachmentReport[];
  };
}
