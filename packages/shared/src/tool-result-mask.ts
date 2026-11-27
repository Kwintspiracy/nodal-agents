// tool-result-mask.ts — what a tool returns, masked once, before the model and the stores.
//
// A tool result becomes two things at once: the message the model reads (and
// that is re-sent with every later turn, replayed on resume, quoted in the
// history, indexed for search) and the row that records the call. Both
// receive the text this function returns, so everything downstream holds what
// the model saw, and nothing holds more.
//
// Two layers, in this order:
//
//   1. the install's own values, EXACTLY (`SecretRegistry`): every key Nodal
//      holds for this workspace, whatever its form. Always applied: no setting
//      lets an agent read a key Nodal keeps for it.
//   2. the shapes of the single masker (`redact-secrets.ts`), when the agent's
//      setting says so (`agents.mask_secret_shapes`, on by default). A source
//      file gets the lighter pass (`redactSecretValuesInText`): its secrets are
//      recognised by their value only, never by the name written before them,
//      because code names secrets at every line without holding them.
//
// Object keys, numbers and booleans are kept as they are: a field's NAME never
// hides its value here (a `nextPageToken` is data the agent needs); a value is
// hidden for what it is.
//
// The placeholder (`REDACTED_TEXT`) cannot pass for a value or a cut one: it
// has a space and brackets no key alphabet has. A write tool refuses to put it
// in a file (`file-ops`), so a masked read is never saved over the secret.

import {
  REDACTED_TEXT,
  redactSecretsInText,
  redactSecretValuesInText,
  secretRangesInText,
} from './redact-secrets';
import type { SecretRegistry } from './secret-registry';

/** How one agent's tool results are masked. */
export interface ToolResultMaskPolicy {
  /** The workspace's and the install's exact values. Always applied. */
  readonly registry: SecretRegistry;
  /** `agents.mask_secret_shapes`: the masker's shapes apply too. */
  readonly shapes: boolean;
}

/** What the result is, for the lighter pass on source code. */
export interface ToolResultKind {
  /** The result is (or holds) the text of a source file. */
  readonly sourceCode: boolean;
}

/**
 * The extensions of source code: a file whose text is a program, where names
 * like `password` or `API_KEY` appear without a value. Configuration and data
 * (`.env`, `.json`, `.yaml`, `.ini`, `.txt`) are not code: a name there is
 * followed by its value.
 */
const SOURCE_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'cts',
  'dart',
  'go',
  'h',
  'hpp',
  'java',
  'js',
  'jsx',
  'kt',
  'kts',
  'lua',
  'm',
  'mjs',
  'mts',
  'php',
  'pl',
  'ps1',
  'py',
  'r',
  'rb',
  'rs',
  'scala',
  'sh',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
  'zsh',
]);

/** Is `path` the path of a source file (by its extension)? */
export function isSourceCodePath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The kind of a call's result, read from its input: a call that names one
 * file (`path` or `file_path`) whose extension is source code returns code.
 * Every tool is judged by the same rule, by what it was asked to read.
 */
export function toolResultKindOf(input: unknown): ToolResultKind {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { sourceCode: false };
  }
  const fields = input as Record<string, unknown>;
  const path = fields['path'] ?? fields['file_path'];
  return { sourceCode: typeof path === 'string' && isSourceCodePath(path) };
}

/** One text of a tool result, masked. */
export function maskToolResultText(
  text: string,
  policy: ToolResultMaskPolicy,
  kind: ToolResultKind,
): string {
  const exact = policy.registry.mask(text);
  if (!policy.shapes) return exact;
  return kind.sourceCode ? redactSecretValuesInText(exact) : redactSecretsInText(exact);
}

/**
 * A tool result, masked: every string at any depth, keys and other values kept.
 * Returns a copy (the same value when nothing was hidden) and whether
 * anything was.
 */
export function maskToolResult<T>(
  value: T,
  policy: ToolResultMaskPolicy,
  kind: ToolResultKind,
): { value: T; masked: boolean } {
  let masked = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const out = maskToolResultText(v, policy, kind);
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
export function maskedLinesOf(
  text: string,
  policy: ToolResultMaskPolicy,
  kind: ToolResultKind,
): number[] {
  const ranges = [
    ...policy.registry.ranges(text),
    ...(policy.shapes ? secretRangesInText(text, { byName: !kind.sourceCode }) : []),
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
