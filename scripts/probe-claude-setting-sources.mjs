#!/usr/bin/env node
// probe-claude-setting-sources.mjs — does `claude -p --setting-sources user`
// actually stop the CLI from loading a WORKSPACE's own configuration, on THIS
// machine, with THIS version of claude?
//
// ## Why this exists
//
// Nodal launches the Claude Code CLI (a runtime agent's turn, `code_task`) with
// its cwd inside a workspace — a folder that confined commands, or the agent
// itself, can write. `.claude/settings.json` in that folder carries HOOKS, and a
// hook is a shell command the CLI runs ON THE HOST, outside the sandbox, with no
// confirmation in print mode. Measured 2026-10-16 (PR #753): claude 2.1.301 ran a
// project `SessionStart` and `UserPromptSubmit` hook, no trust prompt. A command
// that writes that file therefore runs host code at the next CLI turn.
//
// The fix is one flag, `--setting-sources user` (packages/shared/src/claude-
// setting-sources.ts: the only place it is written). That is a claim about
// somebody else's tool, which changes without telling us, and a unit test on our
// argv proves only that we ASK. This probe proves the CLI OBEYS.
//
// ## What it does
//
// Builds a throwaway workspace holding every kind of project-level input the CLI
// knows, then runs a REAL turn twice with the argv a runtime turn uses, once
// without the flag and once with it, and reports for each item whether it was
// loaded. No version parsing, no inference from `--help`.
//
// Usage:
//   node scripts/probe-claude-setting-sources.mjs
//
// Exit 0 = the flag holds: no project hook ran, and the project settings, memory,
//          skills, agents and commands are absent, while the user's own remain.
// Exit 1 = it does not hold on something that executes code (a hook ran).
// Exit 2 = could not tell (claude missing, not logged in, the control run showed
//          nothing loaded either, timeout).
//
// Costs two small model calls against the owner's subscription. Not run in CI
// (no model there): `pnpm test` covers the argv, this covers the CLI.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 240_000;
// Written in the clear on purpose: the same literal is what a runtime turn
// passes. packages/shared owns the real one; the probe must run from a bare
// checkout, so it repeats it and the unit test pins both to the same string.
const SETTING_SOURCES_ARGS = ['--setting-sources', 'user'];

function resolveClaude() {
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? '';
  const names =
    process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) {
        const ext = extname(full).toLowerCase();
        return { path: full, isBatch: ext === '.cmd' || ext === '.bat' };
      }
    }
  }
  return null;
}

// Same trick as buildSpawnArgv in the product: the .cmd path travels in an env
// var, never in argv, because Node re-quotes argv for cmd.exe.
const SHIM_ENV = 'NODAL_PROBE_CLAUDE';

function callClaude(cli, args, opts = {}) {
  const useShim = process.platform === 'win32' && cli.isBatch;
  const argv = useShim
    ? ['cmd.exe', '/d', '/v:off', '/s', '/c', `%${SHIM_ENV}%`, ...args]
    : [cli.path, ...args];
  const env = useShim ? { ...process.env, [SHIM_ENV]: `"${cli.path}"` } : process.env;
  return spawnSync(argv[0], argv.slice(1), { encoding: 'utf-8', env, ...opts });
}

const cli = resolveClaude();
const version = cli
  ? (callClaude(cli, ['--version'], { timeout: 20_000 }).stdout ?? '').trim()
  : '';
if (!cli || version === '') {
  console.error(
    'Cannot tell: the `claude` CLI is not on PATH (or does not answer --version).\n' +
      '  Install it and sign in first.',
  );
  process.exit(2);
}
console.log(`Platform : ${process.platform}`);
console.log(`Claude   : ${version.split('\n')[0]}\n`);

const root = mkdtempSync(join(tmpdir(), 'claude-setting-sources-probe-'));
const WORD = 'PROJECT-WORD-7731';
const PERSONA_WORD = 'PERSONA-WORD-4402';

/** A fresh workspace holding one of every project-level input, and its markers. */
function buildWorkspace(name) {
  const ws = join(root, name, 'workspace');
  const extra = join(root, name, 'extra');
  const markers = join(root, name, 'markers');
  for (const d of [join(ws, '.claude', 'skills', 'probe-skill'), join(ws, '.claude', 'agents')]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(join(ws, '.claude', 'commands'), { recursive: true });
  mkdirSync(extra, { recursive: true });
  mkdirSync(markers, { recursive: true });
  const hook = (file) => ({
    hooks: [
      {
        type: 'command',
        // One node, no shell syntax: runs the same under cmd.exe, sh and bash.
        command: `node -e "require('fs').appendFileSync(process.argv[1], Date.now()+'\\n')" "${join(markers, file).replace(/\\/g, '/')}"`,
      },
    ],
  });
  writeFileSync(
    join(ws, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [hook('project-session-start')],
        UserPromptSubmit: [hook('project-prompt')],
      },
      permissions: { allow: ['Bash(node -p 40+2)'], deny: ['Read(./secret.txt)'] },
    }),
  );
  writeFileSync(
    join(ws, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: { SessionStart: [hook('local-session-start')] } }),
  );
  writeFileSync(join(ws, 'CLAUDE.md'), `The project secret word is ${WORD}.\n`);
  writeFileSync(
    join(ws, '.claude', 'skills', 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: probe\n---\nprobe\n',
  );
  writeFileSync(
    join(ws, '.claude', 'agents', 'probe-agent.md'),
    '---\nname: probe-agent\ndescription: probe\n---\nprobe\n',
  );
  writeFileSync(join(ws, '.claude', 'commands', 'probe-cmd.md'), 'probe\n');
  // An MCP server that leaves a marker if the CLI ever starts it.
  writeFileSync(
    join(ws, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'probe-mcp': {
          command: 'node',
          args: [
            '-e',
            `require('fs').appendFileSync(${JSON.stringify(join(markers, 'mcp-started'))},'x');setInterval(()=>{},1000)`,
          ],
        },
      },
    }),
  );
  writeFileSync(join(ws, 'secret.txt'), 'secret-content\n');
  writeFileSync(join(extra, 'note.txt'), 'extra-dir-content\n');
  const persona = join(root, name, 'persona.md');
  writeFileSync(persona, `Your persona word is ${PERSONA_WORD}.\n`);
  return { ws, extra, markers, persona };
}

const PROMPT = (extra) =>
  [
    'Do these in order, then answer. Do not guess any value.',
    '1. Run the bash command: node -p 40+2',
    '2. Read the file ./secret.txt',
    `3. Read the file ${join(extra, 'note.txt').replace(/\\/g, '/')}`,
    'Final answer: ONE line, exactly: WORD=<the project secret word from your instructions, or NONE>; PERSONA=<your persona word, or NONE>',
  ].join('\n');

function markerCount(markers, name) {
  const p = join(markers, name);
  return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0;
}

function runTurn(label, withFlag) {
  const { ws, extra, markers, persona } = buildWorkspace(label);
  // The argv of claude-turn.ts's buildClaudeTurnArgs, write mode.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    ...(withFlag ? SETTING_SOURCES_ARGS : []),
    '--append-system-prompt-file',
    persona,
    '--add-dir',
    extra,
    '--permission-mode',
    'acceptEdits',
  ];
  const run = callClaude(cli, args, {
    cwd: ws,
    input: PROMPT(extra),
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const events = (run.stdout ?? '')
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null;
  const result = events.find((e) => e.type === 'result') ?? null;
  const toolUses = new Map();
  const toolResults = new Map();
  for (const e of events) {
    for (const b of e.message?.content ?? []) {
      if (b.type === 'tool_use') toolUses.set(b.id, b);
      if (b.type === 'tool_result') toolResults.set(b.tool_use_id, b);
    }
  }
  const outcome = (pred) => {
    for (const [id, use] of toolUses) {
      if (!pred(use)) continue;
      const res = toolResults.get(id);
      if (!res) return 'no-result';
      const text = JSON.stringify(res.content ?? '');
      return res.is_error ? `DENIED (${text.slice(0, 80)})` : 'ok';
    }
    return 'not-attempted';
  };
  const text = typeof result?.result === 'string' ? result.result : '';
  const names = (v) =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.name)) : [];
  return {
    label,
    ok: init !== null && result !== null,
    stderr: (run.stderr ?? '').slice(0, 400),
    hookProject:
      markerCount(markers, 'project-session-start') + markerCount(markers, 'project-prompt'),
    hookLocal: markerCount(markers, 'local-session-start'),
    mcpStarted: markerCount(markers, 'mcp-started'),
    skills: names(init?.skills),
    agents: names(init?.agents),
    commands: names(init?.slash_commands),
    mcpServers: names(init?.mcp_servers),
    bashAllowRule: outcome((u) => u.name === 'Bash'),
    readDenyRule: outcome(
      (u) => u.name === 'Read' && String(u.input?.file_path ?? '').includes('secret.txt'),
    ),
    addDirRead: outcome(
      (u) => u.name === 'Read' && String(u.input?.file_path ?? '').includes('note.txt'),
    ),
    word: text.includes(WORD),
    persona: text.includes(PERSONA_WORD),
    text,
  };
}

// process.exit() skips `finally`; the exit hook always runs.
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

{
  const before = runTurn('before', false);
  const after = runTurn('after', true);
  for (const r of [before, after]) {
    if (!r.ok) {
      console.error(`Cannot tell: the "${r.label}" run produced no init/result.\n${r.stderr}`);
      process.exit(2);
    }
  }
  const row = (item, get) => {
    console.log(`${item.padEnd(34)} ${String(get(before)).padEnd(40)} ${get(after)}`);
  };
  console.log(`${'item'.padEnd(34)} ${'without the flag'.padEnd(40)} with --setting-sources user`);
  row('project hooks run (settings.json)', (r) => r.hookProject);
  row('local hooks run (settings.local)', (r) => r.hookLocal);
  row('project .mcp.json server started', (r) => r.mcpStarted);
  row('project skill listed', (r) => r.skills.includes('probe-skill'));
  row('project agent listed', (r) => r.agents.includes('probe-agent'));
  row('project command listed', (r) => r.commands.includes('probe-cmd'));
  row('project CLAUDE.md read', (r) => r.word);
  row('project allow rule (Bash node -p)', (r) => r.bashAllowRule);
  row('project deny rule (Read secret)', (r) => r.readDenyRule);
  row('--add-dir folder readable', (r) => r.addDirRead);
  row('persona file honoured', (r) => r.persona);
  row(
    'user skills still listed',
    (r) => r.skills.filter((s) => !s.includes(':') && s !== 'probe-skill').length,
  );
  row('plugin skills still listed', (r) => r.skills.filter((s) => s.includes(':')).length);
  row('user agents still listed', (r) => r.agents.filter((a) => a !== 'probe-agent').length);
  console.log('');

  // The control must show the inputs loaded, or "nothing loaded" proves nothing.
  if (before.hookProject === 0) {
    console.error('Cannot tell: the control run (no flag) ran no project hook either.');
    process.exit(2);
  }
  if (after.hookProject > 0 || after.hookLocal > 0) {
    console.error('NOT CONFINED: a project/local hook ran with --setting-sources user.');
    process.exit(1);
  }
  console.log('CONFINED: no project or local hook ran with --setting-sources user.');
  process.exit(0);
}
