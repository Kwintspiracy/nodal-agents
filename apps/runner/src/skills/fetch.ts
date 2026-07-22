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
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';
import {
  type SkillSource,
  candidateRefs,
  tarballUrl,
  clawhubDownloadUrl,
  isAllowedHost,
} from './source';

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

/**
 * A stalled (not dead — TCP keeps the socket open, just no bytes arrive)
 * allowlisted host must not be able to hang readCapped forever: that freezes
 * the cron tick (behind its 15min watchdog) or the /api/skills/install route.
 * Reset on every chunk received; only fires on true inactivity.
 */
const READ_INACTIVITY_TIMEOUT_MS = 30_000;

/**
 * Read a response body up to `MAX_ARCHIVE_BYTES`, aborting the stream the
 * moment the cumulative size crosses the cap instead of buffering the whole
 * body first — a compromised (or merely huge) allowlisted host must not be
 * able to OOM the runner by returning a multi-GB response before we ever get
 * to check its size. Also bounds the DURATION of the read: if no chunk
 * arrives within READ_INACTIVITY_TIMEOUT_MS, the reader is cancelled and a
 * SkillFetchError is thrown — a size cap alone doesn't protect against a host
 * that opens the connection and then never sends another byte.
 */
async function readCapped(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body available (e.g. an empty response) — nothing to cap.
    return Buffer.from(await res.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new SkillFetchError(
            `Download stalled: no data received for ${READ_INACTIVITY_TIMEOUT_MS}ms. Aborted mid-download.`,
          ),
        );
      }, READ_INACTIVITY_TIMEOUT_MS);
    });

    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([reader.read(), timeoutPromise]);
    } catch (err) {
      await reader.cancel().catch(() => {
        /* best-effort — we're already throwing */
      });
      throw err instanceof SkillFetchError
        ? err
        : new SkillFetchError(
            `Error reading skill archive stream: ${err instanceof Error ? err.message : String(err)}`,
          );
    } finally {
      clearTimeout(timeoutHandle);
    }

    const { done, value } = result;
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel().catch(() => {
        /* best-effort — we're already throwing */
      });
      throw new SkillFetchError(
        `Skill archive is too large (exceeds ${MAX_ARCHIVE_BYTES} bytes). Aborted mid-download.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Exported shim for unit-testing the inactivity-timeout guard directly
 * against a constructed Response — without going through downloadAndExtract
 * (real mkdtemp/fs calls race unpredictably against fake timers). Not part of
 * the public API — prefixed with `_` to make that clear.
 */
export async function _readCapped(res: Response): Promise<Buffer> {
  return readCapped(res);
}

/** Hard cap on HTTP redirect hops (anti-abuse; also bounds SSRF-check cost). */
const MAX_REDIRECTS = 5;

/**
 * Per-request timeout for every network call in this module (each redirect
 * hop gets its own fresh budget). Without this, an allowlisted host that
 * accepts the connection and then never responds hangs the caller forever —
 * freezing the cron tick (behind its 15min watchdog) or the
 * /api/skills/install route.
 */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch a URL, following redirects MANUALLY so every hop — not just the
 * initial URL — is re-checked against the anti-SSRF host allowlist. An
 * allowlisted host with an open redirect could otherwise be used to reach an
 * internal address (169.254.x.x, localhost, ...) via `redirect: 'follow'`.
 */
async function fetchAllowlisted(url: string, headers: Record<string, string>): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new SkillFetchError(`Invalid redirect target: "${current}".`);
    }
    if (!isAllowedHost(parsed.hostname)) {
      throw new SkillFetchError(
        `Redirected to a non-allowlisted host: "${parsed.hostname}". Refusing to follow.`,
      );
    }
    // M1 (Opus review): a raw network failure (DNS, ECONNRESET, TLS handshake
    // — Node/undici surface these as an unwrapped TypeError, never a
    // SkillFetchError) must not escape this function as-is. Every network
    // call in this module funnels through here, so wrapping it in ONE place
    // is enough: uncaught, it would propagate straight past
    // checkSkillUpdate's SkillFetchError-only catch (check-updates.ts) and
    // crash the whole cron batch instead of being retried per-skill. The
    // message deliberately doesn't match isRateLimitError/isNotFoundError
    // (check-updates.ts) — it's a distinct, transient class of failure.
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SkillFetchError(
        `Network error reaching "${current}": ${msg}. This is usually transient — retry.`,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location)
        throw new SkillFetchError(`Redirect response (${res.status}) missing Location.`);
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new SkillFetchError(`Too many redirects (max ${MAX_REDIRECTS}) fetching "${url}".`);
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetchAllowlisted(url, { 'User-Agent': 'nodal-agents-skill-installer' });
  if (!res.ok) throw new SkillFetchError(`Download failed: HTTP ${res.status}.`);
  return readCapped(res);
}

/**
 * Bytes of (still-compressed) archive input fed to fflate's streaming `Unzip`
 * per `push()` call. `unzipSync` decompresses every entry to completion
 * before we ever see a byte of output, so a decompression bomb (a small
 * DEFLATE stream that inflates to many GB — a single, non-nested DEFLATE
 * stream can reach ~1032:1 on all-zero input) OOMs the process long before
 * the MAX_EXTRACTED_BYTES check below ever runs. Feeding the compressed
 * bytes in small chunks instead bounds the output producible by any ONE
 * `push()` call to roughly `chunk size * ~1032`, so the running-total check
 * gets to fire and abort BETWEEN chunks, capping the worst-case overshoot at
 * ~16.5 MB (16 KB * 1032) past MAX_EXTRACTED_BYTES instead of tens of GB.
 */
const ZIP_PUSH_CHUNK_BYTES = 16 * 1024;

/**
 * Extract a zip with zip-slip protection and a decompression-bomb guard.
 *
 * Uses fflate's streaming, push-based `Unzip` rather than `unzipSync` — see
 * ZIP_PUSH_CHUNK_BYTES for why. This brings the zip path to parity with the
 * tar.gz path below, which already bounds declared entry sizes before
 * writing any bytes to disk.
 */
async function unzipBufferTo(buf: Buffer, destDir: string): Promise<void> {
  const rootResolved = resolve(destDir);
  const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  let entryCount = 0;
  let totalBytes = 0;
  // Recorded rather than thrown directly: fflate's UnzipInflate wraps entry
  // decompression in its own try/catch and re-delivers a thrown error to
  // `ondata` a second time, so a throw from inside these callbacks isn't
  // guaranteed to propagate cleanly out of unzip.push(). Instead every
  // callback becomes a no-op once a violation is recorded, and we throw
  // explicitly once feeding stops — the same pattern the tar filter below
  // uses, and for the same reason (node-tar has an analogous constraint).
  let violation: SkillFetchError | null = null;
  const pendingWrites: Promise<void>[] = [];

  const unzip = new Unzip();
  unzip.register(UnzipInflate); // decode DEFLATE entries; stored (type 0) works via fflate's built-in default

  unzip.onfile = (file: UnzipFile) => {
    if (violation) return;
    if (file.name.endsWith('/')) return; // directory entry

    entryCount++;
    if (entryCount > MAX_ENTRIES) {
      violation = new SkillFetchError(
        `Archive contains too many entries (max ${MAX_ENTRIES}). Aborting extraction.`,
      );
      return;
    }

    const relNorm = file.name.replace(/\\/g, '/');
    if (relNorm.startsWith('/') || relNorm.split('/').includes('..')) {
      violation = new SkillFetchError(`Unsafe path in archive: "${file.name}".`);
      return;
    }
    const abs = resolve(join(destDir, relNorm));
    if (abs !== rootResolved && !abs.startsWith(rootWithSep)) {
      violation = new SkillFetchError(`Archive entry escapes the target: "${file.name}".`);
      return;
    }

    const chunks: Buffer[] = [];
    file.ondata = (err, data, final) => {
      if (violation) return;
      if (err) {
        violation = new SkillFetchError(`Corrupt archive entry "${file.name}": ${err.message}`);
        return;
      }
      if (data && data.byteLength) {
        totalBytes += data.byteLength;
        if (totalBytes > MAX_EXTRACTED_BYTES) {
          violation = new SkillFetchError(
            `Extracted archive exceeds size limit (${totalBytes} bytes, max ${MAX_EXTRACTED_BYTES}). ` +
              `Possible decompression bomb.`,
          );
          return;
        }
        chunks.push(Buffer.from(data));
      }
      if (final && !violation) {
        const fileData = Buffer.concat(chunks);
        pendingWrites.push(
          mkdir(dirname(abs), { recursive: true }).then(() => writeFile(abs, fileData)),
        );
      }
    };
    file.start();
  };

  // Feed the archive in bounded chunks (see ZIP_PUSH_CHUNK_BYTES) instead of
  // one `push(buf, true)` call, so decompression output stays bounded per call.
  const total = buf.length;
  for (let offset = 0; offset < total && !violation; offset += ZIP_PUSH_CHUNK_BYTES) {
    const end = Math.min(offset + ZIP_PUSH_CHUNK_BYTES, total);
    unzip.push(new Uint8Array(buf.subarray(offset, end)), end >= total);
  }
  if (total === 0) unzip.push(new Uint8Array(0), true);

  if (violation) {
    // A valid entry earlier in the archive may already have a write in
    // flight (pushed to pendingWrites) by the time a later entry trips the
    // violation — push() is synchronous but writeFile() isn't. Let those
    // settle before throwing so we never leave a write racing the caller's
    // cleanup() (which rm()s workDir) — that race can otherwise surface as
    // an unhandled rejection. We don't care whether they succeeded: we're
    // about to reject the whole extraction either way.
    await Promise.allSettled(pendingWrites);
    throw violation;
  }
  await Promise.all(pendingWrites);

  // unzipSync surfaced "invalid zip data" for a corrupt/non-zip buffer;
  // the streaming Unzip instead just never calls onfile and resolves with
  // zero entries, which downstream turns into a misleading "No SKILL.md
  // found" rather than the real "this isn't a valid zip" error. A zip with
  // zero FILE entries is unusable as a skill source either way (directory-
  // only or genuinely empty archives included), so treat it as corrupt.
  if (entryCount === 0) {
    throw new SkillFetchError('Invalid or corrupt zip archive (no entries found).');
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
    //
    // CRITICAL: the filter must NOT throw. node-tar runs it inside the tar parse
    // stream, and an exception thrown here does NOT reject the tarExtract()
    // promise — it leaks the stream and the promise hangs forever (observed:
    // install.test's tar-symlink case timed out at 60s on Linux CI, while Windows
    // silently skipped it because it can't create the symlink fixture). Instead we
    // RECORD the first violation and return false — returning false during the
    // header parse means the offending entry's body is never written to disk —
    // then let extraction finish and throw afterwards.
    let violation: SkillFetchError | null = null;
    const filter = (entryPath: string, entry: Stats | ReadEntry): boolean => {
      if (violation) return false;
      entryCount++;
      if (entryCount > MAX_ENTRIES) {
        violation = new SkillFetchError(
          `Archive contains too many entries (max ${MAX_ENTRIES}). Aborting extraction.`,
        );
        return false;
      }
      // entry.type exists on ReadEntry (extraction). Stats has no .type field —
      // this path is only reached during extraction so we cast safely.
      const type: string = (entry as ReadEntry).type ?? 'File';
      if (type !== 'File' && type !== 'OldFile' && type !== 'Directory') {
        violation = new SkillFetchError(
          `Archive contains a disallowed entry type "${type}" at path "${entryPath}". ` +
            `Only regular files and directories are permitted.`,
        );
        return false;
      }
      const abs = resolve(join(destDir, entryPath));
      if (abs !== destResolved && !abs.startsWith(destWithSep)) {
        violation = new SkillFetchError(
          `Archive entry escapes the target directory: "${entryPath}".`,
        );
        return false;
      }
      // Pre-extraction decompression-bomb guard: accumulate declared sizes from
      // tar headers; returning false skips the body before it hits disk.
      try {
        const entrySize = (entry as ReadEntry).size ?? 0;
        declaredBytes = accumulateDeclaredBytes(declaredBytes, entrySize, MAX_EXTRACTED_BYTES);
      } catch (e) {
        violation = e instanceof SkillFetchError ? e : new SkillFetchError(String(e));
        return false;
      }
      return true;
    };
    await tarExtract({ file: tgz, cwd: destDir, filter });
    if (violation) throw violation;
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

// ─── GitHub subdir fetch (efficient install from a monorepo) ──────────────────
//
// A skill that lives in a subdirectory of a large repo (e.g.
// NousResearch/hermes-agent → skills/creative/comfyui) must NOT pull the
// whole-repo tarball: that repo is 50MB+ compressed and hundreds of MB
// extracted, which blows both the download and extraction caps just to reach a
// ~200KB folder. Instead we walk ONLY the subdir via the GitHub Contents API
// and download each file from raw.githubusercontent.com (already allowlisted).
// One API request per directory; the same MAX_ENTRIES / MAX_EXTRACTED_BYTES
// guards apply. This is the norm for community skills — most ship inside a
// monorepo of many skills.

interface GhContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | string;
  size: number;
  download_url: string | null;
}

function ghApiHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'nodal-agents-skill-installer',
    Accept: 'application/vnd.github+json',
  };
  // Optional: lifts the 60 req/hr unauthenticated limit. Not required for public repos.
  const token = process.env['GITHUB_TOKEN'];
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/** List a repo directory via the GitHub Contents API. null on 404 (ref/path missing). */
async function ghContents(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<GhContentEntry[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetchAllowlisted(url, ghApiHeaders());
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    throw new SkillFetchError(
      'GitHub API rate limit reached. Set a GITHUB_TOKEN environment variable or retry later.',
    );
  }
  if (!res.ok)
    throw new SkillFetchError(`GitHub Contents API error: HTTP ${res.status} for "${path}".`);
  const data = await res.json();
  if (!Array.isArray(data))
    throw new SkillFetchError(`Expected a directory at "${path}", got a file.`);
  return data as GhContentEntry[];
}

/**
 * Download every file under a GitHub subdir into `destRoot`, preserving
 * repo-relative paths (so pickManifest's subdir logic works unchanged). Enforces
 * the same entry-count and total-size caps as archive extraction.
 */
async function downloadGithubSubdir(
  source: SkillSource,
  ref: string,
  topEntries: GhContentEntry[],
  destRoot: string,
): Promise<void> {
  const destResolved = resolve(destRoot);
  const destWithSep = destResolved.endsWith(sep) ? destResolved : destResolved + sep;
  let entryCount = 0;
  let totalBytes = 0;

  const processEntries = async (entries: GhContentEntry[]): Promise<void> => {
    for (const e of entries) {
      if (e.type === 'dir') {
        const sub = await ghContents(source.owner, source.repo, e.path, ref);
        if (sub) await processEntries(sub);
        continue;
      }
      // Skip anything that is not a plain file with a raw URL (submodules, symlinks).
      if (e.type !== 'file' || !e.download_url) continue;
      if (++entryCount > MAX_ENTRIES) {
        throw new SkillFetchError(`Subdir contains too many files (max ${MAX_ENTRIES}).`);
      }
      totalBytes += e.size ?? 0;
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        throw new SkillFetchError(
          `Subdir exceeds size limit (${totalBytes} bytes, max ${MAX_EXTRACTED_BYTES}).`,
        );
      }
      const abs = resolve(join(destRoot, e.path));
      if (abs !== destResolved && !abs.startsWith(destWithSep)) {
        throw new SkillFetchError(`Entry escapes the target directory: "${e.path}".`);
      }
      const fileRes = await fetchAllowlisted(e.download_url, {
        'User-Agent': 'nodal-agents-skill-installer',
      });
      if (!fileRes.ok)
        throw new SkillFetchError(`Download failed for "${e.path}": HTTP ${fileRes.status}.`);
      // I-15: don't trust the Contents API's declared `size` — a compromised
      // or lying allowlisted host could serve a body far larger than
      // advertised. readCapped() aborts mid-stream the moment the ACTUAL
      // bytes read cross MAX_ARCHIVE_BYTES, same guard as the archive
      // download path above.
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await readCapped(fileRes));
    }
  };

  await processEntries(topEntries);
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

    // GitHub + explicit subdir: fetch ONLY that folder via the Contents API
    // instead of the whole-repo tarball (essential for skills inside large
    // monorepos). Files are written under extractDir at their repo-relative
    // path, so pickManifest(extractRoot, subdir) resolves them unchanged.
    if (source.provider === 'github' && source.subdir) {
      const sub = source.subdir.replace(/\/+$/, '');
      for (const ref of candidateRefs(source)) {
        const top = await ghContents(source.owner, source.repo, sub, ref);
        if (top === null) continue;
        await downloadGithubSubdir(source, ref, top, extractDir);
        return { extractRoot: extractDir, ref, cleanup };
      }
      throw new SkillFetchError(
        `Subdir not found: ${source.owner}/${source.repo}/${sub} (tried refs: ${candidateRefs(source).join(', ')}).`,
      );
    }

    // GitHub: try candidate refs until one resolves (404 → next).
    let buf: Buffer | null = null;
    let usedRef: string | null = null;
    for (const ref of candidateRefs(source)) {
      const res = await fetchAllowlisted(tarballUrl(source, ref), {
        'User-Agent': 'nodal-agents-skill-installer',
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
