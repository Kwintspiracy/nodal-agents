/**
 * Playwright global setup — authenticates the e2e sentinel user and persists
 * the browser session state so every test spec can reuse it without logging in.
 *
 * Flow:
 *  1. Attempt sign-up via better-auth API (idempotent — ignores 409/422 if user
 *     already exists from a previous run).
 *  2. Sign-in via better-auth API and capture the session cookie.
 *  3. Open a Chromium page, inject the cookie, navigate to /agents to let
 *     Next.js build the full session context, then save storageState.
 *
 * The saved state is loaded by every Playwright project via `storageState`
 * in playwright.config.ts — no test ever needs to log in manually.
 */

import { chromium, type FullConfig } from '@playwright/test';
import path from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sentinel credentials — local-only, never used in prod.
const E2E_EMAIL = 'e2e-playwright@nodalai.local';
const E2E_PASSWORD = 'E2ETest_pw_2026!';
const E2E_NAME = 'E2E Playwright';
export const AUTH_STATE_PATH = path.join(__dirname, '.auth', 'user.json');

async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL: string = config.projects[0]?.use.baseURL ?? 'http://localhost:3000';

  // ── 1. Ensure stack is reachable ────────────────────────────────────────────
  try {
    const health = await fetch(`${baseURL}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok) {
      throw new Error(`/api/health returned ${health.status}`);
    }
  } catch (err) {
    throw new Error(
      `Nodal-Agents stack not reachable at ${baseURL} — bring it up with \`nodal-agents up --dev\` first.\nCause: ${(err as Error).message}`,
    );
  }

  // better-auth requires an Origin header to prevent CSRF from direct API calls.
  const authHeaders = {
    'Content-Type': 'application/json',
    Origin: baseURL,
  };

  // ── 2. Sign-up (idempotent) ──────────────────────────────────────────────────
  const signupRes = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD, name: E2E_NAME }),
  });
  // 200 = created, 422/409/400/500 = already exists or server-side uniqueness constraint.
  // We proceed regardless — sign-in will validate credentials below.
  if (!signupRes.ok) {
    const status = signupRes.status;
    // Only hard-fail on auth-layer errors (not server errors from duplicate email).
    if (
      status < 400 ||
      (status >= 400 && status < 500 && status !== 422 && status !== 409 && status !== 400)
    ) {
      const body = await signupRes.text();
      throw new Error(`Sign-up failed unexpectedly (${status}): ${body}`);
    }
    // 4xx or 5xx = likely already exists, proceed to sign-in.
  }

  // ── 3. Sign-in and capture session cookie ────────────────────────────────────
  const signinRes = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }),
  });
  if (!signinRes.ok) {
    const body = await signinRes.text();
    throw new Error(`Sign-in failed (${signinRes.status}): ${body}`);
  }

  // Extract the session cookie from the Set-Cookie header.
  const setCookie = signinRes.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!tokenMatch) {
    throw new Error(
      `Sign-in succeeded but no better-auth.session_token cookie found in response.\nSet-Cookie: ${setCookie}`,
    );
  }
  const sessionToken = tokenMatch[1]!;

  // ── 4. Build browser state with the session cookie ────────────────────────────
  mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });

  // Parse the URL to extract domain for cookie scope.
  const baseUrlObj = new URL(baseURL);
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: sessionToken,
      domain: baseUrlObj.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      // 7 days
      expires: Math.floor(Date.now() / 1000) + 604_800,
    },
  ]);

  // Navigate to an authenticated route so Next.js validates the session.
  const page = await context.newPage();
  const response = await page.goto('/agents');
  if (response?.url().includes('/login')) {
    throw new Error(
      'Authentication failed — landed on /login instead of /agents after injecting session cookie.',
    );
  }

  await context.storageState({ path: AUTH_STATE_PATH });
  await browser.close();

  console.log(`[global-setup] session state saved → ${AUTH_STATE_PATH}`);
}

export default globalSetup;
