// @nodalai/adapter-google-docs — client factory tests

import { describe, it, expect } from 'vitest';
import { createDocsClient } from '../client';

describe('createDocsClient', () => {
  it('returns a docs_v1.Docs instance with a documents resource', () => {
    const docs = createDocsClient('fake_access_token');
    expect(docs).toBeDefined();
    expect(typeof docs.documents).toBe('object');
    expect(typeof docs.documents.get).toBe('function');
    expect(typeof docs.documents.create).toBe('function');
    expect(typeof docs.documents.batchUpdate).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createDocsClient('token_a');
    const b = createDocsClient('token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any string as accessToken (validation is API-side)', () => {
    expect(() => createDocsClient('any-token')).not.toThrow();
  });

  it('exposes batchUpdate and get on documents', () => {
    const docs = createDocsClient('token');
    expect(typeof docs.documents.batchUpdate).toBe('function');
    expect(typeof docs.documents.get).toBe('function');
    expect(typeof docs.documents.create).toBe('function');
  });
});
