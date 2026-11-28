import { describe, it, expect } from 'vitest';
import { REDACTED_TEXT, redactSecrets } from '../redact-secrets';

describe('redactSecrets, by field name (NOUVEAU-1)', () => {
  it('masks a top-level apiKey but keeps non-secret siblings', () => {
    const out = redactSecrets({ name: 'notion', apiKey: 'sk-abc123' }) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED_TEXT);
    expect(out.name).toBe('notion');
  });

  it('masks every stdio env value but keeps the keys visible', () => {
    const out = redactSecrets({
      command: 'npx server',
      env: { API_TOKEN: 'tok-real', OTHER: 'also-secret' },
    }) as { command: string; env: Record<string, string> };
    expect(out.command).toBe('npx server'); // command is not a secret field
    expect(out.env).toEqual({ API_TOKEN: REDACTED_TEXT, OTHER: REDACTED_TEXT });
  });

  it('matches common secret field names, case-insensitive, without catching innocents', () => {
    const out = redactSecrets({
      api_key: 'a',
      accessToken: 'b',
      refresh_token: 'c',
      password: 'd',
      clientSecret: 'e',
      keyword: 'not-secret',
      tokenCount: 42,
    }) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED_TEXT);
    expect(out.accessToken).toBe(REDACTED_TEXT);
    expect(out.refresh_token).toBe(REDACTED_TEXT);
    expect(out.password).toBe(REDACTED_TEXT);
    expect(out.clientSecret).toBe(REDACTED_TEXT);
    expect(out.keyword).toBe('not-secret');
    expect(out.tokenCount).toBe(42);
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSecrets({
      outer: { inner: { apiKey: 'deep' }, safe: 'ok' },
      list: [{ token: 'x' }, { note: 'y' }],
    }) as {
      outer: { inner: { apiKey: string }; safe: string };
      list: Array<Record<string, unknown>>;
    };
    expect(out.outer.inner.apiKey).toBe(REDACTED_TEXT);
    expect(out.outer.safe).toBe('ok');
    expect(out.list[0]!.token).toBe(REDACTED_TEXT);
    expect(out.list[1]!.note).toBe('y');
  });

  it('leaves primitives and null untouched', () => {
    expect(redactSecrets('plain')).toBe('plain');
    expect(redactSecrets(7)).toBe(7);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets({ apiKey: null })).toEqual({ apiKey: null });
  });
});
