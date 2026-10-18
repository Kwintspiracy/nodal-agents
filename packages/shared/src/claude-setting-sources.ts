// claude-setting-sources.ts — which settings layers a Nodal-launched `claude -p`
// may load. Written once, for the two argv that launch Claude headless: the
// runtime agent turn (apps/runner/src/cli-runtime/claude-turn.ts) and the
// `code_task` Claude provider (packages/tools/src/builtin/code-task/providers.ts).
//
// ## Why only `user`
//
// A turn runs with its cwd inside a WORKSPACE: a folder that confined commands,
// and the agent itself, can write. Claude Code reads `.claude/settings.json` and
// `.claude/settings.local.json` from that folder, and their HOOKS are shell
// commands it runs on the host, outside the sandbox, in print mode with no
// confirmation. Measured on claude 2.1.301 (PR #753, 2026-10-16): a project
// `SessionStart` and a `UserPromptSubmit` hook both ran, no trust prompt. A
// command that writes that file ran host code at the next CLI turn there.
//
// `--setting-sources user` loads the owner's OWN settings and nothing from the
// folder the CLI runs in. Measured the same way (scripts/probe-claude-setting-
// sources.mjs, claude 2.1.301): no project or local hook runs, and the project's
// permission rules, CLAUDE.md, skills, agents and commands are not loaded
// either — they ride the same switch. What stays: the owner's user skills,
// agents, plugins and hooks, `--add-dir` folders, the persona file.
//
// No fallback (invariant #4): a claude that does not know the flag exits with
// `error: unknown option '--setting-sources'` and the turn fails with that text.
// Dropping the flag to make an old CLI work would silently re-open the hole.

export const CLAUDE_SETTING_SOURCES = 'user';

/** The argv fragment every headless Claude launch carries. */
export function claudeSettingSourcesFlags(): string[] {
  return ['--setting-sources', CLAUDE_SETTING_SOURCES];
}
