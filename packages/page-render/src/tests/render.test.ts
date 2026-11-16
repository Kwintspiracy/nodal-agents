// render.test.ts — des pages rendues par le VRAI moteur épinglé (#1082).
//
// Chaque assertion porte sur le PDF réellement produit (ses pages et leur
// format relus dans le fichier par pdf-lib), sur ce que la page a pu charger
// (un serveur local qui compte ses visites), et sur les processus (le pid du
// navigateur et tout processus portant son profil, disparus après l'appel).
// Le moteur manquant fait rougir ces tests (real-renderer.ts).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProcessAlive } from '@nodal-agents/sandbox';
import {
  MIN_READABLE_SCALE,
  PageRenderError,
  liveRendererPids,
  renderPdf,
  type LocalRead,
  type RenderPdfRequest,
} from '../render';
import { readPdfFacts } from '../pdf-facts';
import { realRendererPath } from './real-renderer';

let exe: string;
let dir: string;

beforeAll(async () => {
  exe = await realRendererPath();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-render-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** Le périmètre du test : le dossier du test, rien d'autre. */
const inDir = async (p: string): Promise<LocalRead> =>
  p.toLowerCase().startsWith(dir.toLowerCase())
    ? { ok: true, bytes: await readFile(p) }
    : { ok: false, reason: 'outside the test folder' };

async function page(name: string, html: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, html, 'utf8');
  return p;
}

/**
 * Une page de `px` pixels CSS de haut (blocs de hauteur fixe : à l'échelle s,
 * elle fait px × s), avec du texte. Une page A4 à 10 mm de marges imprime
 * 277 mm, soit 1047 px CSS.
 */
function tall(px: number, css = ''): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0} ` +
    `.b{height:${px}px;background:#eee;font:16px sans-serif} ${css}</style></head>` +
    `<body><div class="b">Été, Œuvre, ça — ${'Lorem ipsum dolor sit amet. '.repeat(20)}</div></body></html>`
  );
}

const A4_PRINTABLE_PX = 1047;

function render(source: string, extra: Partial<RenderPdfRequest> = {}) {
  return renderPdf({ executablePath: exe, source, readLocal: inDir, ...extra });
}

/** Les processus de la machine dont la ligne de commande porte `fragment`. */
function processesWith(fragment: string): string[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'chrome-headless-shell.exe\'" | ForEach-Object { $_.CommandLine }',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return out.split(/\r?\n/).filter((l) => l.includes(fragment));
  }
  const out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(fragment));
}

describe('renderPdf: the number of pages asked @cap:travailler-sur-des-fichiers/moteur', () => {
  it('about 1.3 pages asked on 1: one page, at a scale below 1, counted on the PDF', async () => {
    const src = await page('long.html', tall(Math.round(A4_PRINTABLE_PX * 1.3)));
    const r = await render(src, { maxPages: 1 });

    const facts = await readPdfFacts(r.pdf);
    expect(facts.pages).toBe(1);
    expect(r.pages).toBe(1);
    expect(r.pagesAtFullScale).toBe(2);
    expect(r.scale).toBeLessThan(1);
    expect(r.scale).toBeGreaterThanOrEqual(MIN_READABLE_SCALE);
    // The largest that fits, at the hundredth: 1/1.3 ≈ 0.77.
    expect(r.scale).toBeGreaterThanOrEqual(0.74);
    expect(r.paper).toMatchObject({ name: 'A4', orientation: 'portrait' });
  });

  it('the same page asked on 2: two pages, at scale 1', async () => {
    const src = await page('long.html', tall(Math.round(A4_PRINTABLE_PX * 1.3)));
    const r = await render(src, { maxPages: 2 });
    expect((await readPdfFacts(r.pdf)).pages).toBe(2);
    expect(r.scale).toBe(1);
    expect(r.renders).toBe(1);
  });

  it('a page shorter than one page asked on 1: scale 1, never enlarged', async () => {
    const src = await page('short.html', tall(300));
    const r = await render(src, { maxPages: 1 });
    expect((await readPdfFacts(r.pdf)).pages).toBe(1);
    expect(r.scale).toBe(1);
  });

  it('a page that cannot fit even at the minimum scale fails loud, with the numbers', async () => {
    const src = await page('huge.html', tall(A4_PRINTABLE_PX * 4));
    const err = await render(src, { maxPages: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageRenderError);
    const e = err as PageRenderError;
    expect(e.code).toBe('DOES_NOT_FIT');
    expect(e.details).toMatchObject({ pagesAtFullScale: 4, pagesAtMinScale: 3 });
    expect(e.message).toBe(
      'The page does not fit on 1 page(s): it takes 4 page(s) at scale 1, and still 3 at 0.6, ' +
        'the smallest scale at which text stays readable. Nothing was written. Shorten the ' +
        'content or ask for more pages.',
    );
  });

  it('without pages: scale 1, and the page count stated', async () => {
    const src = await page('three.html', tall(A4_PRINTABLE_PX * 2.5));
    const r = await render(src);
    expect(r.scale).toBe(1);
    expect(r.pages).toBe(3);
    expect((await readPdfFacts(r.pdf)).pages).toBe(3);
  });
});

describe('renderPdf: paper @cap:travailler-sur-des-fichiers/moteur', () => {
  it('landscape, asked: the PDF page is A4 landscape', async () => {
    const r = await render(await page('l.html', tall(200)), {
      paper: { orientation: 'landscape' },
    });
    expect((await readPdfFacts(r.pdf)).paper).toMatchObject({
      name: 'A4',
      orientation: 'landscape',
    });
  });

  it("the page's CSS @page size decides when nothing is asked", async () => {
    const a5 = await render(await page('a5.html', tall(200, '@page { size: A5 }')));
    expect(a5.paper).toMatchObject({ name: 'A5', orientation: 'portrait' });
    const custom = await render(await page('c.html', tall(200, '@page { size: 100mm 150mm }')));
    // Chrome lays the paper out in whole CSS pixels: 100 mm is 377.95 px.
    expect(custom.paper).toMatchObject({ name: null, orientation: 'portrait' });
    expect(custom.paper.width_mm).toBeCloseTo(100, 0);
    expect(custom.paper.height_mm).toBeCloseTo(150, 0);
  });

  it('A4 when the page says nothing', async () => {
    const r = await render(await page('n.html', tall(200)));
    expect((await readPdfFacts(r.pdf)).paper).toMatchObject({
      name: 'A4',
      orientation: 'portrait',
    });
  });

  it("explicit paper and margins win over the page's CSS", async () => {
    const css = '@page { size: A5; margin: 0 }';
    // 900 px: one Letter page at 0 mm margins (1056 px tall), two at 60 mm.
    const src = await page('x.html', tall(900, css));
    const flat = await render(src, {
      paper: { format: 'Letter', marginsMm: { top: 0, right: 0, bottom: 0, left: 0 } },
    });
    expect((await readPdfFacts(flat.pdf)).paper).toMatchObject({
      name: 'Letter',
      orientation: 'portrait',
    });
    expect(flat.pages).toBe(1);
    const wide = await render(src, {
      paper: { format: 'Letter', marginsMm: { top: 60, right: 10, bottom: 60, left: 10 } },
    });
    expect(wide.pages).toBe(2);
    const turned = await render(src, { paper: { format: 'Letter', orientation: 'landscape' } });
    expect(turned.paper).toMatchObject({ name: 'Letter', orientation: 'landscape' });
  });
});

describe('renderPdf: what the page loads @cap:travailler-sur-des-fichiers/moteur', () => {
  let server: Server;
  let port: number;
  const visits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      visits.push(req.url ?? '');
      res
        .writeHead(200, { 'content-type': 'image/svg+xml' })
        .end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('local files inside the perimeter load; outside it, and file:// addresses, do not', async () => {
    await writeFile(
      join(dir, 'in.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>',
    );
    const src = await page(
      'p.html',
      '<!doctype html><img src="in.svg"><img src="../elsewhere.svg"><img src="file:///etc/hosts"><p>x</p>',
    );
    const r = await render(src);
    const urls = r.notLoaded.map((n) => n.url);
    expect(urls).not.toContain(join(dir, 'in.svg'));
    expect(r.notLoaded).toContainEqual({
      url: join(dir, '..', 'elsewhere.svg'),
      reason: 'outside the test folder',
    });
    expect(r.notLoaded).toContainEqual({
      url: 'file:///etc/hosts',
      reason: 'a file:// address; refer to local files by a path relative to the page',
    });
  });

  it('a perimeter read that throws does not hold the page: the resource is refused, said, and the page renders', async () => {
    const src = await page('t.html', '<!doctype html><p>x</p><img src="boom.svg">');
    const started = Date.now();
    const r = await render(src, {
      readLocal: async (p) => {
        if (p.endsWith('boom.svg')) throw new Error('EIO: simulated');
        return inDir(p);
      },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.pages).toBe(1);
    expect(r.notLoaded).toEqual([
      { url: join(dir, 'boom.svg'), reason: 'could not be served (EIO: simulated)' },
    ]);
  });

  it('a loopback or private address is never reached, by an element or by a script', async () => {
    visits.length = 0;
    const src = await page(
      'net.html',
      `<!doctype html><img src="http://127.0.0.1:${port}/img"><img src="http://localhost:${port}/name">` +
        `<img src="http://10.255.255.1/private.png">` +
        `<script>fetch('http://127.0.0.1:${port}/script').catch(() => {});</script><p>x</p>`,
    );
    const r = await render(src);
    expect(visits).toEqual([]);
    expect(r.notLoaded).toContainEqual({
      url: `http://127.0.0.1:${port}/img`,
      reason: `127.0.0.1 is a local or private address (127.0.0.1); the page renderer only loads the public internet`,
    });
    expect(r.notLoaded.map((n) => n.url)).toEqual(
      expect.arrayContaining([
        `http://localhost:${port}/name`,
        'http://10.255.255.1/private.png',
        `http://127.0.0.1:${port}/script`,
      ]),
    );
  });
});

describe('renderPdf: no renderer process outlives the call @cap:travailler-sur-des-fichiers/moteur', () => {
  it('after a render: the browser pid is gone, no process carries its profile, the profile is removed', async () => {
    const r = await render(await page('ok.html', tall(200)));
    expect(r.pid).toBeGreaterThan(0);
    expect(isProcessAlive(r.pid)).toBe(false);
    expect(existsSync(r.profileDir)).toBe(false);
    expect(processesWith(r.profileDir)).toEqual([]);
    expect(liveRendererPids()).toEqual([]);
  });

  it('after a time-out: loud, and the pid is gone', async () => {
    const src = await page('loop.html', '<!doctype html><script>for(;;){}</script>');
    const started = Date.now();
    const err = (await render(src, { timeoutMs: 4_000 }).catch(
      (e: unknown) => e,
    )) as PageRenderError;
    expect(err).toBeInstanceOf(PageRenderError);
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toMatch(/^The page did not render within 4 s\./);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(err.details.pid).toBeGreaterThan(0);
    expect(isProcessAlive(err.details.pid!)).toBe(false);
    expect(processesWith(err.details.profileDir!)).toEqual([]);
    expect(existsSync(err.details.profileDir!)).toBe(false);
  });

  it('after an error: the page itself refused, the pid is gone', async () => {
    const src = await page('denied.html', '<p>x</p>');
    const err = (await render(src, {
      readLocal: async () => ({ ok: false, reason: 'refused by the test' }),
    }).catch((e: unknown) => e)) as PageRenderError;
    expect(err.code).toBe('PAGE_FAILED');
    expect(isProcessAlive(err.details.pid!)).toBe(false);
    expect(existsSync(err.details.profileDir!)).toBe(false);
  });

  it('a caller killed outright (the runner crashing) leaves no browser behind', async () => {
    // Killed, not stopped: no shutdown code runs, the exit hook neither. The
    // browser holds its protocol on a pipe to its caller; the pipe closing is
    // what ends it. Only the script's own process is killed, never a tree: the
    // browser must go by itself.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const tsx = resolve(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const script = join(dir, 'caller.mts');
    await writeFile(join(dir, 'loop.html'), '<!doctype html><script>for(;;){}</script>');
    await writeFile(
      script,
      [
        `import { readFile } from 'node:fs/promises';`,
        `import { renderPdf, liveRendererPids } from ${JSON.stringify(pathToFileURL(resolve(here, '..', 'index.ts')).href)};`,
        `const t = setInterval(() => { const p = liveRendererPids(); if (p.length) { console.log('CALLER', process.pid, 'BROWSER', p[0]); clearInterval(t); } }, 50);`,
        `await renderPdf({ executablePath: ${JSON.stringify(exe)}, source: ${JSON.stringify(join(dir, 'loop.html'))}, readLocal: async (p) => ({ ok: true, bytes: await readFile(p) }), timeoutMs: 120000 });`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, [tsx, script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stdout?.on('data', (d: Buffer) => (said += String(d)));
    child.stderr?.on('data', (d: Buffer) => (said += String(d)));
    let ids: RegExpExecArray | null = null;
    for (let i = 0; i < 400 && ids === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ids = /CALLER (\d+) BROWSER (\d+)/.exec(said);
    }
    expect(ids, `the caller never started its browser: ${said}`).not.toBeNull();
    const caller = Number(ids![1]);
    const browser = Number(ids![2]);
    expect(isProcessAlive(browser)).toBe(true);
    try {
      // kill-by-pid: the caller, a process this test started and that lives.
      process.kill(caller, 'SIGKILL');
      const until = Date.now() + 10_000;
      while (isProcessAlive(browser) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(isProcessAlive(browser)).toBe(false);
    } finally {
      // kill-by-pid: whatever this test started, should the assertion fail.
      if (isProcessAlive(browser)) process.kill(browser, 'SIGKILL');
      child.kill('SIGKILL');
    }
  }, 60_000);

  it('a broken renderer program is its own clear error', async () => {
    const fake = join(dir, process.platform === 'win32' ? 'broken.exe' : 'broken');
    await writeFile(fake, 'not a program');
    const err = (await renderPdf({
      executablePath: fake,
      source: await page('b.html', '<p>x</p>'),
      readLocal: inDir,
    }).catch((e: unknown) => e)) as PageRenderError;
    expect(err).toBeInstanceOf(PageRenderError);
    expect(err.code).toBe('LAUNCH_FAILED');
    expect(err.message).toMatch(/^Nodal's page renderer did not start: /);
  });
});
