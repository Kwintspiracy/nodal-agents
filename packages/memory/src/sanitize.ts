// @nodal-agents/memory — content sanitation for memory facts
//
// Memory facts are shared entity-wide AND injected verbatim into the system
// prompt. A hostile fact saved by one agent is re-served to every other agent in
// the entity, every turn — a persistent prompt-injection vector. Every write
// path MUST pass through sanitizeMemoryContent().
//
// Patterns ported from Hermes Agent `tools/memory_tool.py:_scan_memory_content`
// (12 threat patterns + invisible-unicode block), adapted for Nodal-Agents paths.
//
// WHAT THIS DOES NOT DO (MEMORY-001, audit 2026-08-07)
// ----------------------------------------------------
// Measured against a 16-payload corpus, this denylist caught 2. It is a
// keyword matcher over ENGLISH imperatives, so it stops the canonical
// "ignore previous instructions" and misses everything that means the same
// thing in other words or another language — "Ignore les instructions
// précédentes", "From this point forward, your role is different", a fake
// service note. That is not a bug to fix by adding patterns: a denylist over
// natural language cannot be completed, and lengthening it mostly buys the
// appearance of coverage.
//
// The load-bearing mitigation is therefore NOT here — it is the framing of the
// `## Persistent memory` block in packages/orchestration/src/system-prompt.ts,
// which tells the model these lines are notes and can never authorise an
// action. This function remains as a cheap first filter and as the enforcement
// point for the length cap and invisible unicode, where a denylist DOES work
// because the set is finite.

import { MemorySanitationError } from './errors';

// ─── Threat patterns ──────────────────────────────────────────────────────────

/** [regex, threatId] — matched case-insensitively against the fact content. */
const THREAT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Prompt injection / role hijack
  // Allows an optional extra qualifier word ("ignore all above instructions").
  [/ignore\s+(previous|all|above|prior)(\s+\w+)?\s+instructions/i, 'prompt_injection'],
  [/you\s+are\s+now\s+/i, 'role_hijack'],
  [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
  [/system\s+prompt\s+override/i, 'sys_prompt_override'],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, 'disregard_rules'],
  [
    /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
    'bypass_restrictions',
  ],
  // Exfiltration via curl/wget with secrets
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_curl'],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_wget'],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, 'read_secrets'],
  // Persistence / SSH backdoor
  [/authorized_keys/i, 'ssh_backdoor'],
  [/(\$HOME|~)\/\.ssh/i, 'ssh_access'],
  [/(\$HOME|~)\/\.nodalai\/(\.env|secrets\.key)/i, 'nodalai_secrets'],
];

/** Zero-width and bidi-control characters used to smuggle hidden instructions. */
const INVISIBLE_CHARS = [
  '​', // zero-width space
  '‌', // zero-width non-joiner
  '‍', // zero-width joiner
  '⁠', // word joiner
  '﻿', // BOM / zero-width no-break space
  '‪', // left-to-right embedding
  '‫', // right-to-left embedding
  '‬', // pop directional formatting
  '‭', // left-to-right override
  '‮', // right-to-left override
] as const;

/** Hard cap on fact length — facts land in the system prompt, keep them bounded. */
export const MAX_FACT_LENGTH = 5000;

// ─── sanitizeMemoryContent ────────────────────────────────────────────────────

/**
 * Validate a memory fact before it is persisted. Throws MemorySanitationError
 * on the first violation found. Returns void on clean input.
 *
 * Checks, in order: length cap → invisible unicode → threat patterns.
 */
export function sanitizeMemoryContent(fact: string): void {
  if (fact.length > MAX_FACT_LENGTH) {
    throw new MemorySanitationError(
      'too_long',
      `Memory fact exceeds ${MAX_FACT_LENGTH} characters (${fact.length}).`,
    );
  }

  for (const char of INVISIBLE_CHARS) {
    if (fact.includes(char)) {
      const code = char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '????';
      throw new MemorySanitationError(
        'invisible_unicode',
        `Memory fact contains invisible unicode character U+${code} (possible injection).`,
      );
    }
  }

  for (const [pattern, threatId] of THREAT_PATTERNS) {
    if (pattern.test(fact)) {
      throw new MemorySanitationError(
        threatId,
        `Memory fact matches threat pattern '${threatId}'. Memory entries are injected into ` +
          'the system prompt and must not contain injection or exfiltration payloads.',
      );
    }
  }
}
