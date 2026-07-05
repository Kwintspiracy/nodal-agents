// ssrf-guard.test.ts — unit tests for F-1 (audit #2): a user-supplied LLM
// baseUrl must not be usable to reach cloud metadata / link-local endpoints,
// and error responses must never reflect the remote body back to the UI.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    set: () => {},
    get: () => null,
    delete: () => {},
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

vi.mock('@nodal-agents/secrets', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
  isEncrypted: () => false,
  last4: (v: string) => v.slice(-4),
}));

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SSRF guard on LLM baseUrl (F-1)', () => {
  it('testLlmKeyAction refuses a baseUrl pointing at the cloud metadata address without ever calling fetch', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://169.254.169.254/latest',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testLlmKeyAction refuses a baseUrl targeting the GCP metadata hostname', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://metadata.google.internal',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testLlmKeyAction allows a loopback baseUrl (ollama-style local usage) through the SSRF check', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ models: [] })));

    const result = await testLlmKeyAction({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
    });

    expect(result.ok).toBe(true);
  });

  it('testLlmKeyAction allows a private-LAN baseUrl (self-hosted proxy) through the SSRF check', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:8080',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(true);
  });

  it('testLlmKeyAction never reflects the remote error body back to the UI', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('internal-secret-header-dump-that-must-not-leak', {
          status: 500,
        }),
      ),
    );

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:8080',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('internal-secret-header-dump-that-must-not-leak');
      expect(result.message).toContain('500');
    }
  });

  // ─── Round 2 (post-review PoCs) ──────────────────────────────────────────

  it('testLlmKeyAction refuses an IPv4-mapped IPv6 literal for the metadata address (mixed dotted-quad form)', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://[::ffff:169.254.169.254]/',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testLlmKeyAction refuses an IPv4-mapped IPv6 literal for the metadata address (pure hex-group form)', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      // ::ffff:a9fe:a9fe is the exact same address as ::ffff:169.254.169.254
      // (0xa9fe = 169.254 as a 16-bit group) written in pure hex-group form.
      baseUrl: 'http://[::ffff:a9fe:a9fe]/',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['100.100.100.200', '192.0.0.192'])(
    'testLlmKeyAction refuses the non-link-local cloud metadata address %s',
    async (ip) => {
      const { testLlmKeyAction } = await import('../actions.ts');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await testLlmKeyAction({
        provider: 'openai-compatible',
        baseUrl: `http://${ip}/`,
        apiKey: 'sk-test',
      });

      expect(result.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  // ─── Round 3 (post-review PoCs) ──────────────────────────────────────────

  it.each([
    ['fd00:ec2::254', 'canonical lowercase compressed form'],
    ['FD00:EC2::254', 'uppercase'],
    ['fd00:ec2:0:0:0:0:0:254', 'fully expanded form'],
  ])(
    'testLlmKeyAction refuses the AWS IMDSv2 IPv6 metadata address (%s — %s)',
    async (ip) => {
      const { testLlmKeyAction } = await import('../actions.ts');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await testLlmKeyAction({
        provider: 'openai-compatible',
        baseUrl: `http://[${ip}]/`,
        apiKey: 'sk-test',
      });

      expect(result.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('testLlmKeyAction refuses the deprecated IPv4-compatible IPv6 form of the metadata address', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      // ::a9fe:a9fe — same 169.254.169.254 payload, no `ffff` marker.
      baseUrl: 'http://[::a9fe:a9fe]/',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testLlmKeyAction refuses the NAT64/RFC6145 form of the metadata address', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://[::ffff:0:169.254.169.254]/',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testLlmKeyAction refuses the 6to4 form of the metadata address', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      // 2002::/16 + 169.254.169.254 encoded in bits 16-47 (a9fe:a9fe).
      baseUrl: 'http://[2002:a9fe:a9fe::]/',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testLlmKeyAction allows IPv6 loopback (::1)', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://[::1]:8080',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(true);
  });

  it('testLlmKeyAction allows a normal IPv6 unique-local address (private LAN)', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://[fd12:3456:789a::1]:8080',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(true);
  });

  it('testLlmKeyAction allows a public IPv6 endpoint', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      // Cloudflare public DNS over HTTPS address — a legitimate external host.
      baseUrl: 'http://[2606:4700::1]',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(true);
  });

  it('a baseUrl that passes the guard but 302-redirects to a link-local address is blocked at the redirect, not followed', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:8080',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    // Only the original request was made — the redirect Location was
    // revalidated and refused BEFORE ever being fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a baseUrl that 302-redirects to another safe (private-LAN) address IS followed', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'http://192.168.1.60:8080/v1/models' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:8080',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('listKeyModelsAction refuses a saved baseUrl pointing at link-local metadata without calling fetch', async () => {
    const { listKeyModelsAction } = await import('../actions.ts');
    const [llmKey] = await testDb
      .insert(entityLlmKeys)
      .values({
        entityId: seed.entityId,
        provider: 'openai-compatible',
        apiKey: 'test-key-enc',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
        isActive: true,
      })
      .returning();
    if (!llmKey) throw new Error('failed to seed llm key');

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listKeyModelsAction(llmKey.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
