// backup-archive.test.ts — the backup file format, without a database: what
// is written is what is read, a file cut or changed anywhere is refused, and
// a passphrase is required, checked at once, and unicode-form independent.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  BackupError,
  BackupReader,
  BackupWriter,
  readBackupHeader,
  type BackupRecordHeader,
} from '../backup-archive.ts';

const dir = mkdtempSync(join(tmpdir(), 'nodal-archive-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const file = (): string => join(dir, `a-${++n}.nodalbak`);

const MANIFEST: BackupRecordHeader = {
  kind: 'manifest',
  manifest: {
    madeBy: '9.9.9',
    at: '2026-11-28T09:00:00.000Z',
    database: 'nodalai',
    schema: { history: [1, 2], lastMigration: '0001_x' },
    vector: false,
    workspaces: false,
  },
};

async function* chunks(parts: readonly Buffer[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield p;
}

const big = randomBytes(3 * 1024 * 1024 + 17);
const rows = 'a\tb\\nc\n2\t\\N\n';

async function write(path: string, opts: { passphrase?: string } = {}): Promise<void> {
  const w = await BackupWriter.create(path, opts);
  await w.record(MANIFEST);
  await w.record({ kind: 'state-file', name: 'secrets.key' }, 'S0VZ');
  await w.record(
    { kind: 'table', schema: 'public', table: 't', columns: ['a', 'b'], types: ['text', 'text'] },
    chunks([Buffer.from(rows.slice(0, 5)), Buffer.from(rows.slice(5))]),
  );
  await w.record({ kind: 'workspace-file', path: 'x/big.bin' }, big);
  await w.finish();
}

async function readAll(
  path: string,
  opts: { passphrase?: string } = {},
): Promise<{ header: BackupRecordHeader; bytes: Buffer; lines: number }[]> {
  const r = await BackupReader.open(path, opts);
  const out: { header: BackupRecordHeader; bytes: Buffer; lines: number }[] = [];
  try {
    for (;;) {
      const h = await r.next();
      if (h === null) break;
      const { bytes, digest } = await r.payloadBytes();
      out.push({ header: h, bytes, lines: digest.lines });
    }
  } finally {
    r.close();
  }
  return out;
}

async function refusal(p: Promise<unknown>): Promise<BackupError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BackupError);
  return err as BackupError;
}

describe('backup archive: the format @cap:installer-et-demarrer/moteur', () => {
  it('what is written is what is read: headers, bytes, row counts', async () => {
    const path = file();
    await write(path);
    const got = await readAll(path);
    expect(got.map((g) => g.header)).toEqual([
      MANIFEST,
      { kind: 'state-file', name: 'secrets.key' },
      { kind: 'table', schema: 'public', table: 't', columns: ['a', 'b'], types: ['text', 'text'] },
      { kind: 'workspace-file', path: 'x/big.bin' },
    ]);
    expect(got[1]!.bytes.toString('utf-8')).toBe('S0VZ');
    expect(got[2]!.bytes.toString('utf-8')).toBe(rows);
    expect(got[2]!.lines).toBe(2);
    expect(got[3]!.bytes.equals(big)).toBe(true);
    expect(readBackupHeader(path).header.encryption).toBeNull();
  });

  it('cut short at any point: refused, never read as complete', async () => {
    const path = file();
    await write(path);
    const full = readFileSync(path);
    const { bodyStart } = readBackupHeader(path);
    const cuts = [
      bodyStart + 1,
      bodyStart + 100,
      Math.floor(full.length / 2),
      full.length - 30,
      full.length - 1,
    ];
    for (const cut of cuts) {
      const partial = file();
      writeFileSync(partial, full.subarray(0, cut));
      const err = await refusal(readAll(partial));
      expect(err.code).toBe('BACKUP_DAMAGED');
    }
    const headerOnly = file();
    writeFileSync(headerOnly, full.subarray(0, 5));
    expect((await refusal(readAll(headerOnly))).code).toBe('BACKUP_NOT_AN_ARCHIVE');
  });

  it('bytes added after the end record: refused', async () => {
    const path = file();
    await write(path);
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('trailing')]));
    expect((await refusal(readAll(path))).code).toBe('BACKUP_DAMAGED');
  });

  it('a writer stopped before finish leaves a file no reader takes for complete', async () => {
    const path = file();
    const w = await BackupWriter.create(path);
    await w.record(MANIFEST);
    await w.abort();
    expect((await refusal(readAll(path))).code).toBe('BACKUP_DAMAGED');
  });
});

describe('backup archive: the passphrase @cap:installer-et-demarrer/moteur', () => {
  it('encrypted: the same records come back with it; without it, or with another, nothing is read', async () => {
    const path = file();
    await write(path, { passphrase: 'Café ✓' });
    expect(readBackupHeader(path).header.encryption).toMatchObject({
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      N: 2 ** 17,
      r: 8,
      p: 1,
    });
    const got = await readAll(path, { passphrase: 'Café ✓' });
    expect(got[2]!.bytes.toString('utf-8')).toBe(rows);
    expect(got[3]!.bytes.equals(big)).toBe(true);
    // The decomposed form of the same characters (what a macOS keyboard may send).
    expect(
      (await readAll(path, { passphrase: 'Café ✓'.normalize('NFD') }))[1]!.bytes.toString(),
    ).toBe('S0VZ');
    expect((await refusal(readAll(path))).code).toBe('BACKUP_PASSPHRASE_REQUIRED');
    expect((await refusal(readAll(path, { passphrase: 'Cafe ✓' }))).code).toBe(
      'BACKUP_WRONG_PASSPHRASE',
    );
  }, 60_000);

  it('one byte changed in the body, or in the clear header, fails authentication', async () => {
    const path = file();
    await write(path, { passphrase: 'pw' });
    const full = readFileSync(path);
    const { bodyStart } = readBackupHeader(path);

    const body = Buffer.from(full);
    body[bodyStart + Math.floor((full.length - bodyStart) / 2)]! ^= 0x01;
    const p1 = file();
    writeFileSync(p1, body);
    expect((await refusal(readAll(p1, { passphrase: 'pw' }))).code).toBe('BACKUP_DAMAGED');

    // The header names the cipher's parameters; changing the compression
    // label to its own value with other spacing changes the authenticated
    // bytes without changing their meaning.
    const header = full
      .subarray(0, bodyStart)
      .toString('utf-8')
      .replace('"compression":"gzip"', '"compression": "gzip"');
    const p2 = file();
    writeFileSync(p2, Buffer.concat([Buffer.from(header), full.subarray(bodyStart)]));
    expect((await refusal(readAll(p2, { passphrase: 'pw' }))).code).toBe('BACKUP_DAMAGED');
  }, 60_000);

  it('an empty passphrase is refused when writing', async () => {
    expect((await refusal(BackupWriter.create(file(), { passphrase: '' }))).code).toBe(
      'BACKUP_FAILED',
    );
  });
});
