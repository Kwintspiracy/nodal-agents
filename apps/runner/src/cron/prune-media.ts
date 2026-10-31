// cron/prune-media.ts — best-effort deletion of inbound media files left
// behind by pruned agent_jobs rows.
//
// Telegram and Discord attachments are written to the entity's SHARED
// workspace at:
//   <workspacesRoot>/<entityId>/shared/telegram/<jobId>/<original name>
//     (apps/runner/src/channels/inbound-files.ts receiveInboundFiles, #899, #910)
//   <workspacesRoot>/<entityId>/shared/discord/<jobId>.<ext>
//     (apps/runner/src/channels/discord/handler.ts attachInboundImage, #910)
// and the images and PDFs a job's tools fetched, beside them, one folder per job:
//   <workspacesRoot>/<entityId>/shared/tools/<jobId>/<toolCallId>-<n>.<ext>
//     (apps/runner/src/job/model-images.ts saveToolAttachments)
// Before #910 the channel folders had one more level, the conversation
// address, and what was written then is still on disk:
//   <workspacesRoot>/<entityId>/shared/telegram/<chatId>/<jobId>/<original name>
//   <workspacesRoot>/<entityId>/shared/telegram/<chatId>/<jobId>.<ext>
//   <workspacesRoot>/<entityId>/shared/discord/<channelId>/<jobId>.<ext>
//
// DB retention (packages/db's pruneOldJobs) only deletes the agent_jobs row —
// it must never touch the filesystem (only the runner owns workspace paths).
// Once a job is pruned, its media file is unreferenced forever, so leaving it
// on disk grows the workspace unbounded. This walks every entity's
// shared/{telegram,discord,tools} directories for what belongs to a pruned
// job — a file whose basename (sans extension) is its id, or a folder named
// after it, at either level (the channel folder, or one folder below it) —
// and deletes it.
//
// Best-effort PER FILE (a locked file must not fail the whole phase) but
// LOUD: every failure is console.warn'd so it stays diagnosable.

import { readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, basename, extname } from 'node:path';

/** Channel subdirectories under <entityId>/shared/ that hold inbound media. */
const MEDIA_CHANNEL_DIRS = ['telegram', 'discord', 'tools'] as const;

export interface PruneMediaResult {
  filesDeleted: number;
}

/** readdir that swallows a missing directory (nothing to prune there) but logs any other error. */
async function safeReaddir(dir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[retention] failed to read media directory "${dir}":`, err);
    }
    return null;
  }
}

/**
 * Delete inbound media files belonging to the given (already DB-pruned) job
 * ids, under `workspacesRoot` (the `.nodalai/workspaces` directory —
 * parameterised so tests can point it at a tmpdir instead of the real home
 * directory).
 */
export async function pruneJobMediaFiles(
  workspacesRoot: string,
  jobIds: readonly string[],
): Promise<PruneMediaResult> {
  if (jobIds.length === 0) {
    return { filesDeleted: 0 };
  }
  const jobIdSet = new Set(jobIds);
  let filesDeleted = 0;

  const entityDirs = await safeReaddir(workspacesRoot);
  if (!entityDirs) {
    return { filesDeleted: 0 };
  }

  for (const entityDir of entityDirs) {
    if (!entityDir.isDirectory()) continue;

    for (const channel of MEDIA_CHANNEL_DIRS) {
      const channelRoot = join(workspacesRoot, entityDir.name, 'shared', channel);
      const below = await pruneJobEntries(channelRoot, jobIdSet);
      filesDeleted += below.filesDeleted;
      // One level down: the conversation folders written before #910.
      for (const dir of below.otherFolders) {
        filesDeleted += (await pruneJobEntries(dir, jobIdSet)).filesDeleted;
      }
    }
  }

  return { filesDeleted };
}

/**
 * Delete, in ONE folder, what belongs to a pruned job: its folder (`<jobId>/`)
 * or its file (`<jobId>.<ext>`). Returns how many files went, and the
 * sub-folders that are not a job's.
 */
async function pruneJobEntries(
  dir: string,
  jobIdSet: ReadonlySet<string>,
): Promise<{ filesDeleted: number; otherFolders: string[] }> {
  const entries = await safeReaddir(dir);
  if (!entries) return { filesDeleted: 0, otherFolders: [] };
  let filesDeleted = 0;
  const otherFolders: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (jobIdSet.has(entry.name)) filesDeleted += await removeJobFolder(path);
      else otherFolders.push(path);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!jobIdSet.has(basename(entry.name, extname(entry.name)))) continue;
    try {
      await rm(path);
      filesDeleted++;
    } catch (err) {
      console.warn(`[retention] failed to delete pruned-job media file "${path}":`, err);
    }
  }
  return { filesDeleted, otherFolders };
}

/**
 * Delete a job's folder (its received files, #899, or its tools' images) and
 * return how many files it held. Loud on failure, like every deletion here.
 */
async function removeJobFolder(dir: string): Promise<number> {
  const entries = await safeReaddir(dir);
  if (!entries) return 0;
  try {
    await rm(dir, { recursive: true });
    return entries.filter((e) => e.isFile()).length;
  } catch (err) {
    console.warn(`[retention] failed to delete pruned-job media folder "${dir}":`, err);
    return 0;
  }
}
