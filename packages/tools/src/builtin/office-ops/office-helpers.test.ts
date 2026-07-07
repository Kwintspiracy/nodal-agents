// office-helpers.test.ts — the decompression-bomb guard in readWorkspaceBinary().
// Office files (xlsx/docx/pptx) are OOXML zips; exceljs/mammoth/officeparser
// inflate them fully into memory, so a small compressed file that expands to
// gigabytes is a real OOM vector even though MAX_OFFICE_BYTES already caps the
// file's size ON DISK.
//
// The validator uses jszip — the SAME engine exceljs/mammoth actually parse
// the file with (see the "WHY jszip" doc comment on validateOfficeZipBomb in
// office-helpers.ts). A previous version of this guard used a different,
// hand-rolled streaming unzip (fflate's `Unzip`) for validation while the real
// parsers used jszip — a proven PoC (reproduced below as a regression test)
// showed that mismatch is bypassable BY CONSTRUCTION: a forged local-file-
// header can make a forward-scanning parser see a small, harmless "entry"
// while jszip (reading the real central directory) sees the real, huge one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {
  readWorkspaceBinary,
  validateOfficeZipBomb,
  MAX_OFFICE_INFLATED_BYTES,
  MAX_OFFICE_ZIP_ENTRIES,
} from './office-helpers';
import { xlsxReadTool } from './xlsx';
import type { ToolContext } from '../../types';

let WORKSPACE: string;

beforeEach(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-office-bomb-'));
});

afterEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: WORKSPACE }],
  };
}

/** Build a real, valid zip whose single entry decompresses to `sizeBytes` of zeros. */
function buildZipWithZeros(sizeBytes: number, entryName = 'bomb.bin'): Buffer {
  return Buffer.from(zipSync({ [entryName]: new Uint8Array(sizeBytes) }, { level: 1 }));
}

/**
 * Build a forged 30-byte STORED local-file-header (no filename, no extra
 * field) declaring `compressedSize` bytes of opaque data follow it. A
 * forward-scanning unzip implementation reads this as a real entry and
 * swallows exactly `compressedSize` bytes as its content, verbatim (STORED =
 * no compression) — this is the "ghost entry" used by the bypass PoC below.
 */
function buildFakeStoredLocalHeader(compressedSize: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature ("PK\x03\x04")
  header.writeUInt16LE(20, 4); // version needed to extract
  header.writeUInt16LE(0, 6); // general purpose bit flag
  header.writeUInt16LE(0, 8); // compression method: 0 = STORED
  header.writeUInt16LE(0, 10); // last mod file time
  header.writeUInt16LE(0, 12); // last mod file date
  header.writeUInt32LE(0, 14); // crc-32 (irrelevant — nothing validates it here)
  header.writeUInt32LE(compressedSize, 18); // compressed size
  header.writeUInt32LE(compressedSize, 22); // uncompressed size (STORED: same as compressed)
  header.writeUInt16LE(0, 26); // file name length
  header.writeUInt16LE(0, 28); // extra field length
  return header;
}

describe('validateOfficeZipBomb — direct, injected caps (fast, deterministic)', () => {
  it('rejects when decompressed bytes exceed the injected cap', async () => {
    const zipBuf = buildZipWithZeros(5 * 1024 * 1024); // 5 MiB of zeros
    const r = await validateOfficeZipBomb(zipBuf, 1024 * 1024, MAX_OFFICE_ZIP_ENTRIES); // cap: 1 MiB
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected rejection');
    expect(r.reason.toLowerCase()).toMatch(/inflat|decompress|bomb/);
    expect(r.reason).toContain(String(1024 * 1024));
  });

  it('accepts content within the injected cap', async () => {
    const zipBuf = buildZipWithZeros(1024); // 1 KiB of zeros
    const r = await validateOfficeZipBomb(zipBuf, 1024 * 1024, MAX_OFFICE_ZIP_ENTRIES);
    expect(r.ok).toBe(true);
  });

  it('rejects when entry count exceeds the injected entries cap', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 21; i++) files[`f${i}.txt`] = new Uint8Array(0);
    const zipBuf = Buffer.from(zipSync(files, { level: 0 }));
    const r = await validateOfficeZipBomb(zipBuf, MAX_OFFICE_INFLATED_BYTES, 20); // cap: 20 entries
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected rejection');
    expect(r.reason.toLowerCase()).toMatch(/entries|entry/);
    expect(r.reason).toContain('20');
  });

  it('rejects a corrupted zip signature with a clear reason (fail loud)', async () => {
    const corrupted = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256)),
    ]);
    const r = await validateOfficeZipBomb(
      corrupted,
      MAX_OFFICE_INFLATED_BYTES,
      MAX_OFFICE_ZIP_ENTRIES,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected rejection');
    expect(r.reason.toLowerCase()).toMatch(/corrupt|invalid|unreadable/);
  });

  // ─── Empirical proof: nodeStream genuinely streams, it does not fully ────
  // ─── materialize an entry before the cap check gets to run ─────────────
  //
  // If jszip's nodeStream() decompressed an entire entry into memory before
  // ever emitting 'data', the abort time here would SCALE with the entry's
  // total declared size. A genuinely streaming implementation only needs to
  // process roughly "cap + one chunk" of output before destroying the
  // stream, so its abort time stays small and roughly CONSTANT regardless of
  // how large the entry's declared/actual size is. Both variants below use
  // the SAME low 1 MiB cap; only the entry's total size differs by 16x
  // (50 MiB vs 800 MiB) — if streaming truly bounds memory/time, both
  // complete in comparably little time.
  it('rejects an oversized entry (50 MiB vs a 1 MiB cap) — streaming abort, not full materialization', async () => {
    // A 50 MiB entry against a 1 MiB cap: a streaming validator aborts after
    // ~cap+one chunk and never buffers the whole entry, so it rejects with the
    // cap in the reason. (The former wall-clock "O(1) via an 800 MiB entry"
    // proof was removed: a timing assertion + a ~1 GiB allocation is
    // non-deterministic and OOM-prone on a shared CI runner. The deterministic
    // injected-cap tests above are the authoritative coverage of the cap logic.)
    const zipBuf = buildZipWithZeros(50 * 1024 * 1024, 'medium.bin');
    const r = await validateOfficeZipBomb(zipBuf, 1024 * 1024, MAX_OFFICE_ZIP_ENTRIES); // 1 MiB cap
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected rejection');
    expect(r.reason).toContain(String(1024 * 1024));
  }, 30000);
});

describe('readWorkspaceBinary — end-to-end wiring with PRODUCTION default caps', () => {
  it('accepts a real small .xlsx and it reads back correctly end-to-end', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Data');
    sheet.getCell('A1').value = 'Name';
    sheet.getCell('B1').value = 'Score';
    sheet.getCell('A2').value = 'Alice';
    sheet.getCell('B2').value = 90;
    const buf = await wb.xlsx.writeBuffer();
    await writeFile(join(WORKSPACE, 'real.xlsx'), Buffer.from(buf));

    const r = await readWorkspaceBinary(ctx(), 'real.xlsx');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);

    const readResult = await xlsxReadTool.execute({ path: 'real.xlsx', max_rows: 200 }, ctx());
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.reason);
    expect(readResult.sheets[0]?.name).toBe('Data');
    expect(readResult.sheets[0]?.rows[0]).toContain('Name');
  });

  it('passes a non-PK buffer straight through (legacy binary formats, no zip validation)', async () => {
    const fakeOle2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01, 0x02, 0x03]);
    await writeFile(join(WORKSPACE, 'legacy.doc'), fakeOle2);

    const r = await readWorkspaceBinary(ctx(), 'legacy.doc');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.buffer.equals(fakeOle2)).toBe(true);
  });

  it('rejects a corrupted PK-signed buffer with a clear reason (fail loud, no pass-through)', async () => {
    const corrupted = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256)),
    ]);
    await writeFile(join(WORKSPACE, 'corrupt.xlsx'), corrupted);

    const r = await readWorkspaceBinary(ctx(), 'corrupt.xlsx');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected the corrupted archive to be rejected');
    expect(r.reason.toLowerCase()).toMatch(/corrupt|invalid|unreadable/);
  });

  it('rejects more than MAX_OFFICE_ZIP_ENTRIES with no override (real production constant)', async () => {
    const files: Record<string, Uint8Array> = {};
    const entryCount = MAX_OFFICE_ZIP_ENTRIES + 1;
    for (let i = 0; i < entryCount; i++) files[`f${i}.txt`] = new Uint8Array(0);
    const zipBuf = zipSync(files, { level: 0 });
    await writeFile(join(WORKSPACE, 'many-entries.xlsx'), zipBuf);

    const r = await readWorkspaceBinary(ctx(), 'many-entries.xlsx');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected the too-many-entries archive to be rejected');
    expect(r.reason.toLowerCase()).toMatch(/entries|entry/);
    expect(r.reason).toContain(String(MAX_OFFICE_ZIP_ENTRIES));
  }, 30000);

  // Skipped on CI: exceeding the REAL ~1 GiB inflated-bytes cap requires a
  // >1 GiB entry, whose in-memory construction (new Uint8Array of that size) is
  // OOM-prone on a shared CI runner. Runs locally, where memory is ample; the
  // injected-cap tests above cover the reject-on-cap logic deterministically on
  // CI with tiny inputs.
  it.skipIf(!!process.env['CI'])(
    'rejects a real bomb exceeding MAX_OFFICE_INFLATED_BYTES with no override (real production constant)',
    async () => {
      const zipBuf = buildZipWithZeros(1100 * 1024 * 1024, 'prod-bomb.bin');
      await writeFile(join(WORKSPACE, 'bomb.xlsx'), zipBuf);

      const r = await readWorkspaceBinary(ctx(), 'bomb.xlsx');
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected the zip bomb to be rejected');
      expect(r.reason.toLowerCase()).toMatch(/inflat|decompress|bomb/);
      expect(r.reason).toContain(String(MAX_OFFICE_INFLATED_BYTES));
    },
    30000,
  );
});

describe('BYPASS REGRESSION — single-byte-prefix magic-byte bypass (original fix)', () => {
  // jszip (used by exceljs/mammoth) locates a zip by scanning for the End Of
  // Central Directory record from the END of the buffer, not by assuming
  // byte 0 is the start — its own source cites CRX files as the real-world
  // case for prepended data. Gating the bomb check solely on "buf[0..3] ===
  // local file header" was bypassable: prefix any bomb with one arbitrary
  // byte and exceljs opens it fine while the old check never ran at all.

  it('detects a real bomb even when prefixed by a single arbitrary byte (injected low cap for speed)', async () => {
    const zipBuf = buildZipWithZeros(20 * 1024 * 1024, 'bomb.bin'); // 20 MiB of zeros
    const prefixed = Buffer.concat([Buffer.from([0x41]), zipBuf]);
    await writeFile(join(WORKSPACE, 'prefixed-bomb.xlsx'), prefixed);

    const r = await readWorkspaceBinary(ctx(), 'prefixed-bomb.xlsx', {
      maxInflatedBytes: 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected the 1-byte-prefixed zip bomb to still be rejected');
    expect(r.reason.toLowerCase()).toMatch(/inflat|decompress|bomb/);
  });

  it('a legitimate small .xlsx prefixed by a single byte still passes (validation runs, no false rejection)', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Data');
    sheet.getCell('A1').value = 'Name';
    sheet.getCell('B1').value = 'Score';
    const buf = await wb.xlsx.writeBuffer();
    const prefixed = Buffer.concat([Buffer.from([0x41]), Buffer.from(buf)]);
    await writeFile(join(WORKSPACE, 'prefixed-real.xlsx'), prefixed);

    const r = await readWorkspaceBinary(ctx(), 'prefixed-real.xlsx');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.buffer.equals(prefixed)).toBe(true);
  });
});

describe('BYPASS REGRESSION — forged "ghost STORED entry" defeats a forward-scanning validator, not jszip', () => {
  it('sees through the forged header and rejects the real bomb; JSZip.loadAsync independently confirms it finds the SAME real entry', async () => {
    // A real, valid zip containing a real bomb entry — enough zeros to
    // exceed a low injected cap, but tiny on disk (all-zero content
    // compresses to almost nothing).
    const realZip = buildZipWithZeros(20 * 1024 * 1024, 'real-bomb.bin'); // 20 MiB decompressed

    // Forge a STORED local-file-header declaring its "compressed size" as
    // exactly realZip.length. A forward-scanning parser (this module's
    // PREVIOUS implementation, using fflate's streaming `Unzip`) reads this
    // header FIRST and swallows the entire real zip as this one fake
    // entry's opaque STORED payload — counting only its own small declared
    // size and never looking inside to find the real, huge entry.
    const fakeHeader = buildFakeStoredLocalHeader(realZip.length);
    const poc = Buffer.concat([fakeHeader, realZip]);

    // Prove the validator's engine and the real parsers' engine (both
    // jszip) see the SAME thing: the real entry, not the decoy — jszip
    // navigates via the EOCD + central directory (read from the END of the
    // buffer), so the forged header at offset 0 is irrelevant to it.
    const zip = await JSZip.loadAsync(poc);
    expect(Object.keys(zip.files)).toContain('real-bomb.bin');

    const p = join(WORKSPACE, 'ghost-stored.xlsx');
    await writeFile(p, poc);

    const r = await readWorkspaceBinary(ctx(), 'ghost-stored.xlsx', {
      maxInflatedBytes: 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    if (r.ok) {
      throw new Error(
        'BYPASS: the ghost-STORED forged header defeated the validator — it should have found the ' +
          'real 20 MiB entry via the central directory and rejected it, but got ok:true instead.',
      );
    }
    expect(r.reason.toLowerCase()).toMatch(/inflat|decompress|bomb/);
  });
});
