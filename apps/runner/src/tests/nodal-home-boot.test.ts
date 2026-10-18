// nodal-home-boot.test.ts — un runner démarré SANS `up` déclare son instance.
//
// Revue de #787, passe 2 : seul `up` inscrivait l'instance au registre. Un
// runner lancé seul (un outil, un test, un `up` mort en route) n'était alors
// dans aucune liste, et les commandes confinées d'une autre instance lisaient
// sa clé maîtresse. Le runner ouvre maintenant son dossier par la porte
// commune (openNodalHome) avant toute autre chose.
//
// Le VRAI point d'entrée est lancé (`src/server.ts`), sur un dossier neuf, avec
// une base injoignable : l'inscription doit précéder la première connexion. Le
// dossier personnel pointe dans un temporaire, rien n'est écrit ailleurs.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNodalInstances } from '@nodal-agents/shared/nodal-instances';
import { sandboxDeniedPaths } from '@nodal-agents/sandbox';

const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let child: ChildProcess | undefined;
let root: string | undefined;
afterEach(() => {
  child?.kill();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

describe('a runner booted without `up` @cap:installer-et-demarrer/moteur', () => {
  it('is registered before it touches its database, and denied to another instance', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'nodal-boot-')));
    const user = join(root, 'user');
    const homeB = join(root, 'nodal-b');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('NODALAI_')) env[k] = v;
    }
    Object.assign(env, {
      USERPROFILE: user,
      HOME: user,
      NODALAI_HOME: homeB,
      // Nothing listens on port 1: the runner cannot get past its database.
      DATABASE_URL: 'postgresql://nodalai:x@127.0.0.1:1/nodalai',
      WHATSAPP_BRIDGE_ENABLED: 'false',
      CRON_TICKER_ENABLED: 'false',
    });
    let output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: RUNNER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));

    const registered = await waitFor(
      () => existsSync(join(user, '.nodalai-instances')) && readNodalInstances(user).length > 0,
      90_000,
    );
    expect(registered, output.slice(-2000)).toBe(true);
    expect(readNodalInstances(user).map((r) => r.home)).toEqual([homeB]);
    expect(existsSync(homeB)).toBe(true);

    // The default instance of this user, a confined command of it: B's secrets are refused.
    writeFileSync(join(homeB, 'secrets.key'), 'k');
    const denied = sandboxDeniedPaths([], { platform: process.platform, home: user, env: {} });
    expect(denied).toContain(join(homeB, 'secrets.key'));
  }, 120_000);
});
