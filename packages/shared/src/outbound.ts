// outbound.ts — THE seam through which text leaves Nodal.
//
// Text written by an agent, a tool or a third party leaves Nodal toward a
// person or an outside client through one of the functions below, and only
// through them: a messaging channel's send and its cards, the runner's HTTP
// answers and event streams (the dashboard, paired devices, any module), the
// MCP server's answers, and the dashboard's read models of job and chat text.
// Each function is the single masker (`redact-secrets.ts`) applied once, at
// the exit:
//
//   - `outboundText(text)`       a whole text;
//   - `outboundValue(value)`     a structured value (field names AND every
//                                string at any depth);
//   - `createOutboundStream()`   a text that leaves in chunks (the stream form
//                                of the same masker: the chunks, end to end,
//                                equal `outboundText` of the whole);
//   - `outboundFields(fields)`   an object whose every string is ALREADY one of
//                                the above (a chunk of a stream inside an event);
//   - `outboundAsIs(value, why)` a value that leaves unmasked ON PURPOSE, for a
//                                reason named in `OUTBOUND_EXEMPTIONS`.
//
// What leaves is typed `Outbound<T>`. A sink Nodal owns (the runner's event
// format, the MCP answer builder) takes only that type, so the compiler refuses
// an exit that skipped the seam; the architecture scanners
// (`scanForOutboundBypass`, `@nodal-agents/test-kit`) refuse the exits whose
// sink Nodal does not own (a channel adapter reached around its registry, a web
// read model projecting agent text) and a cast to the brand anywhere but here.
//
// Mask before any cut: an exit that shortens a text masks first, so a value
// straddling the cut leaves nothing of itself. Masking an already masked text
// changes nothing, so a value masked earlier (before a cut, inside a card) and
// again here is still right.
//
// The stored rows are never touched: these are COPIES for a reader outside.
// Execution (a resume, an approved call re-run from its input) keeps reading
// the real values.

import { createStreamRedactor, redactSecrets, redactSecretsInText } from './redact-secrets';

declare const outboundBrand: unique symbol;

/** A value that went through the outbound seam (masked, or named as-is). */
export type Outbound<T> = T & { readonly [outboundBrand]: true };

/**
 * The values that leave unmasked on purpose. Each is a reason, not a place:
 * every use names one, and the scanner reads the name. Adding one is a product
 * decision, written here with why.
 */
export const OUTBOUND_EXEMPTIONS = {
  /**
   * The secret of a pairing, handed to the device being paired: a device's
   * pairing code and, once the owner confirms, its access token; the code a
   * linked phone scans. Nodal draws it for that pairing; no agent wrote it.
   * Masked (a random value can take a credential's shape), the pairing would
   * fail for no reason anyone could see.
   */
  'pairing-credential':
    'a pairing secret Nodal drew, handed to the device being paired, never a text an agent wrote',
  /**
   * The bytes of a sound or a file, encoded to travel in a text stream (a
   * spoken reply's audio in base64). Not a text: masking it would corrupt the
   * sound, and what it says was masked before it was spoken.
   */
  'encoded-bytes': 'encoded bytes, not text; what they say was masked before they were made',
} as const;

export type OutboundExemption = keyof typeof OUTBOUND_EXEMPTIONS;

/** A whole text, masked for a reader outside Nodal. */
export function outboundText(text: string): Outbound<string>;
export function outboundText(text: string | null): Outbound<string> | null;
export function outboundText(text: string | undefined): Outbound<string> | undefined;
export function outboundText(text: string | null | undefined): Outbound<string> | null | undefined;
export function outboundText(text: string | null | undefined): Outbound<string> | null | undefined {
  if (text === null || text === undefined) return text;
  return redactSecretsInText(text) as Outbound<string>;
}

/**
 * A structured value, masked for a reader outside Nodal: a field whose name
 * says secret is hidden whole, and every string at any depth is masked by
 * shape. Returns a copy of the same shape.
 */
export function outboundValue<T>(value: T): Outbound<T> {
  return redactSecrets(value) as Outbound<T>;
}

/** The chunks of one text, masked as they leave. */
export interface OutboundStream {
  /** What may leave for this chunk (often all of it, sometimes less). */
  push(chunk: string): Outbound<string>;
  /** The end of the text: whatever was held, masked. */
  flush(): Outbound<string>;
}

/** The stream form: chunks out, end to end equal to `outboundText` of the whole. */
export function createOutboundStream(): OutboundStream {
  const redactor = createStreamRedactor();
  return {
    push: (chunk) => redactor.push(chunk) as Outbound<string>,
    flush: () => redactor.flush() as Outbound<string>,
  };
}

/** What an already-outbound object may hold: no raw string anywhere. */
type OutboundField =
  | Outbound<unknown>
  | number
  | boolean
  | null
  | undefined
  | readonly Outbound<string>[];

/**
 * An object assembled from parts that each went through the seam already (a
 * chunk of a stream, a masked text), with no raw string: the type says so,
 * and nothing is masked a second time. A chunk masked alone would not be the
 * chunk of the stream (a value can straddle two chunks; the stream form is
 * what knows), which is why it is composed here rather than re-masked.
 */
export function outboundFields<T extends Record<string, OutboundField>>(fields: T): Outbound<T> {
  return fields as Outbound<T>;
}

/**
 * A value that leaves UNMASKED on purpose, for a reason of
 * `OUTBOUND_EXEMPTIONS`. Never a default: an exit that does not name one is
 * masked.
 */
export function outboundAsIs<T>(value: T, exemption: OutboundExemption): Outbound<T> {
  if (!Object.hasOwn(OUTBOUND_EXEMPTIONS, exemption)) {
    throw new Error(`outbound_exemption_unknown: "${String(exemption)}" is not a named exemption`);
  }
  return value as Outbound<T>;
}
