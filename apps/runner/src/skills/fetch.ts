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
 * Read a response body up to `MAX_ARCHIVE_BYTES`, aborting the stream the
 * moment the cumulative size crosses the cap instead of buffering the whole
 * body first — a compromised (or merely huge) allowlisted host must not be
 * able to OOM the runner by returning a multi-GB response before we ever get
 * to check its size.
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
    const { done, value } = await reader.read();
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

/** Hard cap on HTTP redirect hops (anti-abuse; also bounds SSRF-check cost). */
const MAX_REDIRECTS = 5;

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
    const res = await fetch(current, { redirect: 'manual', headers });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new SkillFetchError(`Redirect response (${res.status}) missing Location.`);
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
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(await fileRes.arrayBuffer()));
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
