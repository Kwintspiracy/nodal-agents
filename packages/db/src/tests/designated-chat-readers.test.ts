// designated-chat-readers.test.ts — no job's chat id is read without its
// channel (#649, review of #657 pass 4).
//
// designated-chat-writers.test.ts closed the WRITERS: a job row's chat carries
// the channel it was resolved on, or NULL. A reader could still drop it: the
// send tools read `ctx.jobChatId` on whatever channel they resolved — the
// first active one for a chat whose platform nobody recorded — and sent a
// Telegram chat id to Discord. The rule now: a job's chat id is read next to
// its channel (`chatChannel`, `jobChatChannel`, `designatedChatChannel`), or
// at one of the places listed below, each of which says why it addresses no
// platform. A new reader that does neither turns this file red.
//
// What it reads: every `<x>job.chatId` / `<x>Job.chatId` member access and
// every `.jobChatId` member access in non-test source under apps/*/src and
// packages/*/src. "Next to" means within WINDOW lines, comments excluded.
// What it cannot see, and says: an id copied into a variable of another name
// and read further away.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/** How far (in lines, either side) the channel may sit from the read. */
const WINDOW = 3;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === '__tests__' || name === 'dist') {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function srcRoots(): string[] {
  const roots: string[] = [];
  for (const group of ['apps', 'packages']) {
    const base = join(repoRoot, group);
    for (const pkg of readdirSync(base)) {
      if (pkg === 'test-kit') continue; // test fixtures, never a production reader
      const src = join(base, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // a package without src/
      }
    }
  }
  return roots;
}

/** Comments removed, line count kept: a block comment leaves its newlines. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const READ = /\b\w*[jJ]ob\??\.chatId\b|\.jobChatId\b/;
const CHANNEL = /chatchannel/i;

/** The lines of `source` that read a job's chat id with no channel within WINDOW lines. */
export function chatIdReadAlone(source: string): string[] {
  const lines = stripComments(source).split('\n');
  const alone: string[] = [];
  lines.forEach((line, i) => {
    if (!READ.test(line)) return;
    const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
    if (!CHANNEL.test(near)) alone.push(line.trim());
  });
  return alone;
}

/**
 * The reads that address no platform, each with why. A line here is matched
 * by its exact text: edit the line, and this list must be read again.
 */
const ADDRESSES_NO_PLATFORM: ReadonlyArray<{ file: string; line: string; why: string }> = [
  {
    file: 'apps/runner/src/cli-runtime/run-job.ts',
    line: 'const rawConversationKey = job.conversationId ?? job.chatId;',
    why: 'the CLI session key of a conversation: a lookup key, never a send target',
  },
  {
    file: 'apps/runner/src/cli-runtime/run-job.ts',
    line: 'if (job.chatId && turn.finalText.trim()) {',
    why: 'whether to resolve a target at all; the target is resolveDeliveryTarget, with chatChannel',
  },
  {
    file: 'apps/runner/src/cron/deliver-results.ts',
    line: "if (rootStatus === 'completed' && rootJob.chatId && compiledResult.trim()) {",
    why: 'whether to resolve a target at all; the target is resolveDeliveryTarget, with chatChannel',
  },
  {
    file: 'apps/runner/src/delivery/resolve-delivery-target.ts',
    line: "const chatId = job.chatId?.trim() ?? '';",
    why: 'resolveDeliveryTarget itself: the channel is designatedChatChannel a few lines down',
  },
  {
    file: 'apps/runner/src/job/channel-delivery.ts',
    line: "return (job.channel === 'cron' || job.channel === 'webhook') && job.chatId != null;",
    why: 'a confirmation was asked for (a chat is present); where it goes is replyDestination',
  },
  {
    file: 'apps/runner/src/job/execute.ts',
    line: 'if (isFreshExecution && job.entityId && job.agentId && job.chatId) {',
    why: 'whether to replay the thread history, read by conversation id, not by chat',
  },
  {
    file: 'apps/runner/src/job/execute.ts',
    line: "if (replyTo.to !== 'channel' || !job.chatId) return null;",
    why: "replyTo.channel is the chat's recorded channel (replyDestination, designatedChatChannel)",
  },
  {
    file: 'apps/runner/src/job/execute.ts',
    line: 'return { channel: replyTo.channel, chatId: job.chatId };',
    why: "replyTo.channel is the chat's recorded channel (replyDestination, designatedChatChannel)",
  },
  {
    file: 'apps/runner/src/job/execute.ts',
    line: "job.chatId ? ` → chat ${job.chatId}` : ''",
    why: "a delegate's delivery notice to its parent: text, not a target",
  },
  {
    file: 'apps/runner/src/job/execute.ts',
    line: 'chatId: job.chatId,',
    why: "the parent shape handed to handleDelegation; delegate.ts reads the channel from the parent's row",
  },
  {
    file: 'apps/web/src/lib/actions.ts',
    line: 'conversation: { channel: job.channel, chatId: job.chatId },',
    why: 'classifyProduction: which conversation a run belongs to, for the verdict shown on screen',
  },
  {
    file: 'apps/web/src/lib/conversation-feed.ts',
    line: 'chatId: job.chatId,',
    why: "the feed's origin label, shown on screen",
  },
  {
    file: 'apps/web/src/lib/job-feed.ts',
    line: 'chatId: job.chatId,',
    why: "the feed's origin label, shown on screen",
  },
];

describe("a job's chat id is never read without its channel (#649) @cap:parler-par-canal-externe/moteur", () => {
  const found: Array<{ file: string; line: string }> = [];
  for (const root of srcRoots()) {
    for (const file of sourceFiles(root)) {
      for (const line of chatIdReadAlone(readFileSync(file, 'utf8'))) {
        found.push({ file: relative(repoRoot, file).split(sep).join('/'), line });
      }
    }
  }
  const listed = (r: { file: string; line: string }) =>
    ADDRESSES_NO_PLATFORM.some((a) => a.file === r.file && a.line === r.line);

  it('every read of a chat id sits next to its channel, or is listed as addressing no platform', () => {
    expect(found.filter((r) => !listed(r))).toEqual([]);
  });

  it('the list holds no stale entry: each one is still a read the scan finds', () => {
    const stale = ADDRESSES_NO_PLATFORM.filter(
      (a) => !found.some((r) => r.file === a.file && r.line === a.line),
    ).map(({ file, line }) => ({ file, line }));
    expect(stale).toEqual([]);
  });

  it('the scan catches the shapes #649 was made of, and lets a paired read through', () => {
    for (const bad of [
      // delivery-guard.ts before pass 4: the chat id on whatever channel.
      'let chatId = explicitChatId ?? (crossChannel ? null : ctx.jobChatId);',
      // execute.ts before pass 4: a Discord id labelled as Telegram.
      '...(job.chatId ? { telegramChatId: job.chatId } : {}),',
      // the delegation input before pass 4: a parent chat with no channel.
      'chatId: parentJob.chatId,',
    ]) {
      expect({ bad, caught: chatIdReadAlone(bad).length }).toEqual({ bad, caught: 1 });
    }
    for (const fine of [
      'return { id: ctx.jobChatId, channel: ctx.jobChatChannel ?? null };',
      'jobChatId: job.chatId ?? null,\n  jobChatChannel,',
      '...designateChat(parentJob.chatId, parentFolderRow?.chatChannel ?? null),',
      '// a comment naming job.chatId is no read',
    ]) {
      expect({ fine, caught: chatIdReadAlone(fine) }).toEqual({ fine, caught: [] });
    }
  });
});
