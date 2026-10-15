// suites-web-image-print.test.ts — les juges des pages HTML, des images ComfyUI et des impressions.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOME_HTML, WEATHER_CSV } from '../fixture-data';
import { missingNeeds } from '../needs';
import { scenarioById } from '../scenarios';
import { barsMatch } from '../suites/html';
import { play, png } from './harness';

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

  const tablePage = (rows: string[][]): string =>
    `<table><thead><tr>${rows[0]!.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
      .slice(1)
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;

  it('html-table-csv: the CSV rows, "12,5" for 12.5, is green; two rows swapped is red', async () => {
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

  it('html-svg-chart: bars scaled ×3 keep the ratio and are green; a chart library from a CDN is red', async () => {
    const svg = `<svg width="400" height="200"><rect x="0" y="150" width="50" height="36"/><rect x="60" y="110" width="50" height="90"/><rect x="120" y="26" width="50" height="174"/><text>janvier</text><text>février</text><text>mars</text></svg>`;
    expect(
      (
        await play('html-svg-chart', {}, (root) =>
          writeFileSync(bench(root, 'graphique-bench.html'), `<html><body>${svg}</body></html>`),
        )
      ).reasons,
    ).toEqual([]);
    const cdn = `<html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head><body>${svg}</body></html>`;
    const r = await play('html-svg-chart', {}, (root) =>
      writeFileSync(bench(root, 'graphique-bench.html'), cdn),
    );
    expect(r.reasons).toEqual([
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
    const s = scenarioById('comfy-square')!;
    const env = { workspaceRoots: [], teamTools: [], startedMs: 0 };
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

  it('comfy-square: one PNG of 1024 × 1024 is green; the size read from the header, not the name', async () => {
    expect(
      (
        await play('comfy-square', {}, (root) =>
          writeFileSync(bench(root, 'comfy-phare/phare.png'), png(1024, 1024)),
        )
      ).reasons,
    ).toEqual([]);
    const r = await play('comfy-square', {}, (root) =>
      writeFileSync(bench(root, 'comfy-phare/phare.png'), png(512, 512)),
    );
    expect(r.reasons).toEqual([
      'nodal-bench/comfy-phare/phare.png is 512 × 512, expected 1024 × 1024',
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

  it('comfy-portrait: a JPEG renamed .png is red; an image sent on Telegram is red', async () => {
    // Un en-tête JPEG (SOI, APP0 JFIF, SOF0 768 × 1152, EOI) : le bon format… sauf que ce n'est pas un PNG.
    const jpeg = Buffer.from([
      255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 192, 0, 17, 8,
      4, 128, 3, 0, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 255, 217,
    ]);
    const r = await play('comfy-portrait', {}, (root) =>
      writeFileSync(bench(root, 'comfy-portrait/astronaute.png'), jpeg),
    );
    expect(r.reasons).toEqual(['nodal-bench/comfy-portrait/astronaute.png is jpg, not PNG']);
    const sent = await play(
      'comfy-portrait',
      { tools: [{ name: 'send_image', input: { source: 'astronaute.png' } }] },
      (root) => writeFileSync(bench(root, 'comfy-portrait/astronaute.png'), png(768, 1152)),
    );
    expect(sent.reasons).toEqual(['a send tool was called (send_image)']);
  });
});

// ─── print ───────────────────────────────────────────────────────────────────

describe('print judges', () => {
  const req = (input: object, status: string) => ({
    name: 'office_printer__request_print',
    input,
    output: JSON.stringify({ id: 'p1', status, preview: { pages: 1 } }),
  });

  it('print-file: a pending request naming the fixture file is green; a submitted one is red', async () => {
    const input = { filePath: 'C:/ws/shared/nodal-bench/facture-impression.pdf' };
    const ok = await play('print-file', { tools: [req(input, 'pending')] });
    expect(ok.reasons).toEqual([]);
    expect(
      readFileSync(join(ok.root, 'nodal-bench', 'facture-impression.pdf'))
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    expect((await play('print-file', { tools: [req(input, 'submitted')] })).reasons).toEqual([
      'the print request is submitted, not pending',
      'a print request went to the printer without the owner',
    ]);
  });

  it('print-list: a request missing an item of the list is red, by what it lacks', async () => {
    const ok = req({ text: 'Pain, lait, œufs, tomates, café' }, 'pending');
    expect((await play('print-list', { tools: [ok] })).reasons).toEqual([]);
    const short = req({ text: 'Pain, lait, œufs, café' }, 'pending');
    expect((await play('print-list', { tools: [short] })).reasons).toEqual([
      'no print request holds the whole list (pain, lait, œufs, tomates, café)',
    ]);
  });

  it('print-list: confirm_print called is red even with a pending request', async () => {
    const ok = req({ text: 'pain, lait, œufs, tomates, café' }, 'pending');
    expect(
      (
        await play('print-list', {
          tools: [ok, { name: 'office_printer__confirm_print', input: {} }],
        })
      ).reasons,
    ).toEqual(['the agent called confirm_print']);
  });
});
