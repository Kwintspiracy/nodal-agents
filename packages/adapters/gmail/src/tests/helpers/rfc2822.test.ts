// @nodal-agents/adapter-gmail — RFC 2822 round-trip tests

import { describe, it, expect } from 'vitest';
import { buildRfc2822Message, decodeRfc2822Message, parseRawHeaders } from '../../helpers/rfc2822';
import { GmailAdapterError } from '../../errors';

describe('buildRfc2822Message', () => {
  it('builds a base64url-encoded message for simple plain text', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'Hello World',
      body: 'This is a test email.',
    });

    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    // base64url: should not contain + or / or =
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('round-trip: build then decode preserves headers', () => {
    const encoded = buildRfc2822Message({
      to: 'bob@example.com',
      subject: 'Test Subject',
      body: 'Body content here.',
      cc: 'cc@example.com',
    });

    const decoded = decodeRfc2822Message(encoded);
    const headers = parseRawHeaders(decoded);

    expect(headers['to']).toBe('bob@example.com');
    expect(headers['subject']).toBe('Test Subject');
    expect(headers['cc']).toBe('cc@example.com');
  });

  it('encodes non-ASCII subject with RFC 2047 encoded-word', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'Résumé — Candidature',
      body: 'Voir pièce jointe.',
    });

    const decoded = decodeRfc2822Message(encoded);
    const headers = parseRawHeaders(decoded);

    // The subject header should contain the encoded-word marker
    expect(headers['subject']).toMatch(/=\?utf-8\?B\?/i);
    // And should be decodable back to the original
    const subjectHeader = headers['subject'] ?? '';
    const b64Part = subjectHeader.match(/=\?utf-8\?B\?([^?]+)\?=/i)?.[1];
    if (b64Part) {
      const decodedSubject = Buffer.from(b64Part, 'base64').toString('utf-8');
      expect(decodedSubject).toBe('Résumé — Candidature');
    }
  });

  it('includes In-Reply-To and References headers for replies', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'Re: Test',
      body: 'My reply.',
      inReplyTo: '<original-message-id@example.com>',
      references: '<original-message-id@example.com>',
    });

    const decoded = decodeRfc2822Message(encoded);
    const headers = parseRawHeaders(decoded);

    expect(headers['in-reply-to']).toBe('<original-message-id@example.com>');
    expect(headers['references']).toBe('<original-message-id@example.com>');
  });

  it('sets Content-Type text/html for HTML bodies', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'HTML Email',
      body: '<h1>Hello</h1><p>World</p>',
    });

    const decoded = decodeRfc2822Message(encoded);
    expect(decoded).toContain('text/html');
  });

  it('sets Content-Type text/plain for plain text bodies', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'Plain Email',
      body: 'Just plain text.',
    });

    const decoded = decodeRfc2822Message(encoded);
    expect(decoded).toContain('text/plain');
  });

  it('builds multipart/mixed when attachments are present', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'With Attachment',
      body: 'See attached.',
      attachments: [
        {
          filename: 'report.txt',
          content: 'Line 1\nLine 2\n',
          mimeType: 'text/plain',
          encoding: 'text',
        },
      ],
    });

    const decoded = decodeRfc2822Message(encoded);
    expect(decoded).toContain('multipart/mixed');
    expect(decoded).toContain('report.txt');
  });

  it('attaches multiple files correctly', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'Two Attachments',
      body: 'See attached files.',
      attachments: [
        { filename: 'first.txt', content: 'First file content' },
        { filename: 'second.csv', content: 'a,b,c\n1,2,3\n' },
      ],
    });

    const decoded = decodeRfc2822Message(encoded);
    expect(decoded).toContain('first.txt');
    expect(decoded).toContain('second.csv');
  });

  it('includes from header when provided', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      from: 'sender@example.com',
      subject: 'From Test',
      body: 'Hello.',
    });

    const decoded = decodeRfc2822Message(encoded);
    const headers = parseRawHeaders(decoded);
    expect(headers['from']).toBe('sender@example.com');
  });

  it('includes bcc header when provided', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'BCC Test',
      body: 'Hello.',
      bcc: 'secret@example.com',
    });

    const decoded = decodeRfc2822Message(encoded);
    const headers = parseRawHeaders(decoded);
    expect(headers['bcc']).toBe('secret@example.com');
  });

  it('includes MIME-Version header', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'MIME Test',
      body: 'Content.',
    });

    const decoded = decodeRfc2822Message(encoded);
    const headers = parseRawHeaders(decoded);
    expect(headers['mime-version']).toBe('1.0');
  });

  it('infers MIME type from filename extension for attachments', () => {
    const encoded = buildRfc2822Message({
      to: 'alice@example.com',
      subject: 'CSV Report',
      body: 'See attached.',
      attachments: [{ filename: 'data.csv', content: 'col1,col2\nval1,val2\n' }],
    });

    const decoded = decodeRfc2822Message(encoded);
    expect(decoded).toContain('text/csv');
  });

  // audit#2026-07-07 F11: CRLF header injection (CWE-93). A malicious `to`
  // containing "\r\nBcc: attacker@evil.com" must NOT produce a message with
  // an injected Bcc header — the build must fail loud instead.
  describe('F11 — CRLF header injection is rejected, not silently passed through', () => {
    it('rejects a `to` value containing an injected Bcc header', () => {
      expect(() =>
        buildRfc2822Message({
          to: 'victim@example.com\r\nBcc: attacker@evil.com',
          subject: 'Hi',
          body: 'Hello.',
        }),
      ).toThrow(GmailAdapterError);

      try {
        buildRfc2822Message({
          to: 'victim@example.com\r\nBcc: attacker@evil.com',
          subject: 'Hi',
          body: 'Hello.',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GmailAdapterError);
        expect((err as GmailAdapterError).code).toBe('gmail_validation_error');
      }
    });

    it('rejects an injected header via cc', () => {
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi',
          body: 'Hello.',
          cc: 'legit@example.com\r\nBcc: attacker@evil.com',
        }),
      ).toThrow(GmailAdapterError);
    });

    it('rejects an injected header via bcc', () => {
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi',
          body: 'Hello.',
          bcc: 'legit@example.com\r\nX-Injected: yes',
        }),
      ).toThrow(GmailAdapterError);
    });

    it('rejects an injected header via a plain-ASCII subject (encodeHeader does not strip CRLF)', () => {
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi\r\nBcc: attacker@evil.com',
          body: 'Hello.',
        }),
      ).toThrow(GmailAdapterError);
    });

    it('rejects an injected header via from/replyTo/inReplyTo/references', () => {
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi',
          body: 'Hello.',
          from: 'me@example.com\r\nBcc: x@evil.com',
        }),
      ).toThrow(GmailAdapterError);
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi',
          body: 'Hello.',
          replyTo: 'me@example.com\r\nBcc: x@evil.com',
        }),
      ).toThrow(GmailAdapterError);
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi',
          body: 'Hello.',
          inReplyTo: '<id@example.com>\r\nBcc: x@evil.com',
        }),
      ).toThrow(GmailAdapterError);
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi',
          body: 'Hello.',
          references: '<id@example.com>\r\nBcc: x@evil.com',
        }),
      ).toThrow(GmailAdapterError);
    });

    it('rejects an injected header via an attachment filename', () => {
      expect(() =>
        buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'Hi',
          body: 'See attached.',
          attachments: [{ filename: 'a.txt\r\nContent-Type: text/html', content: 'hi' }],
        }),
      ).toThrow(GmailAdapterError);
    });

    it('still builds a normal message when no CR/LF is present', () => {
      const encoded = buildRfc2822Message({
        to: 'alice@example.com',
        subject: 'Perfectly normal subject',
        body: 'Hello.',
        cc: 'cc@example.com',
      });
      expect(typeof encoded).toBe('string');
      const headers = parseRawHeaders(decodeRfc2822Message(encoded));
      expect(headers['to']).toBe('alice@example.com');
      expect(headers['bcc']).toBeUndefined();
    });
  });

  // audit#2026-07-07 SEC-6: MIME boundary must come from a CSPRNG
  // (node:crypto randomBytes), not Math.random.
  describe('SEC-6 — MIME boundary uses crypto.randomBytes, not Math.random', () => {
    it('boundary matches the crypto.randomBytes hex format, not a Math.random-derived one', () => {
      const encoded = buildRfc2822Message({
        to: 'alice@example.com',
        subject: 'With Attachment',
        body: 'See attached.',
        attachments: [{ filename: 'report.txt', content: 'hello' }],
      });
      const decoded = decodeRfc2822Message(encoded);
      const boundaryMatch = /boundary="([^"]+)"/.exec(decoded);
      expect(boundaryMatch).not.toBeNull();
      const boundary = boundaryMatch?.[1] ?? '';
      // nodalai_<base36 timestamp>_<24 lowercase hex chars from randomBytes(12)>
      expect(boundary).toMatch(/^nodalai_[0-9a-z]+_[0-9a-f]{24}$/);
    });

    it('generates distinct boundaries across calls', () => {
      const boundaries = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const encoded = buildRfc2822Message({
          to: 'alice@example.com',
          subject: 'x',
          body: 'y',
          attachments: [{ filename: 'f.txt', content: 'z' }],
        });
        const decoded = decodeRfc2822Message(encoded);
        const boundary = /boundary="([^"]+)"/.exec(decoded)?.[1] ?? '';
        boundaries.add(boundary);
      }
      expect(boundaries.size).toBe(20);
    });
  });
});

describe('parseRawHeaders', () => {
  it('parses simple headers into lowercase map', () => {
    const raw = 'To: alice@example.com\r\nSubject: Test\r\nFrom: bob@test.com\r\n\r\nBody here.';
    const headers = parseRawHeaders(raw);

    expect(headers['to']).toBe('alice@example.com');
    expect(headers['subject']).toBe('Test');
    expect(headers['from']).toBe('bob@test.com');
  });

  it('does not include body in headers', () => {
    const raw = 'Subject: Title\r\n\r\nThis is the body.';
    const headers = parseRawHeaders(raw);

    expect(Object.keys(headers)).toHaveLength(1);
    expect(headers['subject']).toBe('Title');
  });

  it('handles LF-only line endings', () => {
    const raw = 'To: alice@example.com\nSubject: LF Test\n\nBody.';
    const headers = parseRawHeaders(raw);

    expect(headers['to']).toBe('alice@example.com');
    expect(headers['subject']).toBe('LF Test');
  });
});
