// tool-result-mask.ts — what a tool returns, masked once, before the model and the stores.
//
// A tool result becomes two things at once: the message the model reads (and
// that is re-sent with every later turn, replayed on resume, quoted in the
// history, indexed for search) and the row that records the call. Both
// receive the text this function returns, so everything downstream holds what
// the model saw, and nothing holds more.
//
// A value is masked here because of what the VALUE is, never because of the
// name of the field that holds it. Two layers, in this order:
//
//   1. the install's own values, EXACTLY (`SecretRegistry`): every key Nodal
//      holds for this workspace, whatever its form. Always applied: no setting
//      lets an agent read a key Nodal keeps for it.
//   2. the values whose own form is a credential's (`redactSecretValuesInText`,
//      the mode of the single masker without its name-based shapes: a key's
//      prefix and alphabet, a token's segments, a key block, a password in a
//      URL), when the agent's setting says so (`agents.mask_secret_shapes`, on
//      by default).
//
// The masker's name-based shapes (whatever follows a field, a variable or a
// parameter named like a secret) are a display heuristic: on a screen a false
// positive is cosmetic, in front of the model it is a wrong answer. A page
// token, a cursor, a sync token sit in fields named like secrets, and the
// model must hand them back to go on. They are not applied here; the outbound
// function (`outbound.ts`) applies them to everything that leaves for a
// person. What that lets through to the model: a third party's secret with no
// recognisable form, written after a name that says secret (a `.env` line, a
// JSON key). The install's own values are masked whatever their form.
//
// Object keys, numbers and booleans are kept as they are.
//
// The placeholder (`REDACTED_TEXT`) cannot pass for a value or a cut one: it
// has a space and brackets no key alphabet has. A write tool refuses to put it
// in a file (`file-ops`), so a masked read is never saved over the secret.

import { REDACTED_TEXT, redactSecretValuesInText, secretRangesInText } from './redact-secrets';
import type { SecretRegistry } from './secret-registry';

/** How one agent's tool results are masked. */
export interface ToolResultMaskPolicy {
  /** The workspace's and the install's exact values. Always applied. */
  readonly registry: SecretRegistry;
  /** `agents.mask_secret_shapes`: values whose own form is a credential's are masked too. */
  readonly shapes: boolean;
}

/** One text of a tool result, masked. */
export function maskToolResultText(text: string, policy: ToolResultMaskPolicy): string {
  const exact = policy.registry.mask(text);
  return policy.shapes ? redactSecretValuesInText(exact) : exact;
}

/**
 * A tool result, masked: every string at any depth, keys and other values kept.
 * Returns a copy (the same value when nothing was hidden) and whether
 * anything was.
 */
export function maskToolResult<T>(
  value: T,
  policy: ToolResultMaskPolicy,
): { value: T; masked: boolean } {
  let masked = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const out = maskToolResultText(v, policy);
      if (out !== v) masked = true;
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      // Only plain objects are walked: a Date, a Buffer, a class instance
      // keeps its identity (it is serialised by its own rule, not as fields).
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) return v;
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  const result = walk(value) as T;
  return masked ? { value: result, masked } : { value, masked };
}

/**
 * The lines of `text` (1-based) that the mask would hide something in. Used
 * by the write tools to say WHICH lines of a file were hidden from the agent.
 */
export function maskedLinesOf(text: string, policy: ToolResultMaskPolicy): number[] {
  const ranges = [
    ...policy.registry.ranges(text),
    ...(policy.shapes ? secretRangesInText(text, { byName: false }) : []),
  ];
  if (ranges.length === 0) return [];
  // The offset where each line starts.
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = new Set<number>();
  for (const [start, end] of ranges) {
    for (let l = lineAt(start); l <= lineAt(Math.max(start, end - 1)); l++) lines.add(l);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Does `text` hold the placeholder a mask writes? */
export function holdsMaskPlaceholder(text: string): boolean {
  return text.includes(REDACTED_TEXT);
}
