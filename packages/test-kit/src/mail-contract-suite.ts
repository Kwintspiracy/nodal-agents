// @nodal-agents/test-kit — the mail contract's conformance suite (#1191, #1192, #1193).
//
// What "send", "reply", "reply to all" and "forward" mean is written once, in
// @nodal-agents/shared/mail-contract. This suite holds EVERY mail adapter to
// it, with the same cases and the same assertions: each adapter's test file
// supplies a driver that runs the adapter's real tools against its provider's
// HTTP layer, faked at the SDK's transport, and decodes what the provider
// would have received into the neutral `MailOutgoing` shape below. The
// assertions are on that decoded request (headers, parts, bytes), never on
// call counts.
//
// Written as the first chapter of a connector conformance suite: a driver is
// the only thing an adapter provides, and the cases know nothing of any
// provider.
//
// This harness imports no product package (dependency-cruiser rule
// `adapters-only-import-tools-shared`): its types mirror the contract's
// structurally.

import { describe, expect, it } from 'vitest';

// ── What a driver is given ──────────────────────────────────────────────────

export interface MailFixtureAddress {
  name?: string;
  address: string;
}

export interface MailFixtureFile {
  filename: string;
  mimeType: string;
  content: Buffer;
  /** An inline part (an image shown in the HTML body, referenced by `cid:`). */
  inline: boolean;
  contentId?: string;
}

/** A message stored in the fake mailbox, in provider-neutral terms. */
export interface MailFixtureMessage {
  id: string;
  threadId: string;
  /** The RFC 5322 Message-ID, angle brackets included. */
  messageIdHeader: string;
  references?: string[];
  from: MailFixtureAddress[];
  replyTo?: MailFixtureAddress[];
  to: MailFixtureAddress[];
  cc?: MailFixtureAddress[];
  subject: string;
  text: string;
  html?: string;
  files?: MailFixtureFile[];
}

export type MailContractOperation =
  | {
      kind: 'send';
      to: string;
      cc?: string;
      bcc?: string;
      subject: string;
      body: string;
      bodyFormat?: 'text' | 'html';
    }
  | {
      kind: 'reply';
      messageId: string;
      body: string;
      bodyFormat?: 'text' | 'html';
      replyAll?: boolean;
    }
  | { kind: 'forward'; messageId: string; to: string; note?: string };

export interface MailRunOptions {
  /** The provider refuses the outgoing request because the message is too large. */
  providerRefuses?: 'message-too-large';
}

// ── What a driver returns ───────────────────────────────────────────────────

/** One outgoing message, as the provider would receive it, decoded. */
export interface MailOutgoing {
  to: MailFixtureAddress[];
  cc: MailFixtureAddress[];
  bcc: MailFixtureAddress[];
  /** null when the provider composes the subject itself (a server-side forward). */
  subject: string | null;
  /** Exactly one body, of one declared type. */
  body: { format: 'text' | 'html'; content: string };
  /** Every body part the request carries: a contract-conformant message has exactly one. */
  bodyPartCount: number;
  /** The thread the provider will file it in. */
  threadId: string | null;
  inReplyTo: string | null;
  attachments: Array<{ filename: string; mimeType: string; content: Buffer }>;
  /**
   * The original a forward carries. `content` is the bytes the request
   * carries when the client sends them (Gmail); null when the provider carries
   * the stored original itself, server side (Graph's forward action).
   */
  forwardedOriginal: { messageId: string; content: Buffer | null } | null;
}

export interface MailRunResult {
  result: unknown;
  outgoing: MailOutgoing[];
}

export interface MailContractDriver {
  /** e.g. 'gmail', 'outlook-mail' */
  provider: string;
  /** The mailbox owner: the account the tools act as. */
  owner: MailFixtureAddress;
  run(
    op: MailContractOperation,
    mailbox: MailFixtureMessage[],
    options?: MailRunOptions,
  ): Promise<MailRunResult>;
  /** The bytes the provider stores for a fixture message, when it exposes them; null otherwise. */
  storedBytes(message: MailFixtureMessage): Buffer | null;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const OWNER: MailFixtureAddress = { name: 'Sam Owner', address: 'owner@example.com' };
const ALICE: MailFixtureAddress = { name: 'Alice Martin', address: 'alice@example.com' };
const PAUL: MailFixtureAddress = { name: 'Paul Durand', address: 'paul@example.org' };
const ZOE: MailFixtureAddress = { name: 'Zoé Lefèvre', address: 'zoe@example.fr' };
const CLIENT: MailFixtureAddress = { name: 'Client', address: 'client@example.net' };
const NOREPLY: MailFixtureAddress = { name: 'Site form', address: 'noreply@site.example' };

/** The owner address every driver must act as, so fixtures can name it. */
export const MAIL_CONTRACT_OWNER: MailFixtureAddress = OWNER;

// A tiny but real PNG (1×1) and PDF header, so bytes are bytes.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  Buffer.from([0, 1, 2, 3, 254, 255]),
]);

export const MAIL_FIXTURES = {
  /** A message from Alice, with a display name, to the owner and Paul. */
  fromAlice: {
    id: 'm-alice',
    threadId: 't-alice',
    messageIdHeader: '<alice-1@mail.example.com>',
    references: ['<root-0@mail.example.com>'],
    from: [ALICE],
    to: [OWNER, PAUL],
    cc: [ZOE],
    subject: 'Planning',
    text: 'Hello,\nsee the plan.\nAlice',
  },
  /** A contact-form notification: From is a no-reply sender, Reply-To the client. */
  contactForm: {
    id: 'm-form',
    threadId: 't-form',
    messageIdHeader: '<form-1@site.example>',
    from: [NOREPLY],
    replyTo: [CLIENT],
    to: [OWNER],
    subject: 'New contact request',
    text: 'A client wrote through the form.',
  },
  /** A message the owner sent to Paul (cc Zoé), awaiting an answer. */
  ownSent: {
    id: 'm-own',
    threadId: 't-own',
    messageIdHeader: '<own-1@mail.example.com>',
    from: [OWNER],
    to: [PAUL],
    cc: [ZOE],
    subject: 'Quote for the works',
    text: 'Hi Paul, here is my question.',
  },
  /** A message only the owner takes part in (a note to self). */
  noteToSelf: {
    id: 'm-self',
    threadId: 't-self',
    messageIdHeader: '<self-1@mail.example.com>',
    from: [OWNER],
    to: [OWNER],
    subject: 'Note to self',
    text: 'Remember the keys.',
  },
  /** An invoice with two attachments and an inline image. */
  invoice: {
    id: 'm-invoice',
    threadId: 't-invoice',
    messageIdHeader: '<invoice-7@billing.example.com>',
    from: [ALICE],
    to: [OWNER],
    subject: 'Invoice 2026-11',
    text: 'Please find the invoice attached.',
    html: '<p>Please find the <b>invoice</b> attached.</p><img src="cid:logo@billing">',
    files: [
      {
        filename: 'invoice-2026-11.pdf',
        mimeType: 'application/pdf',
        content: PDF_BYTES,
        inline: false,
      },
      {
        filename: 'details.csv',
        mimeType: 'text/csv',
        content: Buffer.from('item;amount\nworks;1200\n', 'utf-8'),
        inline: false,
      },
      {
        filename: 'logo.png',
        mimeType: 'image/png',
        content: PNG_1X1,
        inline: true,
        contentId: 'logo@billing',
      },
    ],
  },
} satisfies Record<string, MailFixtureMessage>;

const MAILBOX: MailFixtureMessage[] = Object.values(MAIL_FIXTURES);

// A plain-text body that an "HTML detector" would have misread: a bracketed
// address, a placeholder, a tab, CRLF-free line breaks and a line far longer
// than 78 characters.
const TRICKY_TEXT =
  'Hi Marc,\n\nYou can reach Jane <jane@acme.com>.\nDear <Name>,\n\tindented line\n' +
  'A very long line that goes on and on, well past the seventy-eight characters a mail line is ' +
  'expected to hold, to make sure nothing wraps or drops it: ' +
  'x'.repeat(200) +
  '\n\nBest,\nSam';

// ── Assertions ──────────────────────────────────────────────────────────────

function addresses(list: MailFixtureAddress[]): string[] {
  return list.map((a) => a.address.toLowerCase()).sort();
}

/**
 * Text travels with CRLF line breaks (RFC 2046 §4.1.1), and a message's last
 * line is terminated by one (RFC 5322 §2.1): compare in that canonical form,
 * where the final terminator is not part of the text.
 */
function canonicalText(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function only(outgoing: MailOutgoing[]): MailOutgoing {
  expect(outgoing, 'exactly one outgoing message').toHaveLength(1);
  return outgoing[0]!;
}

interface ReportShape {
  sent: true;
  to: MailFixtureAddress[];
  cc: MailFixtureAddress[];
  bcc: MailFixtureAddress[];
  subject: string;
  bodyFormat: 'text' | 'html';
  threadId: string | null;
  attachments: Array<{ filename: string; mimeType: string; inline: boolean }>;
  forwarded?: {
    messageId: string;
    attachments: Array<{ filename: string; mimeType: string; inline: boolean }>;
  };
}

function report(result: unknown): ReportShape {
  expect(result).toMatchObject({ sent: true });
  return result as ReportShape;
}

/** One conformance case: a chapter of the contract, a name, and what it checks on a driver. */
export interface MailContractCase {
  chapter: 'send' | 'reply' | 'forward';
  name: string;
  run(driver: MailContractDriver): Promise<void>;
}

/**
 * The contract's cases, as data: a larger connector conformance suite can
 * take them as one of its chapters, and `runMailContractSuite` registers them
 * for one adapter.
 */
export const MAIL_CONTRACT_CASES: readonly MailContractCase[] = [
  {
    chapter: 'send',
    name: 'sends a text body as text, as written: brackets, tabs and long lines intact',
    async run(driver) {
      const { result, outgoing } = await driver.run(
        { kind: 'send', to: 'Marc <marc@example.com>', subject: 'Contacts', body: TRICKY_TEXT },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(out.body.format).toBe('text');
      expect(out.bodyPartCount).toBe(1);
      expect(canonicalText(out.body.content)).toBe(TRICKY_TEXT);
      const r = report(result);
      expect(r.bodyFormat).toBe('text');
      expect(r.to).toEqual([{ name: 'Marc', address: 'marc@example.com' }]);
    },
  },

  {
    chapter: 'send',
    name: 'sends an HTML body as HTML only when it is declared so',
    async run(driver) {
      const html = '<p>Hello <b>Marc</b></p>';
      const { result, outgoing } = await driver.run(
        {
          kind: 'send',
          to: 'marc@example.com',
          subject: 'Hi',
          body: html,
          bodyFormat: 'html',
        },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(out.body.format).toBe('html');
      expect(out.bodyPartCount).toBe(1);
      expect(out.body.content).toContain(html);
      expect(report(result).bodyFormat).toBe('html');
    },
  },

  {
    chapter: 'send',
    name: 'keeps a non-ASCII subject and display names, and a display name holding a comma',
    async run(driver) {
      const { result, outgoing } = await driver.run(
        {
          kind: 'send',
          to: '"Lefèvre, Zoé" <zoe@example.fr>, Paul Durand <paul@example.org>',
          cc: 'Ünal Çelik <unal@example.com>',
          bcc: 'audit@example.com',
          subject: 'Réunion à 15 h — ordre du jour',
          body: 'Bonjour à tous',
        },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(out.subject).toBe('Réunion à 15 h — ordre du jour');
      expect(out.to).toEqual([
        { name: 'Lefèvre, Zoé', address: 'zoe@example.fr' },
        { name: 'Paul Durand', address: 'paul@example.org' },
      ]);
      expect(out.cc).toEqual([{ name: 'Ünal Çelik', address: 'unal@example.com' }]);
      expect(addresses(out.bcc)).toEqual(['audit@example.com']);
      expect(canonicalText(out.body.content)).toBe('Bonjour à tous');
      const r = report(result);
      expect(addresses(r.to)).toEqual(['paul@example.org', 'zoe@example.fr']);
      expect(addresses(r.bcc)).toEqual(['audit@example.com']);
    },
  },
  {
    chapter: 'reply',
    name: 'goes to the sender, in the thread, with the threading headers',
    async run(driver) {
      const original = MAIL_FIXTURES.fromAlice;
      const { result, outgoing } = await driver.run(
        { kind: 'reply', messageId: original.id, body: 'Thanks <Alice>,\nnoted.' },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(addresses(out.to)).toEqual(['alice@example.com']);
      expect(out.cc).toEqual([]);
      expect(out.threadId).toBe(original.threadId);
      expect(out.inReplyTo).toBe(original.messageIdHeader);
      expect(out.body.format).toBe('text');
      expect(canonicalText(out.body.content)).toBe('Thanks <Alice>,\nnoted.');
      const r = report(result);
      expect(addresses(r.to)).toEqual(['alice@example.com']);
      expect(r.subject).toBe('Re: Planning');
      expect(r.threadId).toBe(original.threadId);
    },
  },

  {
    chapter: 'reply',
    name: 'goes to the Reply-To when the message has one, not to its From',
    async run(driver) {
      const { result, outgoing } = await driver.run(
        { kind: 'reply', messageId: MAIL_FIXTURES.contactForm.id, body: 'Hello, thanks.' },
        MAILBOX,
      );
      expect(addresses(only(outgoing).to)).toEqual(['client@example.net']);
      expect(addresses(report(result).to)).toEqual(['client@example.net']);
    },
  },

  {
    chapter: 'reply',
    name: "a reply to one's own message goes to that message's recipients, not to oneself",
    async run(driver) {
      const original = MAIL_FIXTURES.ownSent;
      const { result, outgoing } = await driver.run(
        { kind: 'reply', messageId: original.id, body: 'Following up on my question.' },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(addresses(out.to)).toEqual(['paul@example.org']);
      expect(addresses([...out.to, ...out.cc])).not.toContain('owner@example.com');
      expect(out.threadId).toBe(original.threadId);
      expect(addresses(report(result).to)).toEqual(['paul@example.org']);
    },
  },

  {
    chapter: 'reply',
    name: 'reply to all keeps the other participants and removes oneself',
    async run(driver) {
      const { result, outgoing } = await driver.run(
        {
          kind: 'reply',
          messageId: MAIL_FIXTURES.fromAlice.id,
          body: 'Agreed.',
          replyAll: true,
        },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(addresses(out.to)).toEqual(['alice@example.com']);
      expect(addresses(out.cc)).toEqual(['paul@example.org', 'zoe@example.fr']);
      const r = report(result);
      expect(addresses(r.cc)).toEqual(['paul@example.org', 'zoe@example.fr']);
    },
  },

  {
    chapter: 'reply',
    name: "reply to all on one's own message keeps its To and Cc, without oneself",
    async run(driver) {
      const { outgoing } = await driver.run(
        {
          kind: 'reply',
          messageId: MAIL_FIXTURES.ownSent.id,
          body: 'Both of you?',
          replyAll: true,
        },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(addresses(out.to)).toEqual(['paul@example.org']);
      expect(addresses(out.cc)).toEqual(['zoe@example.fr']);
    },
  },

  {
    chapter: 'reply',
    name: 'a reply that would reach nobody but oneself fails, and nothing is sent',
    async run(driver) {
      await expect(
        driver.run({ kind: 'reply', messageId: MAIL_FIXTURES.noteToSelf.id, body: 'x' }, MAILBOX),
      ).rejects.toThrow(/recipient/i);
    },
  },
  {
    chapter: 'forward',
    name: 'carries the original whole: its body as it was, its two attachments and its inline image',
    async run(driver) {
      const original = MAIL_FIXTURES.invoice;
      const note = 'For your records,\nsee <attached>.';
      const { result, outgoing } = await driver.run(
        { kind: 'forward', messageId: original.id, to: 'Accountant <acc@example.com>', note },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(addresses(out.to)).toEqual(['acc@example.com']);
      // The note travels as text, as written; the original is not retyped into it.
      expect(out.body.format).toBe('text');
      expect(canonicalText(out.body.content)).toBe(note);
      expect(out.body.content).not.toContain(original.text);
      // The original itself is carried, byte for byte when the request carries bytes.
      expect(out.forwardedOriginal?.messageId).toBe(original.id);
      const stored = driver.storedBytes(original);
      if (out.forwardedOriginal?.content) {
        expect(stored).not.toBeNull();
        expect(out.forwardedOriginal.content.equals(stored!)).toBe(true);
      }
      const r = report(result);
      expect(r.subject).toBe('Fwd: Invoice 2026-11');
      expect(r.forwarded?.messageId).toBe(original.id);
      expect(
        [...(r.forwarded?.attachments ?? [])].sort((a, b) => a.filename.localeCompare(b.filename)),
      ).toEqual([
        { filename: 'details.csv', mimeType: 'text/csv', inline: false },
        { filename: 'invoice-2026-11.pdf', mimeType: 'application/pdf', inline: false },
        { filename: 'logo.png', mimeType: 'image/png', inline: true },
      ]);
    },
  },

  {
    chapter: 'forward',
    name: 'a sender with a display name does not turn the forward into HTML',
    async run(driver) {
      const { outgoing } = await driver.run(
        { kind: 'forward', messageId: MAIL_FIXTURES.fromAlice.id, to: 'bob@example.com' },
        MAILBOX,
      );
      const out = only(outgoing);
      expect(out.body.format).toBe('text');
      expect(out.bodyPartCount).toBe(1);
      expect(out.forwardedOriginal?.messageId).toBe(MAIL_FIXTURES.fromAlice.id);
    },
  },

  {
    chapter: 'forward',
    name: 'a forward the provider cannot carry fails, and reports nothing as sent',
    async run(driver) {
      await expect(
        driver.run(
          { kind: 'forward', messageId: MAIL_FIXTURES.invoice.id, to: 'acc@example.com' },
          MAILBOX,
          { providerRefuses: 'message-too-large' },
        ),
      ).rejects.toThrow();
    },
  },
];

/**
 * Register the conformance cases for one adapter. Call it at the top level of
 * the adapter's test file (inside a describe carrying its @cap tag).
 */
export function runMailContractSuite(driver: MailContractDriver): void {
  describe(`mail contract — ${driver.provider}`, () => {
    it('acts as the fixture owner', () => {
      expect(driver.owner.address).toBe(OWNER.address);
    });
    for (const chapter of ['send', 'reply', 'forward'] as const) {
      describe(chapter, () => {
        for (const c of MAIL_CONTRACT_CASES.filter((x) => x.chapter === chapter)) {
          it(c.name, () => c.run(driver));
        }
      });
    }
  });
}
