// cron/prune-media.ts — best-effort deletion of inbound media files left
// behind by pruned agent_jobs rows.
//
// Telegram and Discord attachments are written to the entity's SHARED
// workspace at:
//   <workspacesRoot>/<entityId>/shared/telegram/<chatId>/<jobId>/<original name>
//     (apps/runner/src/channels/inbound-files.ts receiveInboundFiles, #899)
//   <workspacesRoot>/<entityId>/shared/telegram/<chatId>/<jobId>.<ext>
//     (the Telegram photos written before #899)
//   <workspacesRoot>/<entityId>/shared/discord/<channelId>/<jobId>.<ext>
//     (apps/runner/src/channels/discord/handler.ts attachInboundImage)
// and the images and PDFs a job's tools fetched, beside them, one folder per job:
//   <workspacesRoot>/<entityId>/shared/tools/<jobId>/<toolCallId>-<n>.<ext>
//     (apps/runner/src/job/model-images.ts saveToolAttachments)
//
// DB retention (packages/db's pruneOldJobs) only deletes the agent_jobs row —
// it must never touch the filesystem (only the runner owns workspace paths).
// Once a job is pruned, its media file is unreferenced forever, so leaving it
// on disk grows the workspace unbounded. This walks every entity's
// shared/{telegram,discord,tools} directories for what belongs to a pruned
// job — a file whose basename (sans extension) is its id, or a folder named
// after it, at either level — and deletes it.
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
      const convoDirs = await safeReaddir(channelRoot);
      if (!convoDirs) continue;

      for (const convoDir of convoDirs) {
        if (!convoDir.isDirectory()) continue;
        const convoPath = join(channelRoot, convoDir.name);
        const files = await safeReaddir(convoPath);
        if (!files) continue;

        // A folder named after the pruned job holds only that job's media.
        const wholeFolder = jobIdSet.has(convoDir.name);
        for (const file of files) {
          if (file.isDirectory() && jobIdSet.has(file.name)) {
            filesDeleted += await removeJobFolder(join(convoPath, file.name));
            continue;
          }
          if (!file.isFile()) continue;
          const stem = basename(file.name, extname(file.name));
          if (!wholeFolder && !jobIdSet.has(stem)) continue;

          const filePath = join(convoPath, file.name);
          try {
            await rm(filePath);
            filesDeleted++;
          } catch (err) {
            console.warn(`[retention] failed to delete pruned-job media file "${filePath}":`, err);
          }
        }
      }
    }
  }

  return { filesDeleted };
}

/**
 * Delete a job's folder of received files (<chat>/<jobId>/, #899) and return
 * how many files it held. Loud on failure, like every deletion here.
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
