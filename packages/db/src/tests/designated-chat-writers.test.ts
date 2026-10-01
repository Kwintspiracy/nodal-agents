// designated-chat-writers.test.ts — no job row gets a chat outside `designateChat`
// (#649, review of #657 pass 3).
//
// A `chat_id` does not say its platform. Six writers set it, each its own way,
// and some forgot the channel: the runner then guessed it (Telegram chat id sent
// to Discord), or gave up on a routine's confirmation. The rule now: a job row's
// chat is set by `designateChat` / `resolveScheduleNotifyChat`
// (queries/designated-chat.ts), which carry the channel it was resolved on, or
// NULL. This file scans the source so a seventh writer cannot set `chatId` by
// hand without this test naming it.
//
// What it reads: the arguments of every `.insert(agentJobs).values(…)`,
// `insertChildJob(…)` and `startConversationTurn(…)` call in non-test source
// under apps/*/src and packages/*/src. What it cannot see, and says: a values
// object built in a variable elsewhere and passed by name. The SQL side (the
// inbox relaunch trigger) is checked below on its latest definition.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

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
      if (pkg === 'test-kit') continue; // test fixtures, never a production writer
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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The text between the parenthesis at `open` and its match. */
function balanced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

function withoutDesignations(args: string): string {
  let out = args;
  for (const fn of ['designateChat', 'resolveScheduleNotifyChat']) {
    for (;;) {
      const at = out.search(new RegExp(`\\b${fn}\\(`));
      if (at < 0) break;
      const open = out.indexOf('(', at);
      const inner = balanced(out, open);
      out = out.slice(0, at) + out.slice(open + inner.length + 2);
    }
  }
  return out;
}

/** Every job-writing call of `source` whose arguments set `chatId` by hand. */
export function chatIdWrittenByHand(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const calls: RegExp[] = [
    /\.insert\(\s*agentJobs\s*\)\s*\.values\(/g,
    /(?<!function\s)\binsertChildJob\(/g,
    /(?<!function\s)\bstartConversationTurn\(/g,
  ];
  for (const call of calls) {
    for (const m of code.matchAll(call)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const args = balanced(code, open);
      if (/\bchatId\b/.test(withoutDesignations(args))) {
        found.push(`${m[0].trim()} ${args.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
  }
  return found;
}

describe('a job row gets its chat only through designateChat (#649) @cap:parler-par-canal-externe/moteur', () => {
  it('no writer in the source sets chatId by hand', () => {
    const offenders: Array<{ file: string; calls: string[] }> = [];
    for (const root of srcRoots()) {
      for (const file of sourceFiles(root)) {
        const calls = chatIdWrittenByHand(readFileSync(file, 'utf8'));
        if (calls.length > 0) {
          offenders.push({ file: relative(repoRoot, file).split(sep).join('/'), calls });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan catches the shapes a writer used, and lets designated chats through', () => {
    for (const bad of [
      `await db.insert(agentJobs).values({ channel: 'cron', chatId: notifyChatId })`,
      `await tx.insert(agentJobs).values({ ...(resolvedChatId ? { chatId: resolvedChatId } : {}) })`,
      `await insertChildJob(db, { channel: 'internal', chatId: parent.chatId })`,
      `await startConversationTurn(tx, { start: { channel, chatId, task } })`,
    ]) {
      expect({ bad, caught: chatIdWrittenByHand(bad).length }).toEqual({ bad, caught: 1 });
    }
    for (const fine of [
      `await db.insert(agentJobs).values({ channel: 'cron', ...designateChat(id, 'telegram') })`,
      `await db.insert(agentJobs).values({ channel: 'cron', ...notifyChat })`,
      `await insertChildJob(db, { ...designateChat(input.chatId ?? parent.chatId, null) })`,
      `export async function insertChildJob(db, values) { return t.insert(agentJobs).values(values) }`,
    ]) {
      expect({ fine, caught: chatIdWrittenByHand(fine) }).toEqual({ fine, caught: [] });
    }
  });

  it('the inbox relaunch trigger copies the chat WITH its channel, in the migrations and the test schema', () => {
    const migrations = join(repoRoot, 'packages', 'db', 'migrations');
    const latest = readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        readFileSync(join(migrations, f), 'utf8').includes('FUNCTION agent_jobs_inbox_relaunch'),
      )
      .pop();
    const helpers = readFileSync(
      join(repoRoot, 'packages', 'db', 'src', 'tests', 'helpers.ts'),
      'utf8',
    );
    for (const [where, sql] of [
      [latest ?? '(none)', latest ? readFileSync(join(migrations, latest), 'utf8') : ''],
      ['packages/db/src/tests/helpers.ts', helpers],
    ] as const) {
      const inserts = [...sql.matchAll(/INSERT INTO agent_jobs\s*\(([^)]*)\)/g)].map(
        (m) => m[1] ?? '',
      );
      expect({ where, inserts: inserts.length > 0 }).toEqual({ where, inserts: true });
      for (const cols of inserts) {
        if (/\bchat_id\b/.test(cols)) {
          expect({ where, chatChannel: /\bchat_channel\b/.test(cols) }).toEqual({
            where,
            chatChannel: true,
          });
        }
      }
    }
  });
});
