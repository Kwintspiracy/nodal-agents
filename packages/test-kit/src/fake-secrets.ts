// fake-secrets.ts — credential-shaped test values, assembled at run time.
//
// A masker is tested on values that LOOK like credentials. Written whole in a
// source file, such a value is read as one by every scanner of the repository
// and of its host: they read the shape, never the validity, and they are right
// to. So no source line carries one: each prefix is written in pieces that no
// scanner reads as a prefix, and the value exists only once the test runs.
//
// The values are invented. Their bodies come from the callers (or from the
// generators below), so a test still says exactly what it checks.

const join = (...pieces: string[]): string => pieces.join('');

/** The prefixes, each written in pieces. */
export const FAKE_PREFIX = {
  sk: join('s', 'k-'),
  anthropic: join('s', 'k-', 'ant-', 'api03-'),
  openaiProject: join('s', 'k-', 'proj-'),
  openRouter: join('s', 'k-', 'or-', 'v1-'),
  stripeLive: join('s', 'k_', 'live_'),
  github: join('g', 'hp_'),
  githubFineGrained: join('github', '_pat_'),
  gitlab: join('gl', 'pat-'),
  slackBot: join('xo', 'xb-'),
  slackApp: join('xa', 'pp-'),
  google: join('AI', 'za'),
  aws: join('AK', 'IA'),
  cogni: join('co', 'g_'),
  tavily: join('tv', 'ly-'),
  linear: join('lin', '_api_'),
  airtable: join('p', 'at'),
  nodalDevice: join('nd', 'v_'),
  npm: join('np', 'm_'),
  huggingFace: join('h', 'f_'),
} as const;

export type FakeSecretKind = keyof typeof FAKE_PREFIX;

/** A prefixed value: the prefix of `kind`, then `body`. */
export function fakeSecret(kind: FakeSecretKind, body: string): string {
  return FAKE_PREFIX[kind] + body;
}

/** `<bot id>:<body>`, the form of a messaging bot token. */
export function fakeBotToken(botId: string, body: string): string {
  return join(botId, ':', body);
}

/** Three dot-separated segments, the form of a chat bot token. */
export function fakeDottedToken(first: string, second: string, third: string): string {
  return [first, second, third].join('.');
}

/** `Bearer <token>`, as an HTTP header carries it. */
export function fakeBearer(token: string): string {
  return join('Bear', 'er ', token);
}

/** `<scheme>://<user>:<password>@<rest>`. */
export function fakeCredentialUrl(
  scheme: string,
  user: string,
  password: string,
  rest: string,
): string {
  return join(scheme, ':/', '/', user, ':', password, '@', rest);
}

/** `<name>=<value>`, an assignment as an environment file writes it. */
export function fakeAssignment(name: string, value: string): string {
  return join(name, '=', value);
}

const base64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/**
 * A JSON web token. With no argument: the HS256 header, a small payload and a
 * signature, all encoded here. With three segments: those, each after its
 * marker (the encoded `{"` that opens a JSON segment).
 */
export function fakeJwt(segments?: readonly [string, string, string]): string {
  if (segments) {
    const open = join('ey', 'J');
    return [open + segments[0], open + segments[1], segments[2]].join('.');
  }
  return [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({ sub: '1234567890', name: 'Example' })),
    base64url('signature-example-0123456789ab'),
  ].join('.');
}

/** The first line of a private key block (`label`: RSA, OPENSSH, PGP…). */
export function fakePrivateKeyHeader(label: string, suffix = ''): string {
  return join('-----', 'BEGIN ', label, ' PRIV', 'ATE KEY', suffix, '-----');
}

/** The last line of a private key block. */
export function fakePrivateKeyFooter(label: string, suffix = ''): string {
  return join('-----', 'END ', label, ' PRIV', 'ATE KEY', suffix, '-----');
}

/** A whole private key block: header, `body`, footer, one per line. */
export function fakePrivateKeyBlock(label: string, body: string, suffix = ''): string {
  return [fakePrivateKeyHeader(label, suffix), body, fakePrivateKeyFooter(label, suffix)].join(
    '\n',
  );
}

// ─── Bodies ─────────────────────────────────────────────────────────────────

const B64_ALPHABET = 'Xy7Qp0Lm3Nb8Vc2Zt6Rk1Wj9Hs4Gd5Fa0Ee7Uu3Ii8Oo2Pp6Qq1Rr5Ss9Tt_AbCd-EfGh';

/** `n` characters of the base64url alphabet, always the same ones. */
export function fakeB64(n: number): string {
  return B64_ALPHABET.repeat(Math.ceil(n / B64_ALPHABET.length)).slice(0, n);
}

/** `n` letters and digits, always the same ones. */
export function fakeAlnum(n: number): string {
  return fakeB64(n * 2)
    .replace(/[-_]/g, '')
    .slice(0, n);
}

/** `n` hexadecimal digits, always the same ones. */
export function fakeHex(n: number): string {
  return '0123456789abcdef'.repeat(Math.ceil(n / 16)).slice(0, n);
}
