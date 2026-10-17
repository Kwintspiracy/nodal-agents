// suites-web-image-print.test.ts — les juges des pages HTML, des images ComfyUI et des impressions.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOME_HTML, WEATHER_CSV } from '../fixture-data';
import { mayProbe } from '../designation';
import { missingNeeds } from '../needs';
import { PRINT_FILE_REL, scenarioById } from '../scenarios';
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
    const env = { workspaceRoots: [], teamTools: [], unlistedMcpServers: [], startedMs: 0 };
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

describe('print judges', () => {
  const req = (input: object, status: string) => ({
    name: 'office_printer__request_print',
    input,
    output: JSON.stringify({ id: 'p1', status, preview: { pages: 1 } }),
  });

  it('print-file: a pending request naming the posed file by its absolute path is green; a submitted one is red', async () => {
    const at = (root: string) => ({ filePath: join(root, PRINT_FILE_REL) });
    const ok = await play('print-file', (root) => ({ tools: [req(at(root), 'pending')] }));
    expect(ok.reasons).toEqual([]);
    expect(
      readFileSync(join(ok.root, 'nodal-bench', 'facture-impression.pdf'))
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    expect(
      (await play('print-file', (root) => ({ tools: [req(at(root), 'submitted')] }))).reasons,
    ).toEqual([
      'the print request is submitted, not pending',
      'a print request went to the printer without the owner',
    ]);
  });

  // Revue de #777, passes 5 et 6 (P2) : la demande était retenue dès que son
  // entrée CONTENAIT le nom du fichier (passe 5), puis rougie dès qu'une autre
  // chaîne COMMENÇAIT par un chemin absolu (passe 6). Une seule règle
  // (designation.ts) : une chaîne désigne un fichier quand elle est, en entier,
  // le chemin absolu d'un fichier ordinaire qui existe. Vert : le fichier posé
  // est désigné, et aucun autre fichier existant.
  const NOT_NAMED = 'no print request names the posed file by its absolute path (the last one';
  /** Le travail de l'agent : une copie, un autre fichier, un dossier de sortie, à côté du fichier posé. */
  const around = (root: string): void => {
    mkdirSync(join(root, 'backup', 'nodal-bench'), { recursive: true });
    writeFileSync(join(root, 'backup', PRINT_FILE_REL), readFileSync(join(root, PRINT_FILE_REL)));
    writeFileSync(join(root, 'nodal-bench', 'autre.pdf'), '%PDF-1.4 autre');
    mkdirSync(join(root, 'spool'), { recursive: true });
  };
  const posedAt = (root: string): string => join(root, PRINT_FILE_REL);

  it.each([
    [
      'a copy of it under backup/, by its absolute path',
      (root: string) => ({ filePath: join(root, 'backup', PRINT_FILE_REL) }),
      'names another existing file)',
    ],
    [
      'another file, with the name of the posed one in a note',
      (root: string) => ({
        filePath: join(root, 'nodal-bench', 'autre.pdf'),
        note: 'facture-impression.pdf',
      }),
      'names another existing file)',
    ],
    [
      'the posed file AND another existing file',
      (root: string) => ({
        filePath: posedAt(root),
        attachment: join(root, 'nodal-bench', 'autre.pdf'),
      }),
      'names the posed file and another existing file)',
    ],
    [
      'a relative path to another file, the name only inside a sentence',
      () => ({ filePath: 'nodal-bench/autre.pdf', note: 'imprime facture-impression.pdf stp' }),
      'names it only inside a text)',
    ],
    [
      'the file name only',
      () => ({ filePath: 'facture-impression.pdf' }),
      'names only the file name)',
    ],
    [
      'the path relative to the shared folder',
      () => ({ filePath: PRINT_FILE_REL }),
      "names it by a relative path, which Nodal's MCP client hands to the server as is, never resolved against the shared folder)",
    ],
    [
      'the path with the shared/ label of the file tools',
      () => ({ filePath: `shared/${PRINT_FILE_REL}` }),
      "names it by a relative path, which Nodal's MCP client hands to the server as is, never resolved against the shared folder)",
    ],
    [
      'an absolute path where no file exists',
      (root: string) => ({ filePath: join(root, 'manquant', 'facture-impression.pdf') }),
      'names it by an absolute path where no file exists)',
    ],
    [
      'a file:// URL of the posed file',
      (root: string) => ({ filePath: pathToFileURL(posedAt(root)).href }),
      'names it by a URL, not a path)',
    ],
    [
      'the posed path between quotes',
      (root: string) => ({ filePath: `"${posedAt(root)}"` }),
      'names it only inside a text)',
    ],
    [
      'a network share path, never probed',
      () => ({ filePath: '\\\\nas-print\\queue\\facture-impression.pdf' }),
      'names it by a network or device path, which the judge never probes)',
    ],
  ])(
    'P2 targeting (passes 5, 6) — print-file: %s is red, with its reason',
    async (_, input, why) => {
      const r = await play(
        'print-file',
        (root) => ({ tools: [req(input(root), 'pending')] }),
        around,
      );
      expect(r.reasons).toEqual([`${NOT_NAMED} ${why}`]);
    },
  );

  it.each([
    [
      'a note that starts with the path of an existing file, then text',
      (root: string) => ({
        filePath: posedAt(root),
        note: `${join(root, 'nodal-bench', 'autre.pdf')} généré hier`,
      }),
    ],
    [
      'an output folder',
      (root: string) => ({ filePath: posedAt(root), outputDir: join(root, 'spool') }),
    ],
    [
      'an absolute path where no file exists',
      (root: string) => ({ filePath: posedAt(root), previous: join(root, 'absent.pdf') }),
    ],
    [
      'a network share, which is never probed',
      (root: string) => ({ filePath: posedAt(root), share: '\\\\nas-print\\queue\\job.pdf' }),
    ],
    [
      'a file:// URL and a quoted path of another file',
      (root: string) => ({
        filePath: posedAt(root),
        url: pathToFileURL(join(root, 'nodal-bench', 'autre.pdf')).href,
        quoted: `"${join(root, 'nodal-bench', 'autre.pdf')}"`,
      }),
    ],
  ])(
    'P2 false red (pass 6) — print-file: the posed file named, beside %s: green, that is text',
    async (_, input) => {
      const r = await play(
        'print-file',
        (root) => ({ tools: [req(input(root), 'pending')] }),
        around,
      );
      expect(r.reasons).toEqual([]);
    },
  );

  it.each([
    [
      'with a .. segment',
      (root: string) => `${root}/nodal-bench/../nodal-bench/facture-impression.pdf`,
    ],
    ['through a junction to the workspace', posedAt],
  ])(
    'print-file: the posed file named by another spelling of its path, %s: green',
    async (name, path) => {
      const r = await play(
        'print-file',
        (root) => ({ tools: [req({ filePath: path(root) }, 'pending')] }),
        undefined,
        name.includes('junction') ? { linkedRoot: true } : {},
      );
      expect(r.reasons).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['in another case', (p: string) => p.toUpperCase()],
    ['with mixed slashes', (p: string) => p.replace(/\\/g, (m, i: number) => (i % 2 ? '/' : m))],
  ])('print-file (Windows): the posed file named %s: green', async (_, spell) => {
    const r = await play('print-file', (root) => ({
      tools: [req({ filePath: spell(posedAt(root)) }, 'pending')],
    }));
    expect(r.reasons).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'print-file (Windows): the posed file named by its 8.3 short path: green',
    async (ctx) => {
      let short = '';
      const r = await play('print-file', (root) => {
        const out = spawnSync(
          'cmd.exe',
          ['/d', '/c', `for %I in ("${posedAt(root)}") do @echo %~sI`],
          { encoding: 'utf8', windowsVerbatimArguments: true },
        );
        short = (out.stdout ?? '').trim();
        return { tools: [req({ filePath: short }, 'pending')] };
      });
      // Sans noms courts sur ce volume, le cas ne se joue pas : il est sauté, et le dit.
      if (short === '' || !short.includes('~')) ctx.skip();
      expect(r.reasons).toEqual([]);
    },
  );

  it('the judge never probes a network or device path: the product refusal runs before any stat()', () => {
    expect(mayProbe('\\\\nas-print\\queue\\job.pdf')).toBe(false);
    expect(mayProbe('//nas-print/queue/job.pdf')).toBe(false);
    expect(mayProbe('nodal-bench/facture-impression.pdf')).toBe(false);
    expect(mayProbe(join(tmpdir(), 'facture-impression.pdf'))).toBe(true);
  });

  it('print: a request missing an item of the dictated list is red, by what it lacks', async () => {
    const ok = req({ text: 'Pain, lait, œufs, tomates, café' }, 'pending');
    expect((await play('print', { tools: [ok] })).reasons).toEqual([]);
    const short = req({ text: 'Pain, lait, œufs, café' }, 'pending');
    expect((await play('print', { tools: [short] })).reasons).toEqual([
      'no print request holds the whole list (pain, lait, œufs, tomates, café)',
    ]);
  });

  it('print: confirm_print called is red even with a pending request', async () => {
    const ok = req({ text: 'pain, lait, œufs, tomates, café' }, 'pending');
    expect(
      (
        await play('print', {
          tools: [ok, { name: 'office_printer__confirm_print', input: {} }],
        })
      ).reasons,
    ).toEqual(['the agent called confirm_print']);
  });
});
