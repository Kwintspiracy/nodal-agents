// Constant-time string comparison — for secrets compared against a header
// value (bearer tokens), where a naive `===` leaks the length of the
// matching prefix via response timing.
//
// apps/runner already has `isValidWorkerSecret` (timingSafeEqual-based), but
// packages/auth cannot import across the apps/packages boundary — so this is
// a local, package-scoped equivalent.
//
// Rather than padding the shorter operand (which still branches on length
// before the constant-time compare), we hash both operands to a fixed-length
// digest first. `timingSafeEqual` then always runs on two 32-byte buffers
// regardless of the input lengths, so there is nothing length-shaped left to
// leak.

import { createHash, timingSafeEqual } from 'node:crypto';

/** Returns true iff `a` equals `b`, compared in constant time. */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
