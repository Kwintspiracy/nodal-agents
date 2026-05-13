// @nodal-agents/adapter-gmail — parse-payload tests

import { describe, it, expect } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  extractTextFromPayload,
  decodeBase64Url,
  extractAttachmentInfos,
  parseGmailHeaders,
} from '../../helpers/parse-payload';

function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makePlainPart(text: string): gmail_v1.Schema$MessagePart {
  return {
    mimeType: 'text/plain',
    body: { data: encodeBase64Url(text), size: text.length },
  };
}

function makeHtmlPart(html: string): gmail_v1.Schema$MessagePart {
  return {
    mimeType: 'text/html',
    body: { data: encodeBase64Url(html), size: html.length },
  };
}

describe('decodeBase64Url', () => {
  it('decodes a base64url string back to UTF-8', () => {
    const original = 'Hello, World!';
    const encoded = encodeBase64Url(original);
    expect(decodeBase64Url(encoded)).toBe(original);
  });

  it('handles missing padding', () => {
    const encoded = encodeBase64Url('Test without padding');
    const stripped = encoded.replace(/=/g, '');
    expect(decodeBase64Url(stripped)).toBe('Test without padding');
  });

  it('returns empty string for empty input', () => {
    expect(decodeBase64Url('')).toBe('');
  });

  it('handles UTF-8 characters', () => {
    const original = 'Résumé — café';
    const encoded = encodeBase64Url(original);
    expect(decodeBase64Url(encoded)).toBe(original);
  });
});

describe('extractTextFromPayload', () => {
  it('extracts plain text directly', () => {
    const payload = makePlainPart('Hello, this is plain text.');
    expect(extractTextFromPayload(payload)).toBe('Hello, this is plain text.');
  });

  it('strips HTML tags from html-only payload', () => {
    const payload = makeHtmlPart('<h1>Title</h1><p>Paragraph text here.</p>');
    const text = extractTextFromPayload(payload);
    expect(text).not.toContain('<h1>');
    expect(text).toContain('Title');
    expect(text).toContain('Paragraph text here.');
  });

  it('prefers text/plain over text/html in multipart/alternative', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [makePlainPart('Plain text version.'), makeHtmlPart('<p>HTML version.</p>')],
    };
    const text = extractTextFromPayload(payload);
    expect(text).toBe('Plain text version.');
    expect(text).not.toContain('<p>');
  });

  it('falls back to html if no plain text in multipart', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [makeHtmlPart('<p>Only HTML here.</p>')],
    };
    const text = extractTextFromPayload(payload);
    expect(text).toContain('Only HTML here.');
  });

  it('recurses into nested multipart', () => {
    const innerMultipart: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [makePlainPart('Nested plain text.')],
    };
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [innerMultipart],
    };
    expect(extractTextFromPayload(payload)).toBe('Nested plain text.');
  });

  it('returns empty string for undefined payload', () => {
    expect(extractTextFromPayload(undefined)).toBe('');
  });

  it('returns empty string for empty payload', () => {
    expect(extractTextFromPayload({})).toBe('');
  });

  it('strips style and script tags from HTML', () => {
    const payload = makeHtmlPart(
      '<style>body { color: red; }</style><p>Content</p><script>alert("xss")</script>',
    );
    const text = extractTextFromPayload(payload);
    expect(text).not.toContain('<style>');
    expect(text).not.toContain('<script>');
    expect(text).toContain('Content');
  });

  it('handles &nbsp; and common HTML entities', () => {
    const payload = makeHtmlPart('<p>Hello&nbsp;World &amp; friends &lt;3</p>');
    const text = extractTextFromPayload(payload);
    expect(text).toContain('Hello World');
    expect(text).toContain('&');
    expect(text).toContain('<3');
  });
});

describe('extractAttachmentInfos', () => {
  it('returns empty array for payload with no attachments', () => {
    const payload = makePlainPart('No attachments here.');
    expect(extractAttachmentInfos(payload)).toHaveLength(0);
  });

  it('extracts attachment info from parts with attachmentId', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        makePlainPart('See attached.'),
        {
          mimeType: 'application/pdf',
          filename: 'document.pdf',
          body: {
            attachmentId: 'att-id-123',
            size: 12345,
          },
        },
      ],
    };
    const infos = extractAttachmentInfos(payload);
    expect(infos).toHaveLength(1);
    expect(infos[0]?.attachmentId).toBe('att-id-123');
    expect(infos[0]?.filename).toBe('document.pdf');
    expect(infos[0]?.mimeType).toBe('application/pdf');
    expect(infos[0]?.size).toBe(12345);
  });

  it('returns empty array for undefined', () => {
    expect(extractAttachmentInfos(undefined)).toHaveLength(0);
  });
});

describe('parseGmailHeaders', () => {
  it('returns empty object for undefined payload', () => {
    expect(parseGmailHeaders(undefined)).toEqual({});
  });

  it('parses headers into lowercase map', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      headers: [
        { name: 'From', value: 'alice@example.com' },
        { name: 'Subject', value: 'Hello' },
        { name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' },
      ],
    };
    const headers = parseGmailHeaders(payload);
    expect(headers['from']).toBe('alice@example.com');
    expect(headers['subject']).toBe('Hello');
    expect(headers['date']).toBe('Mon, 1 Jan 2024 12:00:00 +0000');
  });

  it('normalizes header names to lowercase', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      headers: [{ name: 'MESSAGE-ID', value: '<msg-123@test.com>' }],
    };
    const headers = parseGmailHeaders(payload);
    expect(headers['message-id']).toBe('<msg-123@test.com>');
  });
});
