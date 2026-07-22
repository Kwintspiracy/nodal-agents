// @nodal-agents/adapter-outlook-mail — message payload builder tests

import { describe, it, expect } from 'vitest';
import {
  parseRecipients,
  buildFileAttachments,
  detectBodyContentType,
} from '../../helpers/message';

describe('parseRecipients', () => {
  it('parses a single address', () => {
    expect(parseRecipients('alice@example.com')).toEqual([
      { emailAddress: { address: 'alice@example.com' } },
    ]);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    expect(parseRecipients('alice@example.com,  bob@example.com')).toEqual([
      { emailAddress: { address: 'alice@example.com' } },
      { emailAddress: { address: 'bob@example.com' } },
    ]);
  });

  it('returns an empty array for undefined, empty, or blank input', () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients('   ')).toEqual([]);
  });

  it('drops empty entries from a trailing/leading comma', () => {
    expect(parseRecipients('alice@example.com,,bob@example.com,')).toEqual([
      { emailAddress: { address: 'alice@example.com' } },
      { emailAddress: { address: 'bob@example.com' } },
    ]);
  });
});

describe('buildFileAttachments', () => {
  it('returns an empty array when no specs are given', () => {
    expect(buildFileAttachments(undefined)).toEqual([]);
    expect(buildFileAttachments([])).toEqual([]);
  });

  it('base64-encodes plain text content and infers MIME type from filename', () => {
    const [att] = buildFileAttachments([{ filename: 'report.csv', content: 'a,b,c' }]);
    expect((att as unknown as { '@odata.type': string })['@odata.type']).toBe(
      '#microsoft.graph.fileAttachment',
    );
    expect(att?.name).toBe('report.csv');
    expect(att?.contentType).toBe('text/csv');
    expect((att as unknown as { contentBytes: string }).contentBytes).toBe(
      Buffer.from('a,b,c', 'utf-8').toString('base64'),
    );
  });

  it('round-trips pre-encoded base64 content without double-encoding it', () => {
    const original = Buffer.from('binary-ish content', 'utf-8').toString('base64');
    const [att] = buildFileAttachments([
      { filename: 'file.bin', content: original, encoding: 'base64' },
    ]);
    const decoded = Buffer.from(
      (att as unknown as { contentBytes: string }).contentBytes,
      'base64',
    ).toString('utf-8');
    expect(decoded).toBe('binary-ish content');
  });

  it('respects an explicit mimeType over the inferred one', () => {
    const [att] = buildFileAttachments([
      { filename: 'data.bin', content: 'x', mimeType: 'application/custom' },
    ]);
    expect(att?.contentType).toBe('application/custom');
  });

  it('falls back to application/octet-stream for an unrecognized extension', () => {
    const [att] = buildFileAttachments([{ filename: 'data.xyz123', content: 'x' }]);
    expect(att?.contentType).toBe('application/octet-stream');
  });

  // review MINOR-4: outgoing fileAttachments over Graph's 3 MB inline limit
  // must fail loud with a typed adapter error, not surface as an opaque
  // Graph 413 after the request is already sent.
  it('rejects a plain-text attachment over the 3 MB inline limit with a typed error', () => {
    const oversized = 'x'.repeat(3 * 1024 * 1024 + 1);
    expect(() => buildFileAttachments([{ filename: 'big.txt', content: oversized }])).toThrowError(
      expect.objectContaining({ code: 'outlook_attachment_too_large' }),
    );
  });

  it('rejects a base64-encoded attachment over the 3 MB limit measured on DECODED bytes', () => {
    const oversizedBase64 = Buffer.from('y'.repeat(3 * 1024 * 1024 + 1), 'utf-8').toString(
      'base64',
    );
    expect(() =>
      buildFileAttachments([{ filename: 'big.bin', content: oversizedBase64, encoding: 'base64' }]),
    ).toThrowError(expect.objectContaining({ code: 'outlook_attachment_too_large' }));
  });

  it('accepts an attachment right at the 3 MB boundary', () => {
    const atCap = 'x'.repeat(3 * 1024 * 1024);
    expect(() => buildFileAttachments([{ filename: 'ok.txt', content: atCap }])).not.toThrow();
  });
});

describe('detectBodyContentType', () => {
  it('detects html when the body contains real tags', () => {
    expect(detectBodyContentType('<p>Hello</p>')).toBe('html');
  });

  it('treats plain text as text, including text with bare angle brackets', () => {
    expect(detectBodyContentType('Hello world')).toBe('text');
    expect(detectBodyContentType('5 < 10 and 10 > 5')).toBe('text');
  });
});
