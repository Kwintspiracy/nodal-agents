// cron/tests/prune-media.test.ts — pruneJobMediaFiles unit tests
//
// Retention (packages/db's pruneOldJobs) only deletes agent_jobs DB rows —
// inbound Telegram photos and Discord attachments live on disk under the
// shared workspace and are never referenced again once their job is pruned.
// pruneJobMediaFiles sweeps those orphaned files. Builds the REAL directory
// structure attachInboundPhoto/attachInboundImage write to
// (<workspacesRoot>/<entityId>/shared/<telegram|discord>/<chatOrChannelId>/<jobId>.<ext>)
// in a tmpdir, prunes one job id, and asserts ONLY that job's files vanished.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneJobMediaFiles } from '../prune-media.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-prune-media-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeMediaFile(
  entityId: string,
  channel: 'telegram' | 'discord',
  convoId: string,
  jobId: string,
  ext: string,
): Promise<string> {
  const dir = join(root, entityId, 'shared', channel, convoId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${jobId}.${ext}`);
  await writeFile(filePath, `fake bytes for ${jobId}`);
  return filePath;
}

describe('pruneJobMediaFiles', () => {
  it('deletes only the files belonging to the pruned job id, leaving every other file untouched', async () => {
    const entityId = 'entity-1';
    const prunedJobId = 'job-pruned-aaa';
    const survivingJobId = 'job-surviving-bbb';

    const prunedTelegramFile = await writeMediaFile(
      entityId,
      'telegram',
      'chat-42',
      prunedJobId,
      'jpg',
    );
    const survivingTelegramFile = await writeMediaFile(
      entityId,
      'telegram',
      'chat-42',
      survivingJobId,
      'jpg',
    );
    const survivingDiscordFile = await writeMediaFile(
      entityId,
      'discord',
      'channel-99',
      survivingJobId,
      'png',
    );

    const result = await pruneJobMediaFiles(root, [prunedJobId]);

    expect(result.filesDeleted).toBe(1);

    // Pruned job's file is gone.
    await expect(
      readdir(join(root, entityId, 'shared', 'telegram', 'chat-42')),
    ).resolves.not.toContain(`${prunedJobId}.jpg`);

    // Surviving files are untouched — real byte-for-byte survival, not just
    // "directory still exists".
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(survivingTelegramFile, 'utf8')).resolves.toBe(
      `fake bytes for ${survivingJobId}`,
    );
    await expect(readFile(survivingDiscordFile, 'utf8')).resolves.toBe(
      `fake bytes for ${survivingJobId}`,
    );
    await expect(readFile(prunedTelegramFile, 'utf8')).rejects.toThrow();
  });

  it("sweeps a job's media across MULTIPLE entities and channels in one call", async () => {
    const prunedJobId = 'job-multi-prune';
    const survivingJobId = 'job-multi-survive';

    const entityAFile = await writeMediaFile('entity-a', 'telegram', 'chat-1', prunedJobId, 'jpg');
    const entityBFile = await writeMediaFile('entity-b', 'discord', 'chan-1', prunedJobId, 'png');
    const survivor = await writeMediaFile('entity-a', 'telegram', 'chat-1', survivingJobId, 'jpg');

    const result = await pruneJobMediaFiles(root, [prunedJobId]);
    expect(result.filesDeleted).toBe(2);

    const { readFile } = await import('node:fs/promises');
    await expect(readFile(entityAFile, 'utf8')).rejects.toThrow();
    await expect(readFile(entityBFile, 'utf8')).rejects.toThrow();
    await expect(readFile(survivor, 'utf8')).resolves.toBe(`fake bytes for ${survivingJobId}`);
  });

  it('is a no-op given an empty job id list', async () => {
    await writeMediaFile('entity-1', 'telegram', 'chat-1', 'job-untouched', 'jpg');
    const result = await pruneJobMediaFiles(root, []);
    expect(result.filesDeleted).toBe(0);
    const files = await readdir(join(root, 'entity-1', 'shared', 'telegram', 'chat-1'));
    expect(files).toHaveLength(1);
  });

  it('returns zero and does not throw when the workspaces root does not exist at all', async () => {
    const missingRoot = join(root, 'never-created');
    const result = await pruneJobMediaFiles(missingRoot, ['some-job-id']);
    expect(result.filesDeleted).toBe(0);
  });

  it('returns zero and does not throw when an entity has no media directories for any channel', async () => {
    await mkdir(join(root, 'entity-empty', 'shared'), { recursive: true });
    const result = await pruneJobMediaFiles(root, ['some-job-id']);
    expect(result.filesDeleted).toBe(0);
  });

  it('does not match a file whose job id is only a PREFIX of another job id', async () => {
    // "job-1" must not match a file named "job-12.jpg" — basename(...,
    // extname(...)) strips the whole extension, giving an exact-match stem,
    // not a prefix match.
    const targetFile = await writeMediaFile('entity-1', 'telegram', 'chat-1', 'job-12', 'jpg');
    const result = await pruneJobMediaFiles(root, ['job-1']);
    expect(result.filesDeleted).toBe(0);
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(targetFile, 'utf8')).resolves.toContain('job-12');
  });
});
