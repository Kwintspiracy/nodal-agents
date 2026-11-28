// caller-proof.test.ts — the CLI proves who it is to the runner and the
// dashboard, and opens the dashboard through a launch link in the mode with
// no password.
//
// Every probe is run against a REAL HTTP server that does what both servers
// now do: it answers the install's secret, and 401 without it.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LAUNCH_PARAM, verifyLaunchToken } from '@nodal-agents/auth/launch-link';
import { dashboardEntry, dashboardBaseUrl } from '../lib/dashboard-link.ts';
import { installProof } from '../lib/install-proof.ts';
import { assertWebRenders, waitForHealth } from '../lib/processes.ts';
import { probeRunnerHealth } from '../lib/watchdog.ts';
import type { Config } from '../lib/config.ts';

const SECRET = 'w'.repeat(48);

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
});

/** A server that serves only the install's secret, and records what it saw. */
async function provedServer(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? '(none)'}`);
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"proof_required"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"db":"ok"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function config(over: Partial<Config> = {}): Config {
  return {
    workerSecret: SECRET,
    ports: { web: 3456, runner: 3457, postgres: 5555 },
    bind: 'loopback',
    ...over,
  } as Config;
}

describe('the CLI carries the install proof on every probe @cap:installer-et-demarrer/moteur', () => {
  it("up's health wait and render check, and the watchdog, send the secret and are served", async () => {
    const { url, seen } = await provedServer();
    await waitForHealth(url, 5_000, SECRET);
    await assertWebRenders(url, 5_000, SECRET);
    expect(await probeRunnerHealth(url, SECRET)).toEqual({ state: 'healthy', detail: '' });
    expect(seen).toEqual([
      `GET /api/health Bearer ${SECRET}`,
      `GET / Bearer ${SECRET}`,
      `GET /api/health Bearer ${SECRET}`,
    ]);
  });

  it('a wrong secret is a refused probe, never a healthy one', async () => {
    const { url } = await provedServer();
    expect((await probeRunnerHealth(url, 'x'.repeat(48))).state).toBe('degraded');
    await expect(waitForHealth(url, 1_200, 'x'.repeat(48))).rejects.toThrow(
      /did not become healthy/,
    );
  });

  it('no secret at all is refused before any request is sent', () => {
    expect(() => installProof('')).toThrow(/install_secret_missing/);
  });
});

describe('the dashboard is opened through a launch link in the mode with no password @cap:installer-et-demarrer/moteur', () => {
  it('local-trust: a one-time link to the dashboard, signed with this install secret', () => {
    const now = Date.now();
    const entry = dashboardEntry(config(), now);
    expect(entry.oneTime).toBe(true);
    const url = new URL(entry.url);
    expect(`${url.origin}/`).toBe(dashboardBaseUrl(config()));
    const token = url.searchParams.get(LAUNCH_PARAM) ?? '';
    expect(verifyLaunchToken(SECRET, token, now).ok).toBe(true);
    expect(verifyLaunchToken('another-install-secret-0123456789-012', token, now).ok).toBe(false);
  });

  it('every call makes a new link (a used one cannot be handed out again)', () => {
    const a = new URL(dashboardEntry(config()).url).searchParams.get(LAUNCH_PARAM);
    const b = new URL(dashboardEntry(config()).url).searchParams.get(LAUNCH_PARAM);
    expect(a).not.toBe(b);
  });

  it('a mode with a sign-in opens the dashboard itself: the sign-in is its proof', () => {
    for (const c of [
      config({ bind: 'lan' }),
      config({ auth: { mode: 'local-auth' } } as Partial<Config>),
    ]) {
      expect(dashboardEntry(c)).toEqual({ url: dashboardBaseUrl(c), oneTime: false });
    }
  });
});
