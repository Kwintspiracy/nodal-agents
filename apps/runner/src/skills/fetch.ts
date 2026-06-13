// skills/fetch.ts — download a skill archive and extract it to a temp dir, then
// locate the SKILL.md manifest(s). No git binary required: a plain HTTPS fetch
// (GitHub codeload tarball, or ClawHub's zip API) + in-process extraction.
//
// Format is detected by magic bytes, not by URL/content-type: "PK" → zip
// (fflate), 0x1f8b → gzip (node-tar). Zip extraction guards against zip-slip.

import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname, sep } from 'node:path';
import { extract as tarExtract, type ReadEntry } from 'tar';
import { unzipSync } from 'fflate';
import { type SkillSource, candidateRefs, tarballUrl, clawhubDownloadUrl } from './source';

/** Hard cap on a downloaded archive (anti-abuse). */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/** Decompression-bomb guard: total bytes of all extracted files combined. */
export const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024; // 100 MB

/** Zip / tar entry count cap: rejects archives with absurdly many files. */
export const MAX_ENTRIES = 50_000;

export class SkillFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFetchError';
  }
}

export interface ExtractedRepo {
  /** Absolute path to the directory the skill's files live under. */
  extractRoot: string;
  /** The ref/version that resolved (for storage; informational). */
  ref: string;
  /** Remove the temp tree. Always call in a finally. */
  cleanup: () => Promise<void>;
}

async function readCapped(res: Response): Promise<Buffer> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_ARCHIVE_BYTES) {
    throw new SkillFetchError(
      `Skill archive is too large (${buf.byteLength} bytes, max ${MAX_ARCHIVE_BYTES}).`,
    );
  }
  return buf;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'nodal-agents-skill-installer' },
  });
  if (!res.ok) throw new SkillFetchError(`Download failed: HTTP ${res.status}.`);
  return readCapped(res);
}

/** Extract a zip with zip-slip protection: reject `..` / absolute entries. */
async function unzipBufferTo(buf: Buffer, destDir: string): Promise<void> {
  const files = unzipSync(new Uint8Array(buf));
  const rootResolved = resolve(destDir);
  const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  let entryCount = 0;
  let totalBytes = 0;
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue; // directory entry
    entryCount++;
    if (entryCount > MAX_ENTRIES) {
      throw new SkillFetchError(
        `Archive contains too many entries (max ${MAX_ENTRIES}). Aborting extraction.`,
      );
    }
    const relNorm = name.replace(/\\/g, '/');
    if (relNorm.startsWith('/') || relNorm.split('/').includes('..')) {
      throw new SkillFetchError(`Unsafe path in archive: "${name}".`);
    }
    const abs = resolve(join(destDir, relNorm));
    if (abs !== rootResolved && !abs.startsWith(rootWithSep)) {
      throw new SkillFetchError(`Archive entry escapes the target: "${name}".`);
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new SkillFetchError(
        `Extracted archive exceeds size limit (${totalBytes} bytes, max ${MAX_EXTRACTED_BYTES}). ` +
          `Possible decompression bomb.`,
      );
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(data));
  }
}

/**
 * Recursively sum the size in bytes of all regular files under a directory.
 * Used to enforce MAX_EXTRACTED_BYTES after tar extraction.
 */
async function sumExtractedBytes(dir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    let dirents;
    try {
      dirents = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of dirents) {
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile()) {
        try {
          total += (await stat(abs)).size;
        } catch {
          // ignore stat errors on race-condition deletions
        }
      }
    }
  }
  return total;
}

/**
 * Accumulate a running total of declared entry sizes from a tar header and
 * throw immediately if the total exceeds `cap`. Returns the updated total.
 *
 * Exported for unit-testing: the real filter wires this so that the check
 * fires BEFORE node-tar writes each entry body to disk — the entry header
 * is parsed first, giving us `ReadEntry.size` before extraction begins.
 *
 * @param runningTotal - bytes accumulated so far across previous entries
 * @param entrySize    - the size declared in this entry's tar header (may be 0
 *                       for directories)
 * @param cap          - the maximum allowed total (inclusive)
 * @returns the new running total (`runningTotal + entrySize`)
 * @throws SkillFetchError when the new total would exceed `cap`
 */
export function accumulateDeclaredBytes(
  runningTotal: number,
  entrySize: number,
  cap: number,
): number {
  const next = runningTotal + entrySize;
  if (next > cap) {
    throw new SkillFetchError(
      `Extracted archive exceeds size limit (${next} bytes, max ${cap}). ` +
        `Possible decompression bomb.`,
    );
  }
  return next;
}

/**
 * Detect the archive format by magic bytes and extract into destDir.
 * Exported as `_extractArchiveBuffer` for unit-testing the security guards.
 */
async function extractBuffer(buf: Buffer, destDir: string, workDir: string): Promise<void> {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    await unzipBufferTo(buf, destDir); // "PK" → zip
    return;
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const tgz = join(workDir, 'archive.tar.gz'); // gzip → tar.gz
    await writeFile(tgz, buf);
    const destResolved = resolve(destDir);
    const destWithSep = destResolved.endsWith(sep) ? destResolved : destResolved + sep;
    let entryCount = 0;
    let declaredBytes = 0;
    // node-tar filter: reject non-File/Directory entries (symlinks, devices, etc.)
    // and reject any entry whose resolved path escapes destDir.
    // The filter signature is (path, Stats | ReadEntry): during extraction the
    // second argument is always a ReadEntry; Stats is only used when creating.
    // IMPORTANT: this filter runs during header parse, BEFORE node-tar writes the
    // entry body — so throwing here aborts extraction before any bytes hit disk.
    const filter = (entryPath: string, entry: Stats | ReadEntry): boolean => {
      entryCount++;
      if (entryCount > MAX_ENTRIES) {
        throw new SkillFetchError(
          `Archive contains too many entries (max ${MAX_ENTRIES}). Aborting extraction.`,
        );
      }
      // entry.type exists on ReadEntry (extraction). Stats has no .type field —
      // this path is only reached during extraction so we cast safely.
      const type: string = (entry as ReadEntry).type ?? 'File';
      if (type !== 'File' && type !== 'OldFile' && type !== 'Directory') {
        throw new SkillFetchError(
          `Archive contains a disallowed entry type "${type}" at path "${entryPath}". ` +
            `Only regular files and directories are permitted.`,
        );
      }
      const abs = resolve(join(destDir, entryPath));
      if (abs !== destResolved && !abs.startsWith(destWithSep)) {
        throw new SkillFetchError(
          `Archive entry escapes the target directory: "${entryPath}".`,
        );
      }
      // Pre-extraction decompression-bomb guard: accumulate declared sizes from
      // tar headers and throw before node-tar writes the entry body to disk.
      const entrySize = (entry as ReadEntry).size ?? 0;
      declaredBytes = accumulateDeclaredBytes(declaredBytes, entrySize, MAX_EXTRACTED_BYTES);
      return true;
    };
    await tarExtract({ file: tgz, cwd: destDir, filter });
    // Post-extraction decompression-bomb backstop (catches any discrepancy between
    // the declared size in the header and the actual bytes written to disk).
    const extractedBytes = await sumExtractedBytes(destDir);
    if (extractedBytes > MAX_EXTRACTED_BYTES) {
      throw new SkillFetchError(
        `Extracted archive exceeds size limit (${extractedBytes} bytes, max ${MAX_EXTRACTED_BYTES}). ` +
          `Possible decompression bomb.`,
      );
    }
    return;
  }
  throw new SkillFetchError('Unsupported archive format (expected .zip or .tar.gz).');
}

/**
 * Exported shim for unit-testing the archive security guards without network I/O.
 * Not part of the public API — prefixed with `_` to make that clear.
 */
export async function _extractArchiveBuffer(
  buf: Buffer,
  destDir: string,
  workDir: string,
): Promise<void> {
  return extractBuffer(buf, destDir, workDir);
}

/**
 * Download the skill archive and extract it. Returns the directory the skill's
 * files live under (a single top-level folder for GitHub tarballs; the extract
 * root for ClawHub zips).
 */
export async function downloadAndExtract(source: SkillSource): Promise<ExtractedRepo> {
  const workDir = await mkdtemp(join(tmpdir(), 'nodal-skill-dl-'));
  const cleanup = async () => {
    await rm(workDir, { recursive: true, force: true });
  };

  try {
    const extractDir = join(workDir, 'extracted');
    await mkdir(extractDir, { recursive: true });

    if (source.provider === 'clawhub') {
      const buf = await downloadToBuffer(clawhubDownloadUrl(source));
      await extractBuffer(buf, extractDir, workDir);
      return { extractRoot: extractDir, ref: 'latest', cleanup };
    }

    // GitHub: try candidate refs until one resolves (404 → next).
    let buf: Buffer | null = null;
    let usedRef: string | null = null;
    for (const ref of candidateRefs(source)) {
      const res = await fetch(tarballUrl(source, ref), {
        redirect: 'follow',
        headers: { 'User-Agent': 'nodal-agents-skill-installer' },
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        throw new SkillFetchError(
          `Failed to download ${source.owner}/${source.repo}@${ref}: HTTP ${res.status}.`,
        );
      }
      buf = await readCapped(res);
      usedRef = ref;
      break;
    }
    if (!usedRef || !buf) {
      throw new SkillFetchError(
        `Repository or ref not found: ${source.owner}/${source.repo} (tried: ${candidateRefs(source).join(', ')}).`,
      );
    }
    await extractBuffer(buf, extractDir, workDir);

    // The GitHub archive expands to a single top-level dir (e.g. "repo-main").
    const topDirs = (await readdir(extractDir, { withFileTypes: true })).filter((d) =>
      d.isDirectory(),
    );
    if (topDirs.length !== 1) {
      throw new SkillFetchError(`Unexpected archive layout (${topDirs.length} top-level entries).`);
    }
    return { extractRoot: join(extractDir, topDirs[0]!.name), ref: usedRef, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Find every SKILL.md inside an extracted skill, returning paths relative to
 * `root` (forward-slashed), shallowest first.
 */
export async function findSkillManifests(root: string): Promise<string[]> {
  const out: string[] = [];
  let scanned = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (scanned++ > 20000) break;
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === '.git' || d.name === 'node_modules') continue;
        stack.push(abs);
      } else if (d.isFile() && d.name.toLowerCase() === 'skill.md') {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  }
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return out;
}

/** True if `p` exists and is a regular file. */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
