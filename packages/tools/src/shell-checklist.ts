// shell-checklist.ts — judging a shell command against the agent's checklist (#464).
//
// The kinds of action read from the command text alone come from
// `staticShellCategories` (packages/shared). This module adds the two that need
// context, and that the 23/09 run crossed without anyone being asked:
//
//   - `outside_folders`: a path the command names that lies outside every
//     folder attached to the agent (shared included). Decided by the SAME
//     resolver the file tools use (`resolveAndCheckPath`: symlinks, not-yet-
//     existing files, Windows path shapes), so "outside" means here exactly
//     what it means for `file_read`. Attaching folders is now a boundary for
//     the shell too, not only for the file tools.
//   - `own_script`: a script file this agent wrote in THIS job (`file_write` /
//     `file_edit`), then runs. Inline code (`python -c`) is the same thing and
//     is already named by `staticShellCategories`.
//
// What it returns is FACTS: one reason per kind of action whose state is
// `ask` or `never`, with the paths or the script that made it so. The caller
// (`executeTool`) turns them into a block or an approval, and stores them on
// the approval so the card can show them.

import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { stat } from 'node:fs/promises';
import { agentJobs, toolCalls, and, eq, inArray } from '@nodal-agents/db';
import {
  pathWords,
  scriptFilesRun,
  staticShellCategories,
  type ShellCategory,
  type ShellGateReason,
  type ShellPolicy,
} from '@nodal-agents/shared';
import type { ToolContext } from './types';
import { resolveAndCheckPath } from './builtin/file-ops/workspace';

/** The tools whose writes count as "a script it wrote itself". */
const WRITING_TOOLS = ['file_write', 'file_edit'];

const HOME_PREFIX = /^(~|%userprofile%|%homepath%|\$home|\$\{home\}|\$env:userprofile)(?=[\\/]|$)/i;

/** Where a path word points, before the folder check. */
function absoluteOf(raw: string, kind: 'absolute' | 'home' | 'relative', cwd: string): string {
  if (kind === 'home') return resolvePath(homedir(), '.' + raw.replace(HOME_PREFIX, ''));
  if (kind === 'relative' || !isAbsolute(raw)) return resolvePath(cwd, raw);
  return raw;
}

/** Is `abs` inside one of the agent's folders? The file tools' own answer. */
async function insideFolders(ctx: ToolContext, abs: string): Promise<boolean> {
  try {
    await resolveAndCheckPath(ctx, abs);
    return true;
  } catch {
    // Outside every folder — or nothing to compare with (no folder at all,
    // a folder that no longer exists). Either way the path is not one the
    // agent was given: asking is the safe reading.
    return false;
  }
}

/** A path as the file tools see it, for comparing a script with a written file. */
async function canonical(ctx: ToolContext, p: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await resolveAndCheckPath(ctx, p);
  } catch {
    resolved = resolvePath(p);
  }
  const unified = resolved.replace(/\\/g, '/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * Did this audit row record a write that happened? `executeTool` stores the
 * tool's own output on success, and a `{ outcome: 'error' | 'awaiting_approval' }`
 * result otherwise — the same rows the conversation screen reads.
 */
function wasWritten(toolOutput: string | null): boolean {
  if (toolOutput === null) return false;
  try {
    const parsed = JSON.parse(toolOutput) as { outcome?: unknown } | null;
    return !(
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed.outcome === 'error' || parsed.outcome === 'awaiting_approval')
    );
  } catch {
    // Not JSON: a tool returning plain text succeeded (errors are always JSON).
    return true;
  }
}

/** When this job began: a script changed after it was written during the run. */
async function jobStartedAt(ctx: ToolContext): Promise<Date> {
  const [row] = await ctx.db
    .select({ createdAt: agentJobs.createdAt })
    .from(agentJobs)
    .where(eq(agentJobs.id, ctx.jobId))
    .limit(1);
  // No row (a caller without a real job): every script counts as older, and
  // only the file tools' own record decides.
  return row?.createdAt ?? new Date(8.64e15);
}

/**
 * A script written DURING this run by any means, not only the file tools: a
 * shell command (`printf … > build.py`) leaves no file_write row (Codex review
 * of #464, P1). Changed since the job began, or not there yet — then only this
 * very command can be about to create it (`printf … > x.py && python x.py`).
 */
async function changedDuringJob(abs: string, jobStart: Date): Promise<boolean> {
  try {
    const info = await stat(abs);
    return info.mtimeMs >= jobStart.getTime();
  } catch {
    return true;
  }
}

/** The files this agent wrote in this job, as the file tools resolved them. */
async function filesWrittenThisJob(ctx: ToolContext): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ toolInput: toolCalls.toolInput, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, ctx.jobId), inArray(toolCalls.toolName, WRITING_TOOLS)));
  const written = new Set<string>();
  for (const row of rows) {
    // Only a write that HAPPENED: a refused or failed one (no match for the
    // edit, invalid input, held for approval) left the file as it was, and a
    // script already there is not the agent's (Codex review of #464, P2).
    if (!wasWritten(row.toolOutput)) continue;
    const path = (row.toolInput as { path?: unknown } | null)?.path;
    if (typeof path === 'string' && path !== '') written.add(await canonical(ctx, path));
  }
  return written;
}

/**
 * Judge `commands` (the ones this call will run) against `policy`. `cwd` is
 * where they run: relative paths and scripts are read from there.
 */
export async function judgeShellChecklist(
  commands: readonly string[],
  ctx: ToolContext,
  policy: ShellPolicy,
  cwd: string,
): Promise<ShellGateReason[]> {
  const details = new Map<ShellCategory, string[]>();
  const hit = (category: ShellCategory, detail?: string): void => {
    if (policy[category] === 'allow') return;
    const list = details.get(category) ?? [];
    if (detail !== undefined && !list.includes(detail)) list.push(detail);
    details.set(category, list);
  };

  let written: Set<string> | null = null;
  let jobStart: Date | null = null;
  for (const command of commands) {
    for (const category of staticShellCategories(command)) hit(category);

    if (policy.outside_folders !== 'allow') {
      for (const word of pathWords(command, process.platform)) {
        // A path the shell builds by expansion leads where nobody checked.
        if (word.kind === 'unresolved') {
          hit('outside_folders', word.raw);
          continue;
        }
        const abs = absoluteOf(word.raw, word.kind, cwd);
        if (!(await insideFolders(ctx, abs))) hit('outside_folders', word.raw);
      }
    }

    if (policy.own_script !== 'allow') {
      const scripts = scriptFilesRun(command);
      if (scripts.length > 0) {
        written ??= await filesWrittenThisJob(ctx);
        jobStart ??= await jobStartedAt(ctx);
        for (const script of scripts) {
          const abs = isAbsolute(script) ? script : resolvePath(cwd, script);
          if (written.has(await canonical(ctx, abs)) || (await changedDuringJob(abs, jobStart))) {
            hit('own_script', script);
          }
        }
      }
    }
  }

  const reasons: ShellGateReason[] = [];
  for (const [category, list] of details) {
    const state = policy[category];
    if (state === 'allow') continue;
    reasons.push({ category, state, details: list });
  }
  return reasons;
}

/** How the model reads each kind of action in a refusal (never shown to a person). */
const CATEGORY_FOR_MODEL: Record<ShellCategory, string> = {
  outside_folders: 'read or change files outside its folders',
  own_script: 'run code it wrote itself',
  delete_files: 'delete files or discard work',
  install_software: 'install software or packages',
  download: 'download from the internet',
  stop_programs: 'stop other programs or services',
  system_settings: 'change system settings, permissions or disks',
};

/**
 * The refusal the MODEL reads when a kind of action is set to "never".
 * Prescriptive, like the rule refusal: what is forbidden, on what, and that it
 * is intentional — otherwise the model retries or works around it.
 */
export function shellChecklistRefusal(never: readonly ShellGateReason[]): string {
  const what = never
    .map((r) => {
      const kind = CATEGORY_FOR_MODEL[r.category];
      return r.details.length > 0 ? `${kind} (${r.details.join(', ')})` : kind;
    })
    .join('; ');
  return (
    `blocked: the owner does not allow this agent to ${what}. This is an intentional ` +
    `restriction — do NOT retry it and do NOT work around it via other commands, tools or ` +
    `sub-agents. Work inside your folders with your allowed tools, or report the limitation ` +
    `in your result.`
  );
}
