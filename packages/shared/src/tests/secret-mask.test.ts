// secret-mask.test.ts — the one secret masker: its shapes, its field names,
// its placeholder, and what it costs.
//
// No credential-shaped literal lives in this file: every such value is
// assembled at run time by the test kit (`fake-secrets.ts`), from pieces no
// scanner reads as a credential.

import { describe, expect, it } from 'vitest';
import {
  FAKE_PREFIX,
  fakeAlnum as alnum,
  fakeAssignment,
  fakeB64 as b64,
  fakeBotToken,
  fakeCredentialUrl,
  fakeDottedToken,
  fakeHex as hex,
  fakeJwt,
  fakePrivateKeyBlock,
  fakePrivateKeyHeader,
  fakeSecret,
} from '@nodal-agents/test-kit';
import {
  REDACTED_TEXT,
  SECRET_SHAPE_NAMES,
  createStreamRedactor,
  isSecretFieldName,
  redactSecrets,
  redactSecretsInText,
} from '../index';

const shape = (...parts: string[]): string => parts.join('');

/**
 * Per shape: [a real-looking value, the part of it that must disappear, an
 * ordinary text that must come out unchanged].
 */
const SHAPE_CASES: Record<string, readonly [string, string, string]> = {
  'private key block': [
    fakePrivateKeyBlock('OPENSSH', b64(70)),
    b64(70),
    '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----',
  ],
  'bearer token': [shape('Authorization: Bearer ', b64(40)), b64(40), 'Bearer token missing'],
  'credentials in a URL': [
    fakeCredentialUrl('postgresql', 'admin', 'S3cretPass', 'db.internal/prod'),
    'admin:S3cretPass',
    'https://example.com:8080/path?q=1',
  ],
  'JSON web token': [
    fakeJwt([b64(20), b64(30), b64(43)]),
    b64(30),
    'a lone header eyJhbGciOiJIUzI1NiJ9 is not a token',
  ],
  'sk- key': [
    fakeSecret('openaiProject', b64(48)),
    b64(48),
    '<div class="sk-toggleable__content-fitted sk-estimator-doc-link">',
  ],
  'Stripe key': [fakeSecret('stripeLive', alnum(24)), alnum(24), 'call sk_test_helper() first'],
  'GitHub token': [fakeSecret('github', alnum(36)), alnum(36), 'push to gh_pages and ghp_ alone'],
  'GitHub fine-grained token': [
    fakeSecret('githubFineGrained', shape(alnum(22), '_', alnum(59))),
    alnum(22),
    'see github_pat_docs',
  ],
  'GitLab token': [fakeSecret('gitlab', alnum(20)), alnum(20), 'a glpat-example'],
  'Slack token': [
    fakeSecret('slackBot', shape('102938475610-564738291012-', alnum(24))),
    alnum(24),
    'xoxo-hugs-and-kisses to everyone',
  ],
  'Slack app token': [
    fakeSecret('slackApp', shape('1-', 'A0BG', alnum(11), '-', hex(64))),
    hex(64),
    'see xapp-config for details',
  ],
  'Google API key': [
    fakeSecret('google', shape('Sy', b64(33))),
    b64(33),
    'AIzawesome is not a key',
  ],
  'AWS access key id': [
    fakeSecret('aws', 'Q3EXAMPLE7XYZ2W4'),
    'Q3EXAMPLE7XYZ2W4',
    'ASIA-PACIFIC region',
  ],
  'Telegram bot token': [
    fakeBotToken('7012345678', shape('AAH', b64(32))),
    b64(32),
    'logged at 20261127:120000 today',
  ],
  'Discord bot token': [
    fakeDottedToken('MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', alnum(38)),
    alnum(38),
    'the class org.example.MyVeryLongClassNameForTesting',
  ],
  'Cogni key': [fakeSecret('cogni', alnum(22)), alnum(22), 'a cog_wheel turns'],
  'Tavily key': [fakeSecret('tavily', shape('dev-', alnum(32))), alnum(32), 'read tvly-docs'],
  'Linear key': [fakeSecret('linear', alnum(40)), alnum(40), 'read lin_api_docs'],
  'Airtable token': [
    fakeSecret('airtable', shape(alnum(14), '.', hex(64))),
    hex(64),
    'a pattern.match call',
  ],
  'Nodal device token': [fakeSecret('nodalDevice', b64(43)), b64(43), 'an ndv_x id'],
  'npm token': [
    fakeSecret('npm', alnum(36)),
    alnum(36),
    'npm_config_registry=https://registry.npmjs.org',
  ],
  'Hugging Face token': [fakeSecret('huggingFace', alnum(34)), alnum(34), 'call hf_hub_download()'],
  'secret environment variable': [
    fakeAssignment('DB_PASSWORD', 'hunter2-long'),
    'hunter2-long',
    'MAX_TOKENS=4096 and TOKEN=$TOKEN',
  ],
  'secret query parameter': [
    shape('https://api.example.com/v1?', fakeAssignment('api_key', 'abcd1234efgh')),
    'abcd1234efgh',
    'https://api.example.com/v1?max_tokens=100&page=2',
  ],
  'secret quoted field': [
    shape('{"pass', 'word": "', 'correct horse battery', '"}'),
    'correct horse battery',
    '{"token_type": "bearer", "tokens": 12}',
  ],
};

describe('every shape hides a real-looking value and leaves ordinary text alone @cap:suivre-execution/moteur', () => {
  it('every shape of the list has a case here', () => {
    expect(Object.keys(SHAPE_CASES).sort()).toEqual([...SECRET_SHAPE_NAMES].sort());
  });

  for (const [name, [value, hidden, ordinary]] of Object.entries(SHAPE_CASES)) {
    it(`${name}: masked`, () => {
      const out = redactSecretsInText(`before ${value} after`);
      expect(out).not.toContain(hidden);
      expect(out).toContain(REDACTED_TEXT);
      expect(out.startsWith('before ')).toBe(true);
      expect(out.endsWith(' after')).toBe(true);
    });

    it(`${name}: ordinary text not masked`, () => {
      expect(redactSecretsInText(ordinary)).toBe(ordinary);
    });
  }

  it('the parts a shape keeps stay readable', () => {
    expect(
      redactSecretsInText(
        fakeCredentialUrl('postgresql', 'admin', 'S3cretPass', 'db.internal/prod'),
      ),
    ).toBe(`postgresql://${REDACTED_TEXT}@db.internal/prod`);
    expect(redactSecretsInText(shape('Authorization: Bearer ', b64(40)))).toBe(
      `Authorization: Bearer ${REDACTED_TEXT}`,
    );
    expect(redactSecretsInText(fakeAssignment('OPENAI_API_KEY', 'anything-at-all'))).toBe(
      `OPENAI_API_KEY=${REDACTED_TEXT}`,
    );
  });

  it('the placeholder is English and matches no shape: masking twice changes nothing', () => {
    expect(REDACTED_TEXT).toBe('[secret hidden]');
    const raw = Object.values(SHAPE_CASES)
      .map(([value]) => value)
      .join('\n');
    const once = redactSecretsInText(raw);
    expect(redactSecretsInText(once)).toBe(once);
    const r = createStreamRedactor();
    expect(r.push(once) + r.flush()).toBe(once);
  });

  it('ordinary output stays byte-identical', () => {
    const innocents = [
      'Le job 09935f36-74ec-4d3f-a6ee-29ae5dfbcb8c est terminé.',
      'commit b2d0577 — 42 fichiers, 1234 insertions',
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'https://raw.githubusercontent.com/example/project/main/README.md',
      'def connect(user=user, password=password): return token',
    ];
    for (const s of innocents) expect(redactSecretsInText(s)).toBe(s);
  });
});

describe('field names @cap:suivre-execution/moteur', () => {
  it('a compound name is judged by its last words', () => {
    for (const n of [
      'apiKey',
      'api_key',
      'x-api-key',
      'APIKey',
      'OPENAI_API_KEY',
      'botToken',
      'accessToken',
      'refresh_token',
      'secretKey',
      'clientSecret',
      'dbPassword',
      'privateKey',
      'credentials',
      'Authorization',
      'connectionString',
    ]) {
      expect([n, isSecretFieldName(n)]).toEqual([n, true]);
    }
    for (const n of [
      'tokenCount',
      'maxTokens',
      'keyword',
      'passwordHint',
      'secretName',
      'key',
      'command',
      'content',
      'url',
    ]) {
      expect([n, isSecretFieldName(n)]).toEqual([n, false]);
    }
  });
});

describe('structured values: names AND shapes on every string @cap:suivre-execution/moteur', () => {
  const KEY = fakeSecret('anthropic', b64(60));

  it('a secret under an innocuous field name is masked by its shape', () => {
    const out = redactSecrets({
      command: shape("curl -H 'Authorization: Bearer ", b64(40), "' https://api.example.com"),
      args: [
        '-y',
        'server-postgres',
        fakeCredentialUrl('postgresql', 'admin', 'S3cretPass', 'db/prod'),
      ],
      content: `${fakeAssignment('OPENAI_API_KEY', KEY)}\n`,
    }) as { command: string; args: string[]; content: string };
    expect(out.command).toBe(
      `curl -H 'Authorization: Bearer ${REDACTED_TEXT}' https://api.example.com`,
    );
    expect(out.args[2]).toBe(`postgresql://${REDACTED_TEXT}@db/prod`);
    expect(out.content).not.toContain(b64(60));
  });

  it('an innocuous value under a secret field name is masked by its name', () => {
    const out = redactSecrets({
      name: 'notion',
      apiKey: 'plain-value-42',
      botToken: 'x',
      dbPassword: 7,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      name: 'notion',
      apiKey: REDACTED_TEXT,
      botToken: REDACTED_TEXT,
      dbPassword: REDACTED_TEXT,
    });
  });

  it('an env map keeps its variable names and hides every value', () => {
    expect(
      redactSecrets({
        command: 'npx server',
        env: { API_TOKEN: 'tok', OTHER: 'also', NONE: null },
      }),
    ).toEqual({
      command: 'npx server',
      env: { API_TOKEN: REDACTED_TEXT, OTHER: REDACTED_TEXT, NONE: null },
    });
  });

  it('walks nested arrays and objects, and keeps the structure', () => {
    const input = {
      outer: { inner: [{ token: 'x', note: `see ${KEY}` }, 3, true, null], safe: 'ok' },
      list: [[{ secretKey: { deep: 1 } }], 'plain'],
      tokenCount: 42,
    };
    expect(redactSecrets(input)).toEqual({
      outer: {
        inner: [{ token: REDACTED_TEXT, note: `see ${REDACTED_TEXT}` }, 3, true, null],
        safe: 'ok',
      },
      list: [[{ secretKey: REDACTED_TEXT }], 'plain'],
      tokenCount: 42,
    });
    // A copy: the value handed to execution is untouched.
    expect(input.outer.inner[0]).toEqual({ token: 'x', note: `see ${KEY}` });
  });

  it('a string alone is the whole-text masker, and primitives pass', () => {
    expect(redactSecrets(`k ${KEY}`)).toBe(redactSecretsInText(`k ${KEY}`));
    expect(redactSecrets(7)).toBe(7);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets({ apiKey: null })).toEqual({ apiKey: null });
  });
});

describe('cost: linear on the worst inputs for the patterns @cap:suivre-execution/moteur', () => {
  // Each input repeats the beginning of a shape without ever completing it,
  // or runs one of its classes to the edge of a bound: what makes a
  // backtracking pattern pay most. A quadratic pattern takes minutes here.
  const N = 200_000;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const WORST: Record<string, string> = {
    'private key headers, never closed': fill(`${fakePrivateKeyHeader('RSA')}\nAAAA`),
    'one private key header, a long body': `${fakePrivateKeyHeader('RSA')}\n${fill('A')}`,
    'sk- again and again': fill(FAKE_PREFIX.sk),
    'Bearer and spaces': fill('Bearer                 x'),
    'word edges everywhere': fill('a-'),
    'upper-case names': fill('A_PASSWORD '),
    'quoted names': fill('"password'),
    'query names': fill('?token='),
    'URL schemes': fill('http://a:'),
    'digits and colons': fill('123456789:'),
    'JWT headers': fill('eyJ'),
    'ordinary prose': fill('The quick brown fox jumps over the lazy dog. '),
  };

  for (const [label, text] of Object.entries(WORST)) {
    it(`${label}: 200 kB, whole and streamed`, () => {
      const t0 = performance.now();
      const whole = redactSecretsInText(text);
      const t1 = performance.now();
      const r = createStreamRedactor();
      let out = '';
      for (let i = 0; i < text.length; i += 4) out += r.push(text.slice(i, i + 4));
      out += r.flush();
      const t2 = performance.now();
      expect(out).toBe(whole);
      expect(t1 - t0).toBeLessThan(3_000);
      expect(t2 - t1).toBeLessThan(6_000);
    }, 30_000);
  }
});
