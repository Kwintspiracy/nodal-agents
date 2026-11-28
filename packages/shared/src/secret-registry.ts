// secret-registry.ts — the exact values of the secrets Nodal itself holds.
//
// A shape guesses; a registered value is known. Nodal holds (or can decrypt)
// every key it was given: a provider key, a connector key, an OAuth token, an
// MCP server's key and variables, a channel's bot token, a webhook secret,
// the runner's own secrets. Masked by their exact bytes, they are hidden
// wherever they appear, whatever their vendor or form, with no false positive
// by construction: a text that holds one of them holds a secret.
//
// What a registry is
// ------------------
// A set of values, built for ONE workspace (`registeredSecrets`), from the
// values of that workspace and the install's own (`installSecretValues`). One
// workspace's values are never used to scan another's text: hiding bytes in
// workspace B because they are a key of workspace A would tell B that those
// bytes are a key somewhere.
//
// It lives in memory only, for the call that built it. Its content is never
// logged, listed, returned or sent anywhere: the only thing that leaves it is
// a text with its values replaced by the placeholder.
//
// The forms a value takes in a text (`secretValueForms`)
// ------------------------------------------------------
// The value as stored, trimmed, JSON-escaped (a value inside a JSON text),
// percent-encoded (a value in a URL), and, for a value of several lines (a
// private key), each line of its body and the body joined on one line. Only
// forms of at least `MIN_REGISTERED_SECRET_LENGTH` characters are registered:
// a shorter value would hide ordinary words everywhere it appears.

import { REDACTED_TEXT, replaceRanges } from './redact-secrets';

/** A value shorter than this is not registered: it would hide ordinary text. */
export const MIN_REGISTERED_SECRET_LENGTH = 8;

/** The armour lines of a key block (`-----BEGIN … -----`): labels, not secret material. */
const ARMOUR_LINE = /^-{5}[^-]+-{5}$/;

/** Every form `value` can take in a text, each at least the minimum length. */
export function secretValueForms(value: string): string[] {
  const forms = new Set<string>();
  const add = (form: string): void => {
    if (form.length >= MIN_REGISTERED_SECRET_LENGTH && !form.includes(REDACTED_TEXT)) {
      forms.add(form);
    }
  };
  const trimmed = value.trim();
  add(value);
  add(trimmed);
  add(JSON.stringify(trimmed).slice(1, -1));
  add(encodeURIComponent(trimmed));
  if (/\r?\n/.test(trimmed)) {
    const body = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !ARMOUR_LINE.test(line));
    for (const line of body) add(line);
    add(body.join(''));
  }
  return [...forms];
}

/** The exact values of one workspace's secrets, ready to be found in a text. */
export interface SecretRegistry {
  /** How many forms it searches for (never which). */
  readonly size: number;
  /** Where its values are in `text`: sorted, disjoint `[start, end)` ranges. */
  ranges(text: string): Array<readonly [number, number]>;
  /** `text` with every registered value replaced by the placeholder. */
  mask(text: string): string;
}

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** A registry of `values` (and every form of each). */
export function registeredSecrets(values: Iterable<string | null | undefined>): SecretRegistry {
  const forms = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const form of secretValueForms(value)) forms.add(form);
  }
  if (forms.size === 0) {
    return { size: 0, ranges: () => [], mask: (text) => text };
  }
  // Longest first: at a position where a value and one of its lines both
  // start, the whole value is what is hidden.
  const sorted = [...forms].sort((a, b) => b.length - a.length);
  const expression = new RegExp(sorted.map(escapeForRegExp).join('|'), 'g');
  const ranges = (text: string): Array<readonly [number, number]> => {
    const found: Array<readonly [number, number]> = [];
    expression.lastIndex = 0;
    for (let m = expression.exec(text); m !== null; m = expression.exec(text)) {
      found.push([m.index, m.index + m[0].length]);
    }
    return found;
  };
  return {
    size: forms.size,
    ranges,
    mask: (text) => replaceRanges(text, ranges(text)),
  };
}

// ─── The install's own values ───────────────────────────────────────────────
//
// The secrets of the process itself (the database password, the worker
// secret, the master key…), registered once when the process starts. They are
// the install's, not a workspace's: every workspace's registry holds them.

let installValues: readonly string[] = [];

/** Register the install's own secret values (the process's, at start). */
export function registerInstallSecretValues(values: Iterable<string | null | undefined>): void {
  const next = new Set(installValues);
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length >= MIN_REGISTERED_SECRET_LENGTH) {
      next.add(value);
    }
  }
  installValues = [...next];
}

/** The install's own secret values, as registered. */
export function installSecretValues(): readonly string[] {
  return installValues;
}

/** Forget the install's values (tests only). */
export function _resetInstallSecretValuesForTests(): void {
  installValues = [];
}
