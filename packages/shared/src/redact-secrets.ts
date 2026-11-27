// redact-secrets.ts — THE definition of what is hidden before a text is shown.
//
// One list of value shapes, one list of secret field names, one placeholder.
// Every form of the masker is that definition applied:
//
//   - `redactSecretsInText(text)`  a whole string, by shape;
//   - `redactSecrets(value)`       a structured value: a field whose NAME says
//                                  secret is hidden whole, and EVERY string,
//                                  at any depth, is masked by shape;
//   - `createStreamRedactor()`     a text that arrives in chunks.
//
// The stream form is derived, not written beside: it runs the same scanner as
// the whole-text form, and holds back exactly the tail of what it has seen
// that more input could still turn into (or extend) a masked value. Its
// contract is a property, tested in `tests/secret-mask-stream.test.ts`: for
// any text and any cutting of it into chunks, the chunks it emits, end to end,
// equal `redactSecretsInText` of the whole text.
//
// How the hold-back is derived
// ----------------------------
// Each shape is written as a sequence of PARTS (a character class repeated
// between two bounds, a literal, a word edge). From that one description two
// regular expressions are compiled:
//
//   - the FULL one, which finds a value;
//   - the PREFIX one, which matches at a position when the text from there to
//     the END of what has arrived is the beginning of some value of the shape
//     (a value cut by the end of the chunk, a complete value that could still
//     grow, or a word edge that the next character decides).
//
// A position the prefix expression matches is OPEN: nothing from there is
// released. A full match that starts before the first open position cannot
// change with more input (any path of the engine that would have needed a
// character past the end is, by construction, a prefix path), so it is
// masked and released. Everything else before the first open position can
// never be part of a value, and flows at once, whatever the language, spaces
// or not.
//
// Bounds
// ------
// Every repetition has an upper bound. That keeps every pattern linear (no
// nested unbounded repetition, no run whose failure costs more than its
// bound), and it bounds what the stream form can hold back: the longest shape
// (a private key block) is the most it ever waits for.
//
// Where the masked copy goes
// --------------------------
// This returns COPIES. The real values keep flowing to execution: the runner
// re-reads stored messages to resume a job, and an approved call is re-run
// from its stored input. Callers mask the copy that is shown or recorded for a
// person, never the value handed to execution.

/** What a hidden value is replaced with: it says a secret was hidden, never which. */
export const REDACTED_TEXT = '[secret hidden]';

// ─── The parts a shape is written with ──────────────────────────────────────

interface Part {
  /** Matches the part. */
  readonly full: string;
  /** Matches any beginning of the part, the empty one included. */
  readonly prefix: string;
}

/** A character class (or a one-character unit) repeated `min` to `max` times. */
function run(unit: string, min: number, max: number): Part {
  return { full: `${unit}{${min},${max}}`, prefix: `${unit}{0,${max}}` };
}

/** One character of a class, exactly once. */
function one(unit: string): Part {
  return { full: unit, prefix: `${unit}?` };
}

/** A word edge (`\b`): what decides it may not have arrived yet. */
const EDGE: Part = { full: '\\b', prefix: '' };

/** A sequence of parts, as one part. */
function seq(parts: readonly Part[]): Part {
  const full = parts.map((p) => p.full).join('');
  let prefix = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    prefix = `(?:${p.prefix}|${p.full}${prefix})`;
  }
  return { full, prefix };
}

/** One of several sequences. */
function oneOf(choices: readonly Part[]): Part {
  return {
    full: `(?:${choices.map((c) => c.full).join('|')})`,
    prefix: `(?:${choices.map((c) => c.prefix).join('|')})`,
  };
}

const escapeChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** A literal string; `ci` makes its letters case-insensitive. */
function lit(text: string, ci = false): Part {
  return seq(
    [...text].map((c) => {
      const lower = c.toLowerCase();
      const upper = c.toUpperCase();
      return one(ci && lower !== upper ? `[${lower}${upper}]` : escapeChar(c));
    }),
  );
}

// ─── Secret field names ─────────────────────────────────────────────────────

/**
 * A field is secret when the WORDS of its name end with one of these.
 *
 * Names are split into words at case changes and separators (`botToken`,
 * `OPENAI_API_KEY`, `x-api-key`, `APIKey`), so a compound name is judged by
 * its last words: `dbPassword`, `secretKey`, `clientSecret` are secret;
 * `tokenCount`, `maxTokens`, `keyword`, `passwordHint`, `secretName` are not.
 */
const SECRET_NAME_ENDINGS: ReadonlyArray<readonly string[]> = [
  ['password'],
  ['passwd'],
  ['passphrase'],
  ['secret'],
  ['token'],
  ['credential'],
  ['credentials'],
  ['authorization'],
  ['apikey'],
  ['api', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
  ['access', 'key'],
  ['signing', 'key'],
  ['encryption', 'key'],
  ['connection', 'string'],
];

/**
 * A field whose value is a set of environment variables (an MCP server's
 * `env`): every value is hidden, the variable names stay visible so a reader
 * still sees WHICH are set.
 */
const SECRET_MAP_FIELDS: ReadonlySet<string> = new Set(['env']);

function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

/** Does this field name say its value is a secret? */
export function isSecretFieldName(name: string): boolean {
  const words = wordsOf(name);
  return SECRET_NAME_ENDINGS.some(
    (ending) =>
      ending.length <= words.length &&
      ending.every((w, i) => words[words.length - ending.length + i] === w),
  );
}

/**
 * The same endings, as they are written in a text: `API_KEY` or `APIKEY`
 * (environment, upper case), or `api_key`, `api-key`, `apiKey`, `ApiKey`
 * (`ci`, any case).
 */
function endingPart(ci: boolean): Part {
  return oneOf(
    SECRET_NAME_ENDINGS.map((words) =>
      seq(
        words.flatMap((w, i) => {
          const word = lit(ci ? w : w.toUpperCase(), ci);
          return i === 0 ? [word] : [run(ci ? '[_-]' : '_', 0, 1), word];
        }),
      ),
    ),
  );
}

// ─── The shapes ─────────────────────────────────────────────────────────────

interface Shape {
  readonly name: string;
  /** Kept as it is, before the hidden part. */
  readonly lead?: readonly Part[];
  /** Hidden. */
  readonly body: readonly Part[];
  /** Kept as it is, after the hidden part. */
  readonly tail?: readonly Part[];
}

/** Characters of a base64url token. */
const B64URL = '[A-Za-z0-9_-]';
const ALNUM = '[A-Za-z0-9]';
/** A value written after `=`: not a quote, a space, a bracket or a separator. */
const ASSIGNED_FIRST = '[^\\s"\'`$<>\\[\\]{}(),;&|]';
const ASSIGNED_REST = '[^\\s"\'`<>\\[\\]{}(),;&|]';
/** A name written before the secret word it ends with. */
const NAME_HEAD = '[A-Za-z0-9_.-]';

/**
 * Every shape, with what it matches and one ordinary text it must not match
 * (`tests/secret-mask.test.ts` checks both, shape by shape). Each one must be
 * specific enough that a match is a credential and not a coincidence: a
 * masker that hides ordinary text makes the text unusable to whoever reads it.
 *
 * Order matters only between shapes that can start at the same character: the
 * first that matches there wins.
 */
const SHAPES: readonly Shape[] = [
  {
    // A private key block (PEM, OpenSSH, PGP), body included.
    // Not: a certificate (`-----BEGIN CERTIFICATE-----`), which is public.
    name: 'private key block',
    body: [
      lit('-----BEGIN'),
      run('[^-]', 0, 40),
      lit('PRIVATE KEY'),
      run('[^-]', 0, 6),
      lit('-----'),
      run('(?:[^-]|-(?!-))', 0, 16384),
      lit('-----END'),
      run('[^-]', 0, 40),
      lit('PRIVATE KEY'),
      run('[^-]', 0, 6),
      lit('-----'),
    ],
  },
  {
    // `Bearer <token>` in a header or a command; the word stays visible.
    // Not: "Bearer token missing".
    name: 'bearer token',
    lead: [EDGE, one('[Bb]'), lit('earer'), run('\\s', 1, 16)],
    body: [run('[A-Za-z0-9._~+/=-]', 20, 8192)],
  },
  {
    // The user and password written in a URL, between `://` and `@`; the
    // scheme and the host stay visible.
    // Not: `https://example.com:8080/path`, a port is not a password.
    name: 'credentials in a URL',
    lead: [EDGE, one('[A-Za-z]'), run('[A-Za-z0-9+.-]', 1, 20), lit('://')],
    body: [run('[^\\s:/@\\[\\]]', 1, 256), lit(':'), run('[^\\s/@\\[\\]]', 1, 256)],
    tail: [lit('@')],
  },
  {
    // A JSON Web Token: header, payload, signature.
    // Not: a lone header `eyJhbGciOiJIUzI1NiJ9` (no payload, no signature).
    name: 'JSON web token',
    body: [
      EDGE,
      lit('eyJ'),
      run(B64URL, 8, 4096),
      lit('.eyJ'),
      run(B64URL, 8, 8192),
      lit('.'),
      run(B64URL, 8, 4096),
    ],
  },
  {
    // OpenAI, Anthropic, OpenRouter, DeepSeek keys: `sk-` and at least 32
    // characters of the key alphabet.
    // Not: scikit-learn's markup classes (`sk-toggleable__content-fitted`).
    name: 'sk- key',
    body: [EDGE, lit('sk-'), run(B64URL, 32, 256)],
  },
  {
    // Stripe secret and restricted keys (`sk_live_`, `rk_test_`).
    // Not: `sk_test_helper`, too short to be a key.
    name: 'Stripe key',
    body: [
      EDGE,
      one('[rs]'),
      lit('k_'),
      oneOf([lit('live'), lit('test')]),
      lit('_'),
      run(ALNUM, 16, 256),
    ],
  },
  {
    // GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`).
    // Not: `gh_pages`.
    name: 'GitHub token',
    body: [EDGE, lit('gh'), one('[pousr]'), lit('_'), run(ALNUM, 16, 256)],
  },
  {
    // GitHub fine-grained tokens (`github_pat_`).
    // Not: `github_pat_docs`.
    name: 'GitHub fine-grained token',
    body: [EDGE, lit('github_pat_'), run('[A-Za-z0-9_]', 22, 256)],
  },
  {
    // GitLab personal tokens (`glpat-`).
    // Not: `glpat-example`.
    name: 'GitLab token',
    body: [EDGE, lit('glpat-'), run(B64URL, 20, 64)],
  },
  {
    // Slack bot, user and legacy tokens: `xox?-` then the workspace digits.
    // Not: "xoxo-hugs-and-kisses".
    name: 'Slack token',
    body: [EDGE, lit('xox'), one('[abposr]'), lit('-'), one('\\d'), run('[A-Za-z0-9-]', 9, 256)],
  },
  {
    // Slack app tokens (`xapp-1-…`).
    // Not: `xapp-config`.
    name: 'Slack app token',
    body: [EDGE, lit('xapp-'), one('\\d'), lit('-'), run('[A-Za-z0-9-]', 10, 256)],
  },
  {
    // Google API keys (`AIza` and 35 characters).
    // Not: "AIzawesome".
    name: 'Google API key',
    body: [EDGE, lit('AIza'), run(B64URL, 30, 256)],
  },
  {
    // AWS access key ids (`AKIA`, `ASIA` and 16 characters).
    // Not: "ASIA-PACIFIC".
    name: 'AWS access key id',
    body: [EDGE, lit('A'), one('[KS]'), lit('IA'), run('[A-Z0-9]', 16, 16), EDGE],
  },
  {
    // Telegram bot tokens: the bot id, a colon, 35 characters.
    // Not: a timestamp `20261127:120000`.
    name: 'Telegram bot token',
    body: [EDGE, run('\\d', 8, 12), lit(':'), run(B64URL, 30, 256)],
  },
  {
    // Discord bot tokens: three dot-separated base64url segments.
    // Not: a dotted name `org.example.MyClass`.
    name: 'Discord bot token',
    body: [
      EDGE,
      run(B64URL, 23, 28),
      lit('.'),
      run(B64URL, 6, 6),
      lit('.'),
      run(B64URL, 27, 40),
      EDGE,
    ],
  },
  {
    // Cogni keys (`cog_`), from the MCP catalogue.
    // Not: `cog_wheel`.
    name: 'Cogni key',
    body: [EDGE, lit('cog_'), run(ALNUM, 16, 256)],
  },
  {
    // Tavily keys (`tvly-`, `tvly-dev-`).
    // Not: `tvly-docs`.
    name: 'Tavily key',
    body: [EDGE, lit('tvly-'), run('[A-Za-z0-9-]', 16, 256)],
  },
  {
    // Linear keys (`lin_api_`), from the MCP catalogue.
    // Not: `lin_api_docs`.
    name: 'Linear key',
    body: [EDGE, lit('lin_api_'), run(ALNUM, 16, 256)],
  },
  {
    // Airtable personal access tokens (`pat` + 14, a dot, 64 hex), from the
    // MCP catalogue.
    // Not: "pattern.match".
    name: 'Airtable token',
    body: [EDGE, lit('pat'), run(ALNUM, 14, 14), lit('.'), run('[a-f0-9]', 64, 64), EDGE],
  },
  {
    // A Nodal device token (`ndv_` and 43 base64url characters).
    // Not: `ndv_x`.
    name: 'Nodal device token',
    body: [EDGE, lit('ndv_'), run(B64URL, 43, 64)],
  },
  {
    // npm access tokens (`npm_` and 36 characters).
    // Not: `npm_config_registry`.
    name: 'npm token',
    body: [EDGE, lit('npm_'), run(ALNUM, 36, 64)],
  },
  {
    // Hugging Face tokens (`hf_` and 34 characters).
    // Not: `hf_hub_download`.
    name: 'Hugging Face token',
    body: [EDGE, lit('hf_'), run(ALNUM, 30, 64)],
  },
  {
    // An environment assignment whose name ends with a secret field name
    // (a `DB_PASSWORD` or an `OPENAI_API_KEY` given a value after `=`); the
    // name stays visible.
    // Not: `MAX_TOKENS=4096`, `TOKEN=$TOKEN` (a reference, not a value).
    name: 'secret environment variable',
    lead: [EDGE, run('[A-Z0-9_]', 0, 64), endingPart(false), lit('='), run('["\']', 0, 1)],
    body: [one(ASSIGNED_FIRST), run(ASSIGNED_REST, 0, 1023)],
  },
  {
    // A URL query parameter whose name ends with a secret field name
    // (an `api_key` or an `access_token` after `?` or `&`).
    // Not: `?max_tokens=100&page=2`.
    name: 'secret query parameter',
    lead: [one('[?&]'), run(NAME_HEAD, 0, 64), endingPart(true), lit('=')],
    body: [run('[^\\s&#"\'<>\\[\\]]', 4, 1024)],
  },
  {
    // A quoted key and value whose key ends with a secret field name
    // (a quoted `password` or `apiKey` key, then a colon and a quoted value),
    // as JSON or a dict prints it.
    // Not: `"token_type": "bearer"`, `"tokens": 12`.
    name: 'secret quoted field',
    lead: [
      one('["\']'),
      run(NAME_HEAD, 0, 64),
      endingPart(true),
      one('["\']'),
      run('\\s', 0, 4),
      lit(':'),
      run('\\s', 0, 4),
      one('["\']'),
    ],
    body: [one('[^"\'\\\\\\r\\n\\[]'), run('[^"\'\\\\\\r\\n]', 0, 1023)],
    tail: [one('["\']')],
  },
];

/** The names of the shapes, for the tests that check each one. */
export const SECRET_SHAPE_NAMES: readonly string[] = SHAPES.map((s) => s.name);

// One expression for all shapes: three groups each (kept, hidden, kept).
const FULL = new RegExp(
  SHAPES.map(
    (s) => `(${seq(s.lead ?? []).full})(${seq(s.body).full})(${seq(s.tail ?? []).full})`,
  ).join('|'),
  'g',
);
const PREFIX = new RegExp(
  `(?:${SHAPES.map((s) => seq([...(s.lead ?? []), ...s.body, ...(s.tail ?? [])]).prefix).join('|')})$`,
  'g',
);

function masked(m: RegExpExecArray): string {
  for (let i = 0; i < SHAPES.length; i++) {
    if (m[3 * i + 2] !== undefined) return `${m[3 * i + 1]}${REDACTED_TEXT}${m[3 * i + 3]}`;
  }
  // The expression is the union of the shapes: a match is one of them.
  throw new Error('secret mask: a match that is none of the shapes');
}

/** The first position from `from` where more input could still make or grow a value. */
function firstOpen(buffer: string, from: number): number {
  PREFIX.lastIndex = from;
  const m = PREFIX.exec(buffer);
  return m === null ? buffer.length : m.index;
}

/**
 * The one scanner. From `from`, mask every value of `buffer` and stop at the
 * first open position (`final`: there is no more input, nothing is open).
 * Returns the masked text released and where the release stopped.
 */
function scan(buffer: string, from: number, final: boolean): { out: string; stop: number } {
  let out = '';
  let at = from;
  let open = final ? buffer.length : firstOpen(buffer, from);
  while (at < open) {
    FULL.lastIndex = at;
    const m = FULL.exec(buffer);
    if (m === null || m.index >= open) break;
    out += buffer.slice(at, m.index) + masked(m);
    at = m.index + m[0].length;
    if (open < at) open = firstOpen(buffer, at);
  }
  const stop = Math.max(at, open);
  return { out: out + buffer.slice(at, stop), stop };
}

/**
 * Mask every credential-shaped value in a text.
 *
 * Returns the text unchanged when nothing matches.
 */
export function redactSecretsInText(text: string): string {
  const { out } = scan(text, 0, true);
  return out === text ? text : out;
}

/**
 * Mask a structured value: a field whose name says secret is hidden whole,
 * and every string, at any depth, is masked by shape (a command line, a file
 * content, a URL in a field are strings like any other).
 *
 * Returns a copy; numbers, booleans, `null` and `undefined` are returned as
 * they are, objects stay objects and arrays stay arrays.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretFieldName(k)) {
        out[k] = v == null ? v : REDACTED_TEXT;
      } else if (
        SECRET_MAP_FIELDS.has(k.toLowerCase()) &&
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v)
      ) {
        const vars: Record<string, unknown> = {};
        for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
          vars[ek] = ev == null ? ev : REDACTED_TEXT;
        }
        out[k] = vars;
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export interface StreamRedactor {
  /** The masked text ready to go out for this chunk (often all of it, sometimes less). */
  push(chunk: string): string;
  /** The end of the stream: whatever was held, masked. */
  flush(): string;
}

/** The whole-text masker, for a text that arrives in chunks. */
export function createStreamRedactor(): StreamRedactor {
  // The last character already released: a word edge at the start of what is
  // held is decided by it.
  let before = '';
  let held = '';
  const step = (chunk: string, final: boolean): string => {
    const buffer = before + held + chunk;
    const { out, stop } = scan(buffer, before.length, final);
    if (stop > before.length) before = buffer[stop - 1]!;
    held = buffer.slice(stop);
    return out;
  };
  return {
    push: (chunk) => step(chunk, false),
    flush: () => step('', true),
  };
}
