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
import type { ToolContext } from '../../types';
import { resolveAndCheckPath, WorkspaceError } from '../file-ops/workspace';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_OFFICE_BYTES = 25 * 1024 * 1024; // 25 MiB

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
 * Returns a discriminated union — never throws on expected errors.
 */
export async function readWorkspaceBinary(
  ctx: ToolContext,
  path: string,
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
