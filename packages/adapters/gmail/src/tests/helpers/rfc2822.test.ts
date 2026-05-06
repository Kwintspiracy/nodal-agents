// @nodalai/adapter-gmail — RFC 2822 round-trip tests

import { describe, it, expect } from 'vitest';
import { buildRfc2822Message, decodeRfc2822Message, parseRawHeaders } from '../../helpers/rfc2822';

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
