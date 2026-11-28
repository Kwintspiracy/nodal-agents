// install.test.ts — l'installation du moteur, contre un serveur LOCAL (#1082).
//
// `@puppeteer/browsers` prend l'hôte des builds en paramètre (`baseUrl`) : un
// serveur de ce test sert une archive de quelques octets, construite ici, à
// l'adresse exacte où Google sert la vraie. Le chemin épinglé, la progression,
// l'empreinte, l'échec, le refus et le remplacement d'un build par un autre
// sont donc prouvés par le VRAI code d'installation, sans télécharger 120 Mo à
// chaque test. Les assertions portent sur le disque (le programme dépaqueté,
// le témoin, l'état) et sur ce que `readRendererStatus` en dit à l'outil.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { BrowserPlatform } from '@puppeteer/browsers';
import {
  RENDERER_ARCHIVE_SHA256,
  RENDERER_BUILD_ID,
  RendererInstallError,
  installRenderer,
  readRendererStatus,
  recordInstallTurnedOff,
  rendererDir,
} from '../install';

const PLATFORM = BrowserPlatform.LINUX;

/** Une archive au format de Google pour `buildId` : le dossier, et le programme dedans. */
function archive(buildId: string): Uint8Array {
  return zipSync({
    'chrome-headless-shell-linux64/chrome-headless-shell': new TextEncoder().encode(
      `#!/bin/sh\necho ${buildId}\n`,
    ),
    'chrome-headless-shell-linux64/LICENSE': new TextEncoder().encode('test'),
  });
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

let server: Server;
let baseUrl: string;
const served = new Map<string, Uint8Array>();
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const body = served.get(req.url ?? '');
    if (body === undefined) {
      res.writeHead(404).end('not here');
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) }).end(Buffer.from(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-renderer-install-'));
  served.clear();
  hits.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Sert le build `buildId` là où Google le sert, et rend son empreinte. */
function serve(buildId: string): string {
  const bytes = archive(buildId);
  served.set(`/${buildId}/linux64/chrome-headless-shell-linux64.zip`, bytes);
  return sha(bytes);
}

const programOf = (buildId: string): string =>
  join(
    dir,
    'cache',
    'chrome-headless-shell',
    `linux-${buildId}`,
    'chrome-headless-shell-linux64',
    'chrome-headless-shell',
  );

describe('installRenderer @cap:travailler-sur-des-fichiers/moteur', () => {
  it('installs the build at its pinned path, says its progress, and the status reads ready', async () => {
    const hash = serve('200.0.0.1');
    const progress: Array<[number, number]> = [];
    const out = await installRenderer({
      dir,
      buildId: '200.0.0.1',
      sha256: hash,
      baseUrl,
      platform: PLATFORM,
      onProgress: (p) => progress.push([p.downloadedBytes, p.totalBytes]),
    });

    expect(out).toEqual({
      kind: 'installed',
      buildId: '200.0.0.1',
      executablePath: programOf('200.0.0.1'),
      removed: [],
    });
    expect(await readFile(programOf('200.0.0.1'), 'utf8')).toContain('echo 200.0.0.1');
    expect(hits).toEqual(['/200.0.0.1/linux64/chrome-headless-shell-linux64.zip']);
    const total = archive('200.0.0.1').length;
    expect(progress.at(-1)).toEqual([total, total]);
    expect(await readRendererStatus({ dir, buildId: '200.0.0.1' })).toEqual({
      kind: 'ready',
      buildId: '200.0.0.1',
      executablePath: programOf('200.0.0.1'),
    });
    // No attempt state is left behind a finished install, and no lock.
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
    expect(existsSync(join(dir, 'install.lock'))).toBe(false);
  });

  it('a second start does not download again', async () => {
    const hash = serve('200.0.0.1');
    const opts = { dir, buildId: '200.0.0.1', sha256: hash, baseUrl, platform: PLATFORM };
    await installRenderer(opts);
    hits.length = 0;
    const again = await installRenderer(opts);
    expect(again.kind).toBe('already-installed');
    expect(hits).toEqual([]);
  });

  it('a new pin installs the new build and removes the old one', async () => {
    const oldHash = serve('200.0.0.1');
    await installRenderer({
      dir,
      buildId: '200.0.0.1',
      sha256: oldHash,
      baseUrl,
      platform: PLATFORM,
    });
    // Before the next start: the new version's tool sees the old build as not its own.
    expect(await readRendererStatus({ dir, buildId: '201.0.0.2' })).toEqual({
      kind: 'missing',
      detail:
        'build 200.0.0.1 is installed and this version of Nodal renders with 201.0.0.2; the next start installs it',
    });

    const newHash = serve('201.0.0.2');
    const out = await installRenderer({
      dir,
      buildId: '201.0.0.2',
      sha256: newHash,
      baseUrl,
      platform: PLATFORM,
    });

    expect(out).toMatchObject({ kind: 'installed', buildId: '201.0.0.2', removed: ['200.0.0.1'] });
    expect(existsSync(programOf('201.0.0.2'))).toBe(true);
    expect(existsSync(join(dir, 'cache', 'chrome-headless-shell', 'linux-200.0.0.1'))).toBe(false);
  });

  it('a download that fails is loud, written down, and read back by the status', async () => {
    // Nothing is served: the host answers 404.
    const err = await installRenderer({
      dir,
      buildId: '200.0.0.9',
      sha256: 'a'.repeat(64),
      baseUrl,
      platform: PLATFORM,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RendererInstallError);
    expect((err as Error).message).toMatch(
      /^downloading chrome-headless-shell 200\.0\.0\.9 for linux failed \(.*404/,
    );
    const status = await readRendererStatus({ dir, buildId: '200.0.0.9' });
    expect(status.kind).toBe('failed');
    expect(status.kind === 'failed' && status.reason).toBe((err as Error).message);
    expect(existsSync(join(dir, 'install.lock'))).toBe(false);
  });

  it('an archive whose SHA-256 is not the pinned one is refused, and nothing is installed', async () => {
    serve('200.0.0.1');
    const err = await installRenderer({
      dir,
      buildId: '200.0.0.1',
      sha256: 'b'.repeat(64),
      baseUrl,
      platform: PLATFORM,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RendererInstallError);
    expect(existsSync(programOf('200.0.0.1'))).toBe(false);
    expect((await readRendererStatus({ dir, buildId: '200.0.0.1' })).kind).toBe('failed');
  });

  it('a build with no pinned SHA-256 is never installed', async () => {
    serve('200.0.0.1');
    const err = await installRenderer({
      dir,
      buildId: '200.0.0.1',
      baseUrl,
      platform: PLATFORM,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'no SHA-256 is pinned for chrome-headless-shell 200.0.0.1 on linux',
    );
    expect(hits).toEqual([]);
  });

  it('a platform Google publishes no build for fails with the reason, before any download', async () => {
    const err = await installRenderer({
      dir,
      baseUrl,
      platform: BrowserPlatform.LINUX_ARM,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /^Google publishes no chrome-headless-shell build for this platform .*linux_arm/,
    );
    expect(hits).toEqual([]);
  });

  it('a half-unpacked build without its record is removed and installed again', async () => {
    const hash = serve('200.0.0.1');
    const partial = programOf('200.0.0.1');
    await mkdir(join(partial, '..'), { recursive: true });
    await writeFile(partial, 'truncated');
    const out = await installRenderer({
      dir,
      buildId: '200.0.0.1',
      sha256: hash,
      baseUrl,
      platform: PLATFORM,
    });
    expect(out.kind).toBe('installed');
    expect(await readFile(partial, 'utf8')).toContain('echo 200.0.0.1');
  });

  it('another installer running: busy, without waiting; its progress is the status', async () => {
    // The parent of this test process is alive: it stands for another installer.
    const other = process.ppid;
    await writeFile(join(dir, 'install.lock'), String(other));
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        status: 'installing',
        pid: other,
        buildId: RENDERER_BUILD_ID,
        startedAt: '2026-11-16T10:00:00.000Z',
        downloadedBytes: 50 * 1024 * 1024,
        totalBytes: 120 * 1024 * 1024,
      }),
    );
    const out = await installRenderer({ dir, baseUrl, platform: PLATFORM });
    expect(out).toEqual({ kind: 'busy', pid: other, startedAt: '2026-11-16T10:00:00.000Z' });
    expect(await readRendererStatus({ dir })).toEqual({
      kind: 'installing',
      pid: other,
      startedAt: '2026-11-16T10:00:00.000Z',
      downloadedBytes: 50 * 1024 * 1024,
      totalBytes: 120 * 1024 * 1024,
    });
    expect(hits).toEqual([]);
  });

  it('an install whose process died is read as interrupted, not as in progress', async () => {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        status: 'installing',
        pid: 2147483646,
        buildId: RENDERER_BUILD_ID,
        startedAt: '2026-11-16T10:00:00.000Z',
      }),
    );
    expect(await readRendererStatus({ dir })).toEqual({
      kind: 'failed',
      reason:
        'the install started at 2026-11-16T10:00:00.000Z was interrupted (process 2147483646 ended before it finished)',
      at: '2026-11-16T10:00:00.000Z',
    });
  });

  it('turned off at start: the status says by what, until an install runs', async () => {
    await recordInstallTurnedOff('nodal-agents up --skip-renderer-install', { dir });
    expect(await readRendererStatus({ dir })).toMatchObject({
      kind: 'off',
      how: 'nodal-agents up --skip-renderer-install',
    });
    const hash = serve('200.0.0.1');
    await installRenderer({ dir, buildId: '200.0.0.1', sha256: hash, baseUrl, platform: PLATFORM });
    expect((await readRendererStatus({ dir, buildId: '200.0.0.1' })).kind).toBe('ready');
  });

  it('nothing installed yet: missing, with why', async () => {
    expect(await readRendererStatus({ dir })).toEqual({
      kind: 'missing',
      detail: 'no install has run on this machine yet',
    });
  });

  it('the pinned build carries a SHA-256 for every platform Google publishes it for', () => {
    expect(Object.keys(RENDERER_ARCHIVE_SHA256).sort()).toEqual(
      ['linux', 'mac', 'mac_arm', 'win32', 'win64'].sort(),
    );
    for (const h of Object.values(RENDERER_ARCHIVE_SHA256)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rendererDir', () => {
  it('lives under the Nodal home, or where NODALAI_RENDERER_DIR says', () => {
    const home = join(tmpdir(), 'nodal-home-x');
    expect(rendererDir({ NODALAI_HOME: home })).toBe(join(home, 'renderer'));
    const shared = join(tmpdir(), 'shared-renderer');
    expect(rendererDir({ NODALAI_HOME: home, NODALAI_RENDERER_DIR: shared })).toBe(shared);
  });

  it('refuses a relative NODALAI_RENDERER_DIR instead of guessing', () => {
    expect(() => rendererDir({ NODALAI_RENDERER_DIR: 'renderer' })).toThrow(
      /NODALAI_RENDERER_DIR must be an absolute path, got "renderer"/,
    );
  });
});
