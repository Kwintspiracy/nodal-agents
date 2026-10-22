// suites-web-image-print.test.ts — les juges des pages HTML, des images ComfyUI et des impressions.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { htmlImages } from '../../printer/pages';
import { markReplaced, sha256Hex, writeRecord } from '../../printer/record';
import { HOME_HTML, WEATHER_CSV } from '../fixture-data';
import { fixturePath } from '../fixtures';
import { BENCH_PRINTER_MISSING, missingNeeds } from '../needs';
import { PRINT_FILE_REL, SHOPPING, scenarioById } from '../scenarios';
import { barsMatch } from '../suites/html';
import type { ScenarioEnv } from '../types';
import { play, png, type PlayEnv } from './harness';

const bench = (root: string, name: string): string => {
  mkdirSync(join(root, 'nodal-bench', name.includes('/') ? name.split('/')[0]! : ''), {
    recursive: true,
  });
  return join(root, 'nodal-bench', name);
};

// ─── HTML ────────────────────────────────────────────────────────────────────

const LANDING = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Au Pain Bench, boulangerie</title></head>
<body><h1>Au Pain Bench</h1>
<ul><li>Baguette : 1,20 €</li><li>Croissant : 1,10 €</li><li>Pain aux céréales - 3.50 EUR</li></ul>
<footer><p>12 rue des Lilas, Lyon</p></footer></body></html>`;

describe('html judges', () => {
  it('html-landing: title, one h1, three priced items and the footer address is green', async () => {
    expect(
      (
        await play('html-landing', {}, (root) =>
          writeFileSync(bench(root, 'boulangerie-bench.html'), LANDING),
        )
      ).reasons,
    ).toEqual([]);
  });

  it('html-landing: an address in a paragraph is not a footer; a commented title is not a title', async () => {
    const page = LANDING.replace('<footer>', '<div>')
      .replace('</footer>', '</div>')
      .replace(
        '<title>Au Pain Bench, boulangerie</title>',
        '<!-- <title>Au Pain Bench</title> --><title>Accueil</title>',
      );
    const r = await play('html-landing', {}, (root) =>
      writeFileSync(bench(root, 'boulangerie-bench.html'), page),
    );
    expect(r.reasons).toEqual([
      'the title element reads "Accueil", not "Au Pain Bench"',
      'no footer element holds "12 rue des Lilas, Lyon"',
    ]);
  });

  const MAX = WEATHER_CSV.split('\n')
    .slice(1)
    .map((l) => Number(l.split(',')[2]));
  /** Un graphique en barres des maxima, à l'échelle `scale` (le rapport seul compte). */
  const chart = (values: readonly number[] = MAX, scale = 10): string =>
    `<svg width="600" height="220">${values
      .map(
        (v, i) => `<rect x="${i * 60}" y="${200 - v * scale}" width="40" height="${v * scale}"/>`,
      )
      .join('')}</svg>`;
  const tablePage = (rows: string[][], svg = chart()): string =>
    `<html><body><table><thead><tr>${rows[0]!.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
      .slice(1)
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>${svg}</body></html>`;

  it('html-table-csv: the CSV rows, "12,5" for 12.5, and the bars of the max column is green; two rows swapped is red', async () => {
    const rows = WEATHER_CSV.split('\n').map((l) => l.split(','));
    const fr = rows.map((r) => r.map((c) => c.replace('.', ',')));
    expect(
      (
        await play('html-table-csv', {}, (root) =>
          writeFileSync(bench(root, 'meteo-bench.html'), tablePage(fr)),
        )
      ).reasons,
    ).toEqual([]);
    const swapped = [rows[0]!, rows[2]!, rows[1]!, ...rows.slice(3)];
    const r = await play('html-table-csv', {}, (root) =>
      writeFileSync(bench(root, 'meteo-bench.html'), tablePage(swapped)),
    );
    expect(r.reasons).toEqual([
      'row 2 reads ["mardi","9","17"], expected ["lundi","8","15"]',
      'row 3 reads ["lundi","8","15"], expected ["mardi","9","17"]',
    ]);
  });

  it('html-edit: the new title and footer, the body unchanged, is green', async () => {
    const page = HOME_HTML.replace(
      '<title>Accueil</title>',
      '<title>Accueil Bench 2026</title>',
    ).replace('</body>', '<footer>© 2026 Nodal Bench</footer>\n</body>');
    expect(
      (
        await play('html-edit', {}, (root) =>
          writeFileSync(join(root, 'nodal-bench', 'accueil.html'), page),
        )
      ).reasons,
    ).toEqual([]);
  });

  it('html-edit: a paragraph rewritten on the way is red', async () => {
    const page = HOME_HTML.replace('<title>Accueil</title>', '<title>Accueil Bench 2026</title>')
      .replace('depuis 1987', 'depuis 1988')
      .replace('</body>', '<footer>© 2026 Nodal Bench</footer></body>');
    const r = await play('html-edit', {}, (root) =>
      writeFileSync(join(root, 'nodal-bench', 'accueil.html'), page),
    );
    expect(r.reasons).toEqual(['the headings and paragraphs outside the footer changed']);
  });

  it('html-table-csv: bars of the min column, a missing chart, or a chart library from a CDN are red', async () => {
    const rows = WEATHER_CSV.split('\n').map((l) => l.split(','));
    const min = rows.slice(1).map((r) => Number(r[1]));
    const wrong = await play('html-table-csv', {}, (root) =>
      writeFileSync(bench(root, 'meteo-bench.html'), tablePage(rows, chart(min))),
    );
    expect(wrong.reasons).toEqual([
      `no 7 bars in the ratio of the max column 15 : 17 : 14 : 12.5 : 18 : 19 : 16 (rect heights: ${min.map((v) => v * 10).join(', ')})`,
    ]);
    const none = await play('html-table-csv', {}, (root) =>
      writeFileSync(bench(root, 'meteo-bench.html'), tablePage(rows, '')),
    );
    expect(none.reasons).toEqual(['no inline svg element']);
    const cdn = await play('html-table-csv', {}, (root) =>
      writeFileSync(
        bench(root, 'meteo-bench.html'),
        tablePage(rows).replace(
          '<html>',
          '<html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head>',
        ),
      ),
    );
    expect(cdn.reasons).toEqual([
      'the page loads from another site: https://cdn.jsdelivr.net/npm/chart.js',
    ]);
  });

  it('barsMatch: the ratio within 5 %, whatever the scale; equal bars are not a chart', () => {
    expect(barsMatch([12, 30, 58], [12, 30, 58])).toBe(true);
    expect(barsMatch([24, 60.5, 116], [12, 30, 58])).toBe(true);
    expect(barsMatch([50, 50, 50], [12, 30, 58])).toBe(false);
    expect(barsMatch([10, 30, 58], [12, 30, 58])).toBe(false);
  });
});

// ─── ComfyUI ─────────────────────────────────────────────────────────────────

describe('comfyui judges', () => {
  it('needs a ComfyUI that answers: skipped otherwise, with the reason', () => {
    const s = scenarioById('comfy-exact-size')!;
    const env = {
      workspaceRoots: [],
      teamTools: [],
      unlistedMcpServers: [],
      benchPrinter: { kind: 'absent' as const },
      startedMs: 0,
    };
    expect(missingNeeds(s.needs ?? [], { ...env, services: {} })).toEqual([
      'no ComfyUI address is declared for the bench (services.comfyui in ~/.nodalai/bench.json)',
    ]);
    expect(
      missingNeeds(s.needs ?? [], {
        ...env,
        services: { comfyui: { url: 'http://127.0.0.1:8188', problem: 'fetch failed' } },
      }),
    ).toEqual(['ComfyUI at http://127.0.0.1:8188 does not answer: fetch failed']);
    expect(
      missingNeeds(s.needs ?? [], {
        ...env,
        services: { comfyui: { url: 'http://127.0.0.1:8188', problem: null } },
      }),
    ).toEqual([]);
  });

  it('comfy-exact-size: one PNG of 768 × 1152 is green; the size read from the header, not the name', async () => {
    expect(
      (
        await play('comfy-exact-size', {}, (root) =>
          writeFileSync(bench(root, 'comfy-portrait/astronaute.png'), png(768, 1152)),
        )
      ).reasons,
    ).toEqual([]);
    const r = await play('comfy-exact-size', {}, (root) =>
      writeFileSync(bench(root, 'comfy-portrait/astronaute.png'), png(1152, 768)),
    );
    expect(r.reasons).toEqual([
      'nodal-bench/comfy-portrait/astronaute.png is 1152 × 768, expected 768 × 1152',
    ]);
  });

  it('comfy-variants: three distinct PNGs is green; the same image three times is red', async () => {
    const three = (seeds: number[]) => (root: string) =>
      seeds.forEach((s, i) =>
        writeFileSync(bench(root, `comfy-variantes/chat-${i}.png`), png(768, 768, s)),
      );
    expect((await play('comfy-variants', {}, three([1, 2, 3]))).reasons).toEqual([]);
    expect((await play('comfy-variants', {}, three([7, 7, 7]))).reasons).toEqual([
      'two images are the same file',
    ]);
  });

  it('comfy-exact-size: a JPEG renamed .png is red; an image sent on Telegram is red', async () => {
    // Un en-tête JPEG (SOI, APP0 JFIF, SOF0 768 × 1152, EOI) : le bon format… sauf que ce n'est pas un PNG.
    const jpeg = Buffer.from([
      255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 192, 0, 17, 8,
      4, 128, 3, 0, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 255, 217,
    ]);
    const r = await play('comfy-exact-size', {}, (root) =>
      writeFileSync(bench(root, 'comfy-portrait/astronaute.png'), jpeg),
    );
    expect(r.reasons).toEqual(['nodal-bench/comfy-portrait/astronaute.png is jpg, not PNG']);
    const sent = await play(
      'comfy-exact-size',
      { tools: [{ name: 'send_image', input: { source: 'astronaute.png' } }] },
      (root) => writeFileSync(bench(root, 'comfy-portrait/astronaute.png'), png(768, 1152)),
    );
    expect(sent.reasons).toEqual(['a send tool was called (send_image)']);
  });
});

// ─── print ───────────────────────────────────────────────────────────────────
//
// Les trois scénarios d'impression sont jugés sur l'enregistrement de
// l'imprimante du banc (#794). Les enregistrements ci-dessous sont écrits par le
// vrai écrivain du serveur (`writeRecord`) ; le serveur lui-même, de bout en bout
// par un vrai client MCP, est éprouvé dans printer/tests/server.test.ts.

describe('print judges, from the bench printer record (#794)', () => {
  const REQ = 'bench_printer__request_print';
  const GET = 'bench_printer__get_print_request';
  const TEAM = [REQ, GET];
  const OUT = (...tools: string[]) => `an outbound tool was called (${tools.join(', ')})`;
  const POSED_PDF = fixturePath('office/facture-bench.pdf');
  const short = (b: Buffer): string => sha256Hex(b).slice(0, 12);

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-printer-judge-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const attached = (): PlayEnv => ({
    teamTools: TEAM,
    benchPrinter: { kind: 'attached', recordsDir: dir },
  });

  /** Ce que le serveur écrit pour un fichier reçu. */
  function receiveFile(
    bytes: Buffer,
    over: { pages?: number | null; path?: string; nowMs?: number } = {},
  ) {
    return writeRecord(
      dir,
      {
        source: { kind: 'file', path: over.path ?? join(dir, 'whatever.pdf') },
        bytes,
        pages: over.pages === undefined ? 1 : over.pages,
        pagesBasis: 'pdf',
        images: null,
        arguments: { filePath: over.path ?? join(dir, 'whatever.pdf') },
      },
      over.nowMs,
    );
  }

  /** Ce que le serveur écrit pour un contenu composé. */
  function receiveContent(html: string, over: { pages?: number | null } = {}) {
    return writeRecord(dir, {
      source: { kind: 'content', contentFormat: 'html' },
      bytes: Buffer.from(html, 'utf8'),
      pages: over.pages === undefined ? 1 : over.pages,
      pagesBasis: 'html-estimate',
      images: htmlImages(html),
      arguments: { content: html },
    });
  }

  const call = (input: object) => ({ name: REQ, input });

  // ── print-file ──

  it('print-file: green when the printer received the posed file, and only it', async () => {
    const r = await play(
      'print-file',
      (root) => ({ tools: [call({ filePath: join(root, PRINT_FILE_REL) })] }),
      () => {
        receiveFile(readFileSync(POSED_PDF));
      },
      attached(),
    );
    expect(r.reasons).toEqual([]);
  });

  it('print-file: red when the printer received another file, whatever the call says it printed', async () => {
    const other = Buffer.from('%PDF-1.4 not the invoice');
    const r = await play(
      'print-file',
      (root) => ({ tools: [call({ filePath: join(root, PRINT_FILE_REL) })] }),
      () => {
        receiveFile(other);
      },
      attached(),
    );
    expect(r.reasons).toEqual([
      `the content the bench printer received is not the posed file (sha-256 ${short(other)}, expected ${short(readFileSync(POSED_PDF))})`,
    ]);
  });

  it('print-file: red when two files were printed, the posed one and another', async () => {
    const other = Buffer.from('%PDF-1.4 a second file');
    const r = await play(
      'print-file',
      { tools: [call({}), call({})] },
      () => {
        receiveFile(readFileSync(POSED_PDF));
        receiveFile(other);
      },
      attached(),
    );
    expect(r.reasons).toEqual([`another file was printed too (sha-256 ${short(other)})`]);
  });

  it('print-file: red when the printer recorded nothing, even though the agent called the tool', async () => {
    const r = await play('print-file', { tools: [call({ filePath: 'x' })] }, undefined, attached());
    expect(r.reasons).toEqual(['no print request was created']);
  });

  it('print-file: a wrong file replaced by the posed one is green: only the standing request counts', async () => {
    const r = await play(
      'print-file',
      { tools: [call({}), call({})] },
      () => {
        const wrong = receiveFile(Buffer.from('%PDF-1.4 wrong'));
        const right = receiveFile(readFileSync(POSED_PDF));
        expect(markReplaced(dir, wrong.id, right.id)).toBe(true);
      },
      attached(),
    );
    expect(r.reasons).toEqual([]);
  });

  it('print-file: the posed file replaced by a wrong one is red: the standing request is the wrong one', async () => {
    const wrong = Buffer.from('%PDF-1.4 wrong');
    const r = await play(
      'print-file',
      { tools: [call({}), call({})] },
      () => {
        const right = receiveFile(readFileSync(POSED_PDF));
        const w = receiveFile(wrong);
        expect(markReplaced(dir, right.id, w.id)).toBe(true);
      },
      attached(),
    );
    expect(r.reasons).toEqual([
      `the content the bench printer received is not the posed file (sha-256 ${short(wrong)}, expected ${short(readFileSync(POSED_PDF))})`,
    ]);
  });

  it('print-file: a request from before the trial is not this trial: nothing was created', async () => {
    const r = await play(
      'print-file',
      { tools: [call({})] },
      () => {
        receiveFile(readFileSync(POSED_PDF), { nowMs: Date.now() - 3_600_000 });
      },
      attached(),
    );
    expect(r.reasons).toEqual(['no print request was created']);
  });

  it('print-file: a record whose bytes do not match its sha-256 is a problem, said, never a print', async () => {
    const r = await play(
      'print-file',
      { tools: [call({})] },
      () => {
        const rec = receiveFile(readFileSync(POSED_PDF));
        writeFileSync(join(dir, `${rec.id}.bytes`), 'tampered');
      },
      attached(),
    );
    expect(r.reasons).toEqual([
      expect.stringContaining('does not match the size and sha-256 its record declares'),
      'no print request was created',
    ]);
  });

  it('print-file: a printer whose record folder never existed is said, with no request', async () => {
    const gone = join(dir, 'never-created');
    const r = await play('print-file', { tools: [call({})] }, undefined, {
      teamTools: TEAM,
      benchPrinter: { kind: 'attached', recordsDir: gone },
    });
    expect(r.reasons).toEqual([
      `the bench printer's record folder ${gone} does not exist: the server never started`,
      'no print request was created',
    ]);
  });

  it('print-file: without the bench printer attached there is no record to judge, never green', async () => {
    const r = await play('print-file', { tools: [call({})] }, undefined, { teamTools: TEAM });
    expect(r.reasons).toEqual([
      'the bench printer is not attached to this workspace: there is no record to judge',
    ]);
  });

  it('print-file: a request of two pages is red when the printer counted them', async () => {
    const r = await play(
      'print-file',
      { tools: [call({})] },
      () => {
        receiveFile(readFileSync(POSED_PDF), { pages: 2 });
      },
      attached(),
    );
    expect(r.reasons).toEqual(['2 pages, not one']);
  });

  // ── l'identité du serveur, pas le nom de l'outil ──

  it('a request_print of another server is still an outbound tool, though the record is right', async () => {
    const r = await play(
      'print-file',
      { tools: [{ name: 'office_printer__request_print', input: {} }] },
      () => {
        receiveFile(readFileSync(POSED_PDF));
      },
      attached(),
    );
    expect(r.reasons).toEqual([OUT('office_printer__request_print')]);
  });

  // ── print ──

  const LIST = `<ul>${SHOPPING.map((x) => `<li>${x}</li>`).join('')}</ul>`;

  it('print: green when the received content holds every item', async () => {
    const r = await play(
      'print',
      { tools: [call({ content: LIST })] },
      () => {
        receiveContent(LIST);
      },
      attached(),
    );
    expect(r.reasons).toEqual([]);
  });

  it('print: red when an item is missing from what the printer received, by what it lacks', async () => {
    const r = await play(
      'print',
      { tools: [call({ content: LIST })] },
      () => {
        receiveContent('<ul><li>pain</li><li>lait</li><li>œufs</li><li>café</li></ul>');
      },
      attached(),
    );
    expect(r.reasons).toEqual([
      'no print request holds the whole list (pain, lait, œufs, tomates, café)',
    ]);
  });

  it('print: the call input is not what is judged: a complete input, an incomplete record, is red', async () => {
    const r = await play(
      'print',
      { tools: [call({ content: LIST })] },
      () => {
        receiveContent('<p>pain</p>');
      },
      attached(),
    );
    expect(r.reasons).toEqual([
      'no print request holds the whole list (pain, lait, œufs, tomates, café)',
    ]);
  });

  it('print: red when no request was created', async () => {
    const r = await play('print', { tools: [] }, undefined, attached());
    expect(r.reasons).toEqual([
      'no print request was created',
      'product tool available, not used: none of request_print was called',
    ]);
  });

  it('print: confirm_print called is red even with a pending request', async () => {
    const r = await play(
      'print',
      { tools: [call({ content: LIST }), { name: 'bench_printer__confirm_print', input: {} }] },
      () => {
        receiveContent(LIST);
      },
      attached(),
    );
    expect(r.reasons).toEqual([
      'the agent called confirm_print',
      OUT('bench_printer__confirm_print'),
    ]);
  });

  it('print: a page of two pages is red when the printer estimated two', async () => {
    const r = await play(
      'print',
      { tools: [call({ content: LIST })] },
      () => {
        receiveContent(LIST, { pages: 2 });
      },
      attached(),
    );
    expect(r.reasons).toEqual(['2 pages, not one']);
  });

  // ── recipe ──

  const RECIPE = '<h1>Caviar d\'aubergines</h1><img src="https://example.org/caviar.jpg"><p>…</p>';

  it('recipe: green on a pending page with a picture the document references', async () => {
    const r = await play(
      'recipe',
      { tools: [call({ content: RECIPE })] },
      () => {
        receiveContent(RECIPE);
      },
      attached(),
    );
    expect(r.reasons).toEqual([]);
  });

  it('recipe: red when the printed page references no picture', async () => {
    const r = await play(
      'recipe',
      { tools: [call({ content: '<h1>Caviar</h1>' })] },
      () => {
        receiveContent('<h1>Caviar</h1>');
      },
      attached(),
    );
    expect(r.reasons).toEqual(['no photo in the printed page']);
  });

  it('recipe: a file printed as is cannot show its pictures, and the judge says so rather than that none exist', async () => {
    const r = await play(
      'recipe',
      { tools: [call({ filePath: POSED_PDF })] },
      () => {
        receiveFile(readFileSync(POSED_PDF), { path: POSED_PDF });
      },
      attached(),
    );
    expect(r.reasons).toEqual([
      'the request prints an existing file (facture-bench.pdf, made before this run), whose pictures the printer does not report: the photo cannot be checked',
    ]);
  });

  it('recipe: red when nothing was printed', async () => {
    const r = await play('recipe', { tools: [] }, undefined, attached());
    expect(r.reasons).toEqual([
      'no print request was created',
      'product tool available, not used: none of request_print was called',
    ]);
  });

  it('recipe: a first request replaced by a second one is judged on the second', async () => {
    const r = await play(
      'recipe',
      { tools: [call({}), call({})] },
      () => {
        const first = receiveContent('<h1>no picture</h1>');
        const second = receiveContent(RECIPE);
        expect(markReplaced(dir, first.id, second.id)).toBe(true);
      },
      attached(),
    );
    expect(r.reasons).toEqual([]);
  });
});

// ─── le besoin « bench-printer » ─────────────────────────────────────────────

describe('the bench-printer need (#794)', () => {
  const env = (over: Partial<ScenarioEnv> = {}): ScenarioEnv => ({
    workspaceRoots: [],
    teamTools: [],
    unlistedMcpServers: [],
    benchPrinter: { kind: 'absent' },
    services: {},
    startedMs: 0,
    ...over,
  });
  const attached: ScenarioEnv['benchPrinter'] = { kind: 'attached', recordsDir: '/records' };

  it.each(['print-file', 'print', 'recipe'])(
    '%s needs the bench printer, and no longer the real printer connector',
    (id) => {
      expect(scenarioById(id)!.needs).toEqual(['bench-printer']);
    },
  );

  it('is missing while the server is not attached, whatever tools the team has', () => {
    expect(missingNeeds(['bench-printer'], env())).toEqual([BENCH_PRINTER_MISSING]);
    expect(
      missingNeeds(
        ['bench-printer'],
        env({ teamTools: ['office_printer__request_print', 'office_printer__get_print_request'] }),
      ),
    ).toEqual([BENCH_PRINTER_MISSING]);
  });

  it('is met when the server is attached to the team', () => {
    expect(
      missingNeeds(
        ['bench-printer'],
        env({
          benchPrinter: attached,
          teamTools: ['bench_printer__request_print', 'bench_printer__get_print_request'],
        }),
      ),
    ).toEqual([]);
  });

  it('is missing, with its reason, when a server of that name is declared otherwise', () => {
    expect(
      missingNeeds(
        ['bench-printer'],
        env({
          benchPrinter: { kind: 'broken', reason: 'the "bench-printer" server declares nothing' },
        }),
      ),
    ).toEqual(['the "bench-printer" server declares nothing']);
  });

  it('is missing while another tool of the team can print: no request on a real printer', () => {
    expect(
      missingNeeds(
        ['bench-printer'],
        env({
          benchPrinter: attached,
          teamTools: [
            'bench_printer__request_print',
            'office_printer__request_print',
            'office_printer__confirm_print',
            'office_printer__list_printers',
            'office_printer__get_print_request',
          ],
        }),
      ),
    ).toEqual([
      'an agent of this workspace can print outside the bench printer (office_printer__request_print, office_printer__confirm_print): print trials never create a request on a real printer, so this scenario does not run here',
    ]);
  });
});
