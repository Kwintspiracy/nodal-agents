// @nodal-agents/adapter-gmail — MIME builder tests (the bytes Gmail receives in `raw`)

import { describe, it, expect } from 'vitest';
import PostalMime from 'postal-mime';
import {
  assertNoHeaderInjection,
  attachmentSpecsToMime,
  buildMimeMessage,
  inferMimeType,
  toGmailRaw,
} from '../../helpers/mime';

const to = [{ name: 'Alice Martin', address: 'alice@example.com' }];

function headerBlock(message: Buffer): string {
  const s = message.toString('latin1');
  return s.slice(0, s.search(/\r\n\r\n/));
}

describe('buildMimeMessage @cap:connecter-un-service/moteur', () => {
  it('labels a text body text/plain even when it holds angle brackets', async () => {
    const m = await buildMimeMessage({
      to,
      subject: 'Hi',
      body: 'Reach Jane <jane@acme.com>.\nDear <Name>',
      bodyFormat: 'text',
    });
    expect(headerBlock(m)).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(m.toString('latin1')).not.toMatch(/text\/html/);
    const parsed = await PostalMime.parse(m);
    expect(parsed.text?.replace(/\r?\n$/, '')).toBe('Reach Jane <jane@acme.com>.\nDear <Name>');
  });

  it('labels a body text/html only when it is declared so', async () => {
    const m = await buildMimeMessage({ to, subject: 'Hi', body: 'no tags', bodyFormat: 'html' });
    expect(headerBlock(m)).toMatch(/^Content-Type: text\/html; charset=utf-8$/m);
  });

  it('encodes a non-ASCII subject and display name, and keeps Bcc for Gmail to deliver', async () => {
    const m = await buildMimeMessage({
      to: [{ name: 'Zoé Lefèvre', address: 'zoe@example.fr' }],
      bcc: [{ address: 'audit@example.com' }],
      subject: 'Réunion à 15 h',
      body: 'x',
      bodyFormat: 'text',
    });
    const headers = headerBlock(m);
    expect(headers).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(headers).toMatch(/^Bcc: audit@example.com$/m);
    const parsed = await PostalMime.parse(m);
    expect(parsed.subject).toBe('Réunion à 15 h');
    expect(parsed.to).toEqual([{ name: 'Zoé Lefèvre', address: 'zoe@example.fr' }]);
  });

  it('writes the threading headers', async () => {
    const m = await buildMimeMessage({
      to,
      subject: 'Re: x',
      body: 'x',
      bodyFormat: 'text',
      inReplyTo: '<b@x>',
      references: ['<a@x>', '<b@x>'],
    });
    expect(headerBlock(m)).toMatch(/^In-Reply-To: <b@x>$/m);
    expect(headerBlock(m)).toMatch(/^References: <a@x> <b@x>$/m);
  });

  it('attaches files as attachments, bytes intact, and keeps an empty body as a text part', async () => {
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 1]);
    const m = await buildMimeMessage({
      to,
      subject: 'Files',
      body: '',
      bodyFormat: 'text',
      attachments: [
        { filename: 'a.pdf', contentType: 'application/pdf', content: pdf },
        ...attachmentSpecsToMime([{ filename: 'notes.csv', content: 'a;b\n1;2\n' }]),
      ],
    });
    const s = m.toString('latin1');
    expect(s).toMatch(/Content-Type: multipart\/mixed/);
    expect(s).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    const parsed = await PostalMime.parse(m);
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType, a.disposition])).toEqual([
      ['a.pdf', 'application/pdf', 'attachment'],
      ['notes.csv', 'text/csv', 'attachment'],
    ]);
    expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).equals(pdf)).toBe(true);
  });

  it('carries an encapsulated message as its own bytes, declared 8bit', async () => {
    const original = Buffer.from('Subject: Été\r\nFrom: a@x\r\n\r\nCorps é\r\n', 'utf-8');
    const m = await buildMimeMessage({
      to,
      subject: 'Fwd: Été',
      body: '',
      bodyFormat: 'text',
      attachments: [
        {
          filename: 'Été.eml',
          contentType: 'message/rfc822',
          content: original,
          transferEncoding: '8bit',
        },
      ],
    });
    expect(m.includes(original)).toBe(true);
    expect(m.toString('latin1')).toMatch(
      /Content-Type: message\/rfc822[^\r]*\r\nContent-Transfer-Encoding: 8bit/,
    );
  });

  it('encodes `raw` as base64url without padding', async () => {
    const m = await buildMimeMessage({ to, subject: '??>>', body: '~~~', bodyFormat: 'text' });
    const raw = toGmailRaw(m);
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, 'base64url').equals(m)).toBe(true);
  });

  it('infers MIME types host-independently', () => {
    expect(inferMimeType('a.HTML')).toBe('text/html');
    expect(inferMimeType('noext')).toBe('application/octet-stream');
  });
});

describe('F11 — a header value holding CR or LF is refused, not passed through', () => {
  it.each([
    ['subject', { subject: 'x\r\nBcc: evil@x.com' }],
    ['to', { to: [{ address: 'a@x.com\r\nBcc: evil@x.com' }] }],
    ['to', { to: [{ name: 'A\nB', address: 'a@x.com' }] }],
    ['cc', { cc: [{ address: 'c@x.com\nBcc: evil@x.com' }] }],
    ['bcc', { bcc: [{ address: 'c@x.com\rX: y' }] }],
    ['replyTo', { replyTo: [{ address: 'r@x.com\nX: y' }] }],
    ['inReplyTo', { inReplyTo: '<a@x>\r\nX: y' }],
    ['references', { references: ['<a@x>\nX: y'] }],
    [
      'attachment.filename',
      {
        attachments: [
          { filename: 'a\r\n.txt', contentType: 'text/plain', content: Buffer.from('') },
        ],
      },
    ],
  ])('refuses a line break in %s', async (field, override) => {
    await expect(
      buildMimeMessage({ to, subject: 'ok', body: 'ok', bodyFormat: 'text', ...override }),
    ).rejects.toMatchObject({
      code: 'gmail_validation_error',
      message: expect.stringContaining(field),
    });
  });

  it('accepts a value without line breaks', () => {
    expect(() => assertNoHeaderInjection('subject', 'fine')).not.toThrow();
  });
});
