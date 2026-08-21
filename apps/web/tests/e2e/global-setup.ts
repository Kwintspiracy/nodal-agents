/**
 * Playwright global setup — produces the browser session state every spec
 * reuses, so no test ever handles /login itself.
 *
 * It first DETECTS which auth mode the running stack is in, rather than
 * assuming one. That assumption is what kept `e2e-smoke` red in CI: this file
 * went straight to a better-auth sign-up, but `AUTH_MODE` defaults to
 * `local-trust` (env.ts) and the CI job boots the stack without setting it. In
 * local-trust there IS no better-auth instance — `getBetterAuth()` throws
 * (server.ts) — so /api/auth/* answers 500 with an empty body, and setup died
 * on "Sign-in failed (500):" before a single spec ran.
 *
 * The probe is behavioural, not declarative: it asks the SERVER what it does,
 * instead of reading an env var the Playwright process may not even share with
 * the stack (in CI the stack is backgrounded from another step).
 *
 *  - `/api/auth/session` answers 200  → local-auth: sign up (idempotent), sign
 *    in, capture the session cookie, inject it.
 *  - anything else → the better-auth API is absent. Confirm the dashboard is
 *    genuinely open by loading a protected route WITHOUT a session; if it
 *    renders, we are in local-trust and the saved state is simply cookie-free.
 *
 * If neither holds, we fail loudly with what was observed — a stack that
 * refuses both auth and anonymous access is broken, and silently writing an
 * empty state would turn that into 30 confusing spec failures.
 */

import { chromium, type FullConfig, type Page } from '@playwright/test';
import path from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sentinel credentials — local-only, never used in prod.
const E2E_EMAIL = 'e2e-playwright@nodalai.local';
const E2E_PASSWORD = 'E2ETest_pw_2026!';
const E2E_NAME = 'E2E Playwright';
export const AUTH_STATE_PATH = path.join(__dirname, '.auth', 'user.json');

/**
 * local-trust path: the dashboard is open by design ("local mode = no auth by
 * default"), so the saved state carries no cookie. We still PROVE the route is
 * reachable anonymously before writing it — an empty state written blindly
 * would mask a broken stack behind a pile of unrelated spec failures.
 */
async function setupWithoutAuth(baseURL: string): Promise<void> {
  mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const response = await page.goto('/agents');
    const landedOn = response?.url() ?? '(no response)';
    if (landedOn.includes('/login')) {
      throw new Error(
        `Stack refuses both auth paths: /api/auth/session is not served (so not local-auth), ` +
          `yet /agents redirected to ${landedOn} (so not local-trust either). ` +
          `Check AUTH_MODE on the running stack.`,
      );
    }
    if (response && !response.ok()) {
      throw new Error(
        `/agents answered ${response.status()} without a session. Expected the ` +
          `dashboard to render in local-trust mode.`,
      );
    }
    await completeOnboardingIfNeeded(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(
      `[global-setup] local-trust detected — cookie-free state saved → ${AUTH_STATE_PATH}`,
    );
  } finally {
    await browser.close();
  }
}

/**
 * Bring a FRESH install to the state every spec assumes: one agent exists.
 *
 * `apps/cli/src/lib/seed.ts` deliberately seeds a user and an entity but NO
 * agent ("the user creates their first agent intentionally from the dashboard —
 * no surprise rows in their DB"), and the dashboard layout redirects to
 * /onboarding whenever `agentCount === 0`. So a CI stack always starts in
 * onboarding, whatever LLM key it has — which is why `sidebar` and
 * `agent → task → job` failed there while passing locally on a configured
 * machine. It was never about the key.
 *
 * We walk the REAL onboarding flow rather than inserting a row: seeding the
 * assertion data is what makes an e2e suite lie. The side benefit is that the
 * first screen of a fresh install finally gets exercised by something.
 */
async function completeOnboardingIfNeeded(page: Page): Promise<void> {
  if (!page.url().includes('/onboarding')) return;

  // Step 0 → 1. Button labels are taken verbatim from OnboardingFlow.tsx.
  await page.getByRole('button', { name: /get started/i }).click();

  // Step 1 — the key. CI has no real credentials, and `createLlmKeyAction`
  // stores what it is given without calling the provider, so a placeholder is
  // enough to move on; nothing here ever reaches a model. The provider defaults
  // to OpenRouter and the model to the first catalogue entry, so both are
  // already valid — we only fill what is empty.
  await page.getByLabel(/^api key/i).fill('e2e-placeholder-key');
  await page.getByRole('button', { name: /continue/i }).click();

  // Step 2 — the agent. Its existence is the whole point of this detour.
  await page.getByLabel(/^name$/i).fill('E2E Setup Agent');
  await page.getByRole('button', { name: /create agent/i }).click();

  // Creating the agent does NOT hand back to the dashboard: onboarding stays on
  // its own route and goes on with steps 3-6 (meet the agent, interview,
  // autonomy). What we came for is already done, so we leave through the front
  // door and let the dashboard itself tell us whether it still bounces us —
  // `agentCount > 0` is the only condition that matters, and this asks it
  // directly instead of trusting a navigation that was never going to happen.
  const deadline = Date.now() + 30_000;
  for (;;) {
    await page.goto('/');
    if (!page.url().includes('/onboarding')) break;
    if (Date.now() > deadline) {
      throw new Error(
        'Walked onboarding through "Create agent" but the dashboard still redirects to ' +
          '/onboarding — the agent was not created. Check createAgentAction in the web logs.',
      );
    }
    await page.waitForTimeout(1_000);
  }
  console.log('[global-setup] fresh install — walked onboarding to create the first agent');
}

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

  // ── 2. Which mode is this stack actually in? ────────────────────────────────
  // `/api/auth/session` is the cheapest honest answer: better-auth serves it in
  // local-auth, and the catch-all route throws (500) in every other mode.
  let betterAuthAvailable = false;
  try {
    const probe = await fetch(`${baseURL}/api/auth/session`, {
      headers: { Origin: baseURL },
      signal: AbortSignal.timeout(10_000),
    });
    betterAuthAvailable = probe.ok;
  } catch {
    betterAuthAvailable = false;
  }

  if (!betterAuthAvailable) {
    await setupWithoutAuth(baseURL);
    return;
  }

  // ── 3. Sign-up (idempotent) ──────────────────────────────────────────────────
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

  // ── 4. Sign-in and capture session cookie ────────────────────────────────────
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

  // ── 5. Build browser state with the session cookie ────────────────────────────
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

  await completeOnboardingIfNeeded(page);
  await context.storageState({ path: AUTH_STATE_PATH });
  await browser.close();

  console.log(`[global-setup] session state saved → ${AUTH_STATE_PATH}`);
}

export default globalSetup;
