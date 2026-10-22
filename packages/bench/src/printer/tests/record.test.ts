// record.test.ts — le format des enregistrements de l'imprimante du banc (#794).

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRecordId, readRecords, rotateRecords, writeRecord } from '../record';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bench-printer-record-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const request = (text: string, nowMs?: number) =>
  writeRecord(
    dir,
    {
      source: { kind: 'content', contentFormat: 'text' },
      bytes: Buffer.from(text, 'utf8'),
      pages: 1,
      pagesBasis: 'text-estimate',
      images: null,
      arguments: { content: text },
    },
    nowMs,
  );

describe('record ids', () => {
  it('the ids the writer makes are valid, and nothing that reaches a path is', () => {
    expect(isRecordId(request('a').id)).toBe(true);
    for (const bad of [
      '',
      '..',
      '../pr-1-00000000',
      'pr-1-00000000/..',
      'pr-1-0000000',
      'pr-1-000000000',
      'pr-1-0000000G',
      'pr-x-00000000',
      'pr-1-00000000.json',
      'PR-1-00000000',
      'pr-1-00000000\n',
    ])
      expect([bad, isRecordId(bad)]).toEqual([bad, false]);
  });
});

describe('rotateRecords: a trial is judged on what it created (review of #832, pass 1)', () => {
  it('sets the standing requests aside, keeps them readable, and leaves the folder empty of requests', () => {
    const a = request('first trial');
    const b = request('first trial again');
    expect(readRecords(dir).requests.map((r) => r.record.id)).toEqual([a.id, b.id].sort());

    expect(rotateRecords(dir, 'print-file-1790000000000')).toBe(4);
    expect(readRecords(dir)).toEqual({ requests: [], problems: [] });
    expect(readdirSync(dir)).toEqual(['previous']);
    const kept = readRecords(join(dir, 'previous', 'print-file-1790000000000'));
    expect(kept.requests.map((r) => r.record.id).sort()).toEqual([a.id, b.id].sort());
    expect(kept.requests[0]!.bytes.toString('utf8')).toMatch(/first trial/);
  });

  it('moves only record files: any other file of the folder stays where it is', () => {
    request('x');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, 'pr-1-00000000.json.zzzz.tmp'), 'not a record id, left alone');
    mkdirSync(join(dir, 'previous', 'older'), { recursive: true });
    rotateRecords(dir, 'next');
    expect(readdirSync(dir).sort()).toEqual([
      'notes.txt',
      'pr-1-00000000.json.zzzz.tmp',
      'previous',
    ]);
    expect(readdirSync(join(dir, 'previous')).sort()).toEqual(['next', 'older']);
  });

  it('moves the leftovers of a write that died halfway too', () => {
    const r = request('x');
    writeFileSync(join(dir, `${r.id}.json.ab12.tmp`), '{');
    expect(rotateRecords(dir, 'again')).toBe(3);
    expect(readdirSync(dir)).toEqual(['previous']);
  });

  it('does nothing, and says so, for a folder that does not exist or holds no request', () => {
    expect(rotateRecords(join(dir, 'never'), 'x')).toBe(0);
    expect(rotateRecords(dir, 'x')).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a label cannot write outside the folder', () => {
    request('x');
    rotateRecords(dir, '../../escape');
    expect(readdirSync(dir)).toEqual(['previous']);
    expect(readdirSync(join(dir, 'previous'))).toEqual(['.._.._escape']);
  });
});
