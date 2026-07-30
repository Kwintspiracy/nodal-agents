// next-chunk-integrity.test.mjs — the guard that would have stopped 0.8.0 from
// reaching npm with a dashboard that could never render.
//
// Assertions are on real results: the chunk ids parsed out of the ACTUAL
// webpack runtime call emitted in nodal-agents@0.8.0's (dashboard)/page.js, and
// the missing-chunk report produced from a staged build on disk.
//
// Run from the repo root: pnpm test:scripts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requiredChunkIds,
  scanServerChunks,
  formatMissingChunks,
} from '../lib/next-chunk-integrity.mjs';

// Verbatim tail of web/.next/server/app/(dashboard)/page.js in the published
// 0.8.0 tarball. 5773, 8909 and 2575 are the three the standalone copy dropped.
const REAL_PAGE_TAIL =
  '"use strict";a.exports=require("discord.js")},94735:a=>{"use strict";a.exports=require("events")}};' +
  'var b=require("../../webpack-runtime.js");b.C(a);' +
  'var c=b.X(0,[4674,3159,8437,960,7388,6402,7406,5773,8909,4574,3532,2575],()=>b(b.s=49130));' +
  'module.exports=c})();';

describe('requiredChunkIds', () => {
  it('extracts every id from the real 0.8.0 dashboard entry, in order', () => {
    expect(requiredChunkIds(REAL_PAGE_TAIL)).toEqual([
      '4674',
      '3159',
      '8437',
      '960',
      '7388',
      '6402',
      '7406',
      '5773',
      '8909',
      '4574',
      '3532',
      '2575',
    ]);
  });

  it('returns nothing for an entry that loads no extra chunks', () => {
    expect(requiredChunkIds('var c=b.X(0,[],()=>b(b.s=123));')).toEqual([]);
  });

  it('does not mistake a require("discord.js") for a chunk id', () => {
    expect(requiredChunkIds('a.exports=require("discord.js");var c=b.X(0,[42],()=>0);')).toEqual([
      '42',
    ]);
  });

  it('merges ids across several runtime calls without duplicating', () => {
    expect(requiredChunkIds('b.X(0,[1,2],()=>0);b.X(1,[2,3],()=>0);')).toEqual(['1', '2', '3']);
  });
});

describe('scanServerChunks', () => {
  let dir;

  // A staged build reproducing 0.8.0's shape: entries requiring 12 chunks,
  // 9 of them on disk. Nested route groups and an API route are included
  // because the real tree has them and the walker must reach both.
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nodal-chunks-'));
    const server = join(dir, '.next', 'server');
    mkdirSync(join(server, 'chunks'), { recursive: true });
    mkdirSync(join(server, 'app', '(dashboard)', 'jobs'), { recursive: true });
    mkdirSync(join(server, 'app', 'api', 'health'), { recursive: true });

    for (const id of ['4674', '3159', '8437', '960', '7388', '6402', '7406', '4574', '3532']) {
      writeFileSync(join(server, 'chunks', `${id}.js`), `exports.id=${id};`);
    }
    writeFileSync(join(server, 'app', '(dashboard)', 'page.js'), REAL_PAGE_TAIL);
    writeFileSync(
      join(server, 'app', '(dashboard)', 'jobs', 'page.js'),
      'var c=b.X(0,[4674,5773],()=>0);',
    );
    writeFileSync(join(server, 'app', 'api', 'health', 'route.js'), 'var c=b.X(0,[960],()=>0);');
    writeFileSync(join(server, 'middleware.js'), 'var c=b.X(0,[3159],()=>0);');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names the missing chunks and every entry that needs them', () => {
    const result = scanServerChunks(join(dir, '.next', 'server'));

    expect(result.chunksPresent).toBe(9);
    expect(result.missing.map((m) => m.id).sort()).toEqual(['2575', '5773', '8909']);

    // 5773 is required by two entries — the report must name both, since that
    // is what tells a maintainer how much of the dashboard is dead.
    const c5773 = result.missing.find((m) => m.id === '5773');
    expect(c5773.requiredBy.sort()).toEqual([
      '/app/(dashboard)/jobs/page.js',
      '/app/(dashboard)/page.js',
    ]);
  });

  it('scans nested route groups, API routes and the middleware alike', () => {
    const result = scanServerChunks(join(dir, '.next', 'server'));
    expect(result.entriesScanned).toBe(4);
  });

  it('reports intact once the dropped chunks are restored', () => {
    const server = join(dir, '.next', 'server');
    for (const id of ['5773', '8909', '2575']) {
      writeFileSync(join(server, 'chunks', `${id}.js`), `exports.id=${id};`);
    }
    const result = scanServerChunks(server);
    expect(result.missing).toEqual([]);
    expect(formatMissingChunks(result)).toBeNull();
  });

  it('throws on a directory that is not a Next server build', () => {
    expect(() => scanServerChunks(join(dir, 'nope'))).toThrow(/Not a Next server build/);
  });
});

describe('formatMissingChunks', () => {
  it('names the chunk file and its consumers so the failure is actionable', () => {
    const report = formatMissingChunks({
      entriesScanned: 31,
      chunksPresent: 33,
      missing: [{ id: '5773', requiredBy: ['/app/(dashboard)/page.js'] }],
    });
    expect(report).toContain('chunks/5773.js');
    expect(report).toContain('/app/(dashboard)/page.js');
    expect(report).toContain('33 present');
  });
});
