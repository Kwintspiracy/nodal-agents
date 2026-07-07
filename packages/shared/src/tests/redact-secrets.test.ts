import { describe, it, expect } from 'vitest';
import { redactSecretsForAudit } from '../redact-secrets';

describe('redactSecretsForAudit (NOUVEAU-1)', () => {
  it('masks a top-level apiKey but keeps non-secret siblings', () => {
    const out = redactSecretsForAudit({ name: 'notion', apiKey: 'sk-abc123' }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe('***');
    expect(out.name).toBe('notion');
  });

  it('masks every stdio env value but keeps the keys visible', () => {
    const out = redactSecretsForAudit({
      command: 'npx server',
      env: { API_TOKEN: 'tok-real', OTHER: 'also-secret' },
    }) as { command: string; env: Record<string, string> };
    expect(out.command).toBe('npx server'); // command is not a secret field
    expect(out.env).toEqual({ API_TOKEN: '***', OTHER: '***' });
  });

  it('matches common secret field names, case-insensitive, without catching innocents', () => {
    const out = redactSecretsForAudit({
      api_key: 'a',
      accessToken: 'b',
      refresh_token: 'c',
      password: 'd',
      clientSecret: 'e',
      keyword: 'not-secret',
      tokenCount: 42,
    }) as Record<string, unknown>;
    expect(out.api_key).toBe('***');
    expect(out.accessToken).toBe('***');
    expect(out.refresh_token).toBe('***');
    expect(out.password).toBe('***');
    expect(out.clientSecret).toBe('***');
    expect(out.keyword).toBe('not-secret');
    expect(out.tokenCount).toBe(42);
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSecretsForAudit({
      outer: { inner: { apiKey: 'deep' }, safe: 'ok' },
      list: [{ token: 'x' }, { note: 'y' }],
    }) as {
      outer: { inner: { apiKey: string }; safe: string };
      list: Array<Record<string, unknown>>;
    };
    expect(out.outer.inner.apiKey).toBe('***');
    expect(out.outer.safe).toBe('ok');
    expect(out.list[0]!.token).toBe('***');
    expect(out.list[1]!.note).toBe('y');
  });

  it('leaves primitives and null untouched', () => {
    expect(redactSecretsForAudit('plain')).toBe('plain');
    expect(redactSecretsForAudit(7)).toBe(7);
    expect(redactSecretsForAudit(null)).toBe(null);
    expect(redactSecretsForAudit({ apiKey: null })).toEqual({ apiKey: null });
  });
});
