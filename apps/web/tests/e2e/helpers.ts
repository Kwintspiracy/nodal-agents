import { test as base } from '@playwright/test';

/**
 * Skip the entire test file when the NodalAI stack isn't reachable. Every
 * e2e file calls `requireLiveStack(test)` in a beforeAll so a missing
 * server fails fast and obvious rather than minutes of nav timeouts.
 */
export async function requireLiveStack(): Promise<void> {
  const baseURL = base.info().project.use.baseURL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${baseURL}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      base.skip(true, `NodalAI /api/health returned ${res.status}`);
    }
  } catch (err) {
    base.skip(true, `NodalAI not reachable at ${baseURL}: ${(err as Error).message}`);
  }
}

/**
 * A short slug suffix to keep test runs independent on a shared DB.
 * Format: e2e-<6 random chars>.
 */
export function testSlugSuffix(): string {
  return `e2e-${Math.random().toString(36).slice(2, 8)}`;
}
