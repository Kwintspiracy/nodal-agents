// page-renderer.test.ts — le moteur de rendu au démarrage (#1082).
//
// Ce qui est prouvé, par le vrai code d'installation contre un serveur local
// (le vrai build de 120 Mo n'est pas téléchargé ici) :
//   - refusé par le réglage ou le drapeau : rien n'est téléchargé, le terminal
//     le dit, et l'état le garde pour que l'outil le dise ;
//   - hors ligne : le démarrage ne lève pas, le terminal dit pourquoi et la
//     commande pour plus tard ;
//   - la progression arrive au terminal, puis la ligne de fin ;
//   - `up` ne le lance qu'APRÈS « All services healthy ».

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { BrowserPlatform } from '@puppeteer/browsers';
import { readRendererStatus } from '@nodal-agents/page-render/install';
import {
  SKIP_RENDERER_FLAG,
  ensureRendererAtStart,
  rendererInstallTurnedOff,
} from '../lib/page-renderer.ts';

const zip = zipSync({
  'chrome-headless-shell-linux64/chrome-headless-shell': new TextEncoder().encode('#!/bin/sh\n'),
});
const BUILD = '300.0.0.1';

let server: Server;
let baseUrl: string;
let hits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === `/${BUILD}/linux64/chrome-headless-shell-linux64.zip`) {
      res.writeHead(200, { 'content-length': String(zip.length) }).end(Buffer.from(zip));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-cli-renderer-'));
  hits = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recorder() {
  const lines: string[] = [];
  return {
    lines,
    reporter: {
      start: (t: string) => lines.push(`start ${t}`),
      progress: (t: string) => lines.push(`progress ${t}`),
      succeed: (t: string) => lines.push(`succeed ${t}`),
      fail: (t: string) => lines.push(`fail ${t}`),
      info: (t: string) => lines.push(`info ${t}`),
    },
  };
}

const install = (extra: Record<string, unknown> = {}) => ({
  dir,
  buildId: BUILD,
  sha256: createHash('sha256').update(zip).digest('hex'),
  baseUrl,
  platform: BrowserPlatform.LINUX,
  ...extra,
});

describe('the page renderer at start @cap:travailler-sur-des-fichiers/moteur', () => {
  it('the opt-out: the config setting and the flag, said as the person set them', () => {
    expect(rendererInstallTurnedOff({ pageRenderer: { autoInstall: false } }, false)).toBe(
      'config.json: "pageRenderer": { "autoInstall": false }',
    );
    expect(rendererInstallTurnedOff({}, true)).toBe(`nodal-agents up ${SKIP_RENDERER_FLAG}`);
    expect(rendererInstallTurnedOff({ pageRenderer: { autoInstall: true } }, false)).toBeNull();
    expect(rendererInstallTurnedOff(null, false)).toBeNull();
  });

  it('turned off: nothing is downloaded, the terminal says so, and the state keeps it for the tool', async () => {
    const r = recorder();
    const out = await ensureRendererAtStart({
      turnedOff: 'nodal-agents up --skip-renderer-install',
      reporter: r.reporter,
      install: install(),
    });
    expect(out).toBe('off');
    expect(hits).toBe(0);
    expect(r.lines).toEqual([
      'info Page renderer not installed: its download at start is turned off (nodal-agents up ' +
        '--skip-renderer-install). Install it later: nodal-agents renderer install',
    ]);
    expect(await readRendererStatus({ dir, buildId: BUILD })).toMatchObject({ kind: 'off' });
  });

  it('downloads with progress, then says it is ready; the next start does nothing', async () => {
    const r = recorder();
    expect(
      await ensureRendererAtStart({ turnedOff: null, reporter: r.reporter, install: install() }),
    ).toBe('installed');
    expect(r.lines[0]).toBe(`start Page renderer: downloading chrome-headless-shell ${BUILD}…`);
    expect(r.lines.some((l) => l.startsWith('progress '))).toBe(true);
    expect(r.lines.at(-1)).toBe(`succeed Page renderer ready: chrome-headless-shell ${BUILD}`);

    const again = recorder();
    hits = 0;
    expect(
      await ensureRendererAtStart({
        turnedOff: null,
        reporter: again.reporter,
        install: install(),
      }),
    ).toBe('ready');
    expect(hits).toBe(0);
    expect(again.lines).toEqual([]);
  });

  it('offline: the start does not fail, the terminal says why and how to install later', async () => {
    const r = recorder();
    const out = await ensureRendererAtStart({
      turnedOff: null,
      reporter: r.reporter,
      // Nothing listens there.
      install: install({ baseUrl: 'http://127.0.0.1:9' }),
    });
    expect(out).toBe('failed');
    expect(r.lines.at(-1)).toMatch(
      /^fail Page renderer not installed: downloading chrome-headless-shell 300\.0\.0\.1 for linux failed \(.+\)\. Nodal runs without it, and render_pdf says so\. Install it later: nodal-agents renderer install$/,
    );
    expect((await readRendererStatus({ dir, buildId: BUILD })).kind).toBe('failed');
  });
});

describe('`up` starts the download only after the services are healthy', () => {
  it('the call comes after "All services healthy" and the ready line, and a detached start waits for it', () => {
    const up = readFileSync(
      join(fileURLToPath(import.meta.url), '..', '..', 'commands', 'up.ts'),
      'utf8',
    );
    const healthy = up.indexOf("healthSpinner.succeed(chalk.green('All services healthy'))");
    const ready = up.indexOf('Nodal-Agents ready at');
    const call = up.indexOf('ensureRendererAtStart({');
    const detachedExit = up.indexOf('pg.outliveLauncher();');
    const awaited = up.indexOf('await rendererStart;');
    expect(healthy).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(healthy);
    expect(call).toBeGreaterThan(ready);
    expect(awaited).toBeGreaterThan(call);
    expect(awaited).toBeLessThan(detachedExit);
  });
});
