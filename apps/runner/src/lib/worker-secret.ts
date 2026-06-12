// lib/worker-secret.ts — shared WORKER_SECRET validation helper
//
// Single implementation of the timing-safe bearer-token check used by
// worker.ts, skills.ts, and the requireRunnerAuth middleware in server.ts.
// Using crypto.timingSafeEqual prevents secret-length leakage via timing.

import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

/**
 * Returns true iff `provided` equals `expected`, using a constant-time
 * comparison. A length mismatch is handled by padding to the longer length
 * before comparing, then returning false — this avoids length-based timing
 * leaks while still being unconditionally false on mismatch.
 */
export function isValidWorkerSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare against a same-length buffer to keep timing constant,
    // then return false unconditionally.
    cryptoTimingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return cryptoTimingSafeEqual(a, b);
}
