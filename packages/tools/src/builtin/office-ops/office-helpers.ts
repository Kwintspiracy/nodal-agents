// office-ops/office-helpers.ts — shared binary read/write helpers for office tools.
//
// Two non-negotiable guarantees:
//   1. Every read/write goes through resolveAndCheckPath → path-traversal and
//      symlink-escape attacks are caught before any fs access.
//   2. Binary writes use atomic temp-rename (same directory → same filesystem)
//      so a crash mid-write never leaves a partially-written corrupt file.
//
// 25 MiB cap (MAX_OFFICE_BYTES) mirrors the Google Drive adapter's file-size
// limit for binary ingestion. 1 MiB is far too small for real Office files;
// exceljs workbooks with charts can easily reach 5–10 MiB.

import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { ToolContext } from '../../types';
import { resolveAndCheckPath, WorkspaceError } from '../file-ops/workspace';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_OFFICE_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Max total bytes accepted when validating the DECOMPRESSED content of an
 * Office (OOXML/zip) file. MAX_OFFICE_BYTES caps the file on disk BEFORE
 * decompression, but exceljs/mammoth/officeparser inflate the whole archive
 * into memory — a 25 MiB compressed .xlsx can still be a decompression bomb
 * that expands to gigabytes. This cap bounds what the bomb-check pass allows
 * before the file is handed to those parsers.
 *
 * 1 GiB, not 256 MiB: measured real-world business content (a repetitive-log
 * style .xlsx near the 25 MiB on-disk cap) can hit an inflation ratio around
 * ~10.6x, i.e. up to ~265 MiB decompressed — a 256 MiB cap produced false
 * positives on legitimate files. Real decompression bombs run 100:1 to
 * 1000:1, so 1 GiB still leaves an order of magnitude of headroom above
 * realistic legitimate content while remaining a hard backstop against an
 * actual bomb (which would need >1 GiB of declared/produced content to even
 * approach this cap).
 */
export const MAX_OFFICE_INFLATED_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Max zip entries accepted in a single Office document (anti-abuse).
 *
 * 50,000, not 10,000: a real .pptx with ~2,000 slides, each carrying its own
 * icon/media part, was measured at ~7,500 zip entries — comfortably under
 * 50,000 while a 10,000 cap left too little headroom above realistic large
 * presentations. Aligned with MAX_ENTRIES in apps/runner/src/skills/fetch.ts
 * (the analogous cap for downloaded skill archives).
 */
export const MAX_OFFICE_ZIP_ENTRIES = 50_000;

/**
 * Validate the DECOMPRESSED size and entry count of a zip-based Office file
 * (OOXML: xlsx/docx/pptx are all zips), using the SAME engine — jszip — that
 * exceljs and mammoth actually parse the file with. `maxInflatedBytes` /
 * `maxEntries` default to the production constants but are overridable so
 * tests can inject a low cap and stay fast instead of inflating a full-scale
 * (multi-hundred-MB to GB) fixture just to cross the default 1 GiB cap.
 *
 * WHY jszip and not a hand-rolled streaming unzip (this module's PREVIOUS
 * approach, using fflate's `Unzip`): a hand-rolled unzip that forward-scans
 * the buffer for local-file-header signatures sees a DIFFERENT set of
 * "entries" than jszip does whenever the two disagree about where an entry
 * starts or how long it is — and an attacker fully controls the buffer. A
 * proven PoC: prepend a FORGED local file header (method STORED, declared
 * compressed size == the length of a real, valid zip that immediately
 * follows) to that real zip. A forward-scanning parser reads the forged
 * header first and swallows the entire real zip as that single fake entry's
 * opaque STORED payload — counting only its outer (small) declared size and
 * never looking inside. jszip, however, locates the zip by reading the End
 * Of Central Directory from the END of the buffer and following the REAL
 * offsets recorded there, so it ignores the forged header entirely and finds
 * the real entries — including the real bomb. Validating with a different
 * engine than the one that will actually parse the file is bypassable BY
 * CONSTRUCTION; validating with the same engine is not, because there is no
 * "different opinion" for an attacker to exploit.
 *
 * `loadAsync` itself only parses the central directory (via the EOCD) — it
 * does NOT decompress anything, so it is safe to call on an actual bomb, no
 * matter how it inflates. Each entry's declared/actual decompressed bytes are
 * then counted via `entry.nodeStream('nodebuffer')` — a real, backpressured
 * Node Readable fed by jszip's own chunked inflate worker chain (see
 * NodejsStreamOutputAdapter in jszip's source: it `push()`es each inflated
 * chunk as it's produced and pauses on backpressure) — so the running total
 * can abort mid-entry, well before the whole entry is ever materialized.
 *
 * officeparser (used for .pptx) uses fflate's own (different) central-
 * directory-driven `unzip`, not jszip. That is NOT the same bypass class as
 * the forward-scanning approach above: both jszip and fflate.unzip navigate
 * via the EOCD + central directory, so they agree on where every real entry
 * is — the forged-header PoC does not fool either. A residual gap would
 * require the two central-directory parsers to disagree with each other,
 * which is a materially harder (and currently undemonstrated) attack.
 */
export async function validateOfficeZipBomb(
  buf: Buffer,
  maxInflatedBytes: number = MAX_OFFICE_INFLATED_BYTES,
  maxEntries: number = MAX_OFFICE_ZIP_ENTRIES,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    return {
      ok: false,
      reason: `Corrupt or unreadable zip data in Office file: ${(err as Error).message}`,
    };
  }

  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > maxEntries) {
    return {
      ok: false,
      reason: `Office archive has too many entries (${entries.length}, max ${maxEntries}) — refusing to open (possible decompression bomb).`,
    };
  }

  // Cumulative across ALL entries, not per-entry — a bomb can split its
  // payload across many entries each individually under the cap.
  let totalInflatedBytes = 0;
  try {
    for (const entry of entries) {
      const violation = await new Promise<string | null>((resolvePromise, reject) => {
        let settled = false;
        // jszip's own .d.ts types nodeStream()'s return as the narrow
        // NodeJS.ReadableStream duck-type (no `.destroy()`), but its actual
        // implementation (NodejsStreamOutputAdapter) extends the
        // "readable-stream" package's Readable, which does support destroy() —
        // needed here to stop jszip's inflate worker chain the instant the cap
        // is crossed, instead of letting it keep decompressing an entry we've
        // already decided to reject.
        const nodeStream = entry.nodeStream('nodebuffer') as unknown as Readable;
        nodeStream.on('data', (chunk: Buffer) => {
          if (settled) return;
          totalInflatedBytes += chunk.length;
          if (totalInflatedBytes > maxInflatedBytes) {
            settled = true;
            nodeStream.destroy();
            resolvePromise(
              `Office archive inflates past ${totalInflatedBytes} bytes ` +
                `(max ${maxInflatedBytes}) — refusing to open it (possible decompression bomb).`,
            );
          }
        });
        nodeStream.on('end', () => {
          if (settled) return;
          settled = true;
          resolvePromise(null);
        });
        nodeStream.on('error', (err: Error) => {
          if (settled) return;
          settled = true;
          reject(
            new Error(`Corrupt entry "${entry.name}" inside the Office archive: ${err.message}`),
          );
        });
      });
      if (violation) return { ok: false, reason: violation };
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  return { ok: true };
}

// ─── Zip detection ─────────────────────────────────────────────────────────────

const LOCAL_FILE_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Lightweight signal for "should this buffer be validated as a zip", used
 * only to decide validate-vs-pass-through — NOT to locate where the zip
 * starts (jszip's `loadAsync` does that itself, correctly, by scanning for
 * the EOCD from the end of the buffer; it tolerates an arbitrary prefix the
 * same way it tolerates a CRX file's prepended header).
 *
 * True when a local file header sits at offset 0 (the common, unprefixed
 * case) OR an EOCD signature is found anywhere (searched from the end, like
 * jszip's own lastIndexOfSignature) — covering a zip prefixed by arbitrary
 * bytes. False (pass-through, legacy binary formats) only when neither
 * signal is present.
 */
function looksLikeZip(buf: Buffer): boolean {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(LOCAL_FILE_HEADER_SIG)) {
    return true;
  }
  return buf.lastIndexOf(EOCD_SIG) !== -1;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type ReadBinaryResult =
  | { ok: true; buffer: Buffer; resolvedPath: string }
  | { ok: false; reason: string };

export type WriteBinaryResult =
  | { ok: true; written: true; bytes: number; path: string }
  | { ok: false; reason: string };

// ─── readWorkspaceBinary ──────────────────────────────────────────────────────

/**
 * Resolve `path` through the workspace guard and read it as a Buffer.
 * Enforces the 25 MiB cap: files larger than MAX_OFFICE_BYTES are refused
 * before their bytes are read into memory.
 *
 * `opts` overrides the decompression-bomb caps — production callers never
 * pass it (they get MAX_OFFICE_INFLATED_BYTES / MAX_OFFICE_ZIP_ENTRIES), it
 * exists so tests can inject a low cap and stay fast instead of needing to
 * actually inflate a full-scale fixture to cross the production default.
 *
 * Returns a discriminated union — never throws on expected errors.
 */
export async function readWorkspaceBinary(
  ctx: ToolContext,
  path: string,
  opts: { maxInflatedBytes?: number; maxZipEntries?: number } = {},
): Promise<ReadBinaryResult> {
  try {
    const resolvedPath = await resolveAndCheckPath(ctx, path);
    // Size check before read — avoids loading a huge file into memory
    const info = await stat(resolvedPath).catch(() => null);
    if (!info) {
      return { ok: false, reason: `File not found: "${path}"` };
    }
    if (info.size > MAX_OFFICE_BYTES) {
      return {
        ok: false,
        reason: `File too large: ${info.size} bytes (max ${MAX_OFFICE_BYTES}). Split or compress it first.`,
      };
    }
    const buffer = await readFile(resolvedPath);

    // OOXML files (xlsx/docx/pptx) are zips. Validate the DECOMPRESSED
    // size/entry-count BEFORE handing the buffer to exceljs/mammoth/
    // officeparser, which inflate the whole archive into memory — the
    // MAX_OFFICE_BYTES check above only bounds the compressed size on disk,
    // not what it can expand to. looksLikeZip only decides whether to
    // validate at all — jszip's loadAsync locates the zip itself.
    if (looksLikeZip(buffer)) {
      const bombCheck = await validateOfficeZipBomb(
        buffer,
        opts.maxInflatedBytes ?? MAX_OFFICE_INFLATED_BYTES,
        opts.maxZipEntries ?? MAX_OFFICE_ZIP_ENTRIES,
      );
      if (!bombCheck.ok) return { ok: false, reason: bombCheck.reason };
    }

    return { ok: true, buffer, resolvedPath };
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: `File not found: "${path}"` };
    throw err;
  }
}

// ─── writeWorkspaceBinary ─────────────────────────────────────────────────────

/**
 * Resolve `path` through the workspace guard and atomically write `buffer` to
 * it. The file is first written to a sibling temp file (same dir → same
 * filesystem → rename is atomic), then renamed over the target. On failure, the
 * temp file is cleaned up best-effort.
 *
 * Options:
 *   - `overwrite` (default false): if false and the target already exists, the
 *     write is refused. The agent must pass overwrite:true explicitly to
 *     overwrite an existing file — prevents accidental data loss.
 *
 * Returns a discriminated union — never throws on expected errors.
 */
export async function writeWorkspaceBinary(
  ctx: ToolContext,
  path: string,
  buffer: Buffer,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<WriteBinaryResult> {
  try {
    if (buffer.length > MAX_OFFICE_BYTES) {
      return {
        ok: false,
        reason: `Refusing to write ${buffer.length} bytes (max ${MAX_OFFICE_BYTES}). Split the content.`,
      };
    }

    const resolvedPath = await resolveAndCheckPath(ctx, path);

    // Overwrite guard: if the file exists and overwrite is false, refuse.
    const existing = await stat(resolvedPath).catch(() => null);
    if (existing && !overwrite) {
      return {
        ok: false,
        reason: `File already exists at "${path}". Pass overwrite:true to replace it.`,
      };
    }

    // Atomic write: tempfile in same dir (same filesystem → rename is atomic)
    const dir = dirname(resolvedPath);
    const tmp = `${dir}/.${basename(resolvedPath)}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, buffer);
      await rename(tmp, resolvedPath);
    } catch (err) {
      // Best-effort cleanup of tempfile if rename failed
      await unlink(tmp).catch(() => undefined);
      throw err;
    }

    return { ok: true, written: true, bytes: buffer.length, path: resolvedPath };
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: `Parent directory does not exist for "${path}". Create the parent directory first.`,
      };
    }
    throw err;
  }
}
