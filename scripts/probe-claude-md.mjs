#!/usr/bin/env node
// probe-claude-md.mjs — does a workspace's CLAUDE.md, read by Nodal and handed
// to `claude -p --setting-sources user` as text, still reach the model?
//
// ## Why this exists
//
// `--setting-sources user` (#782) stops Claude from loading the folder's
// CLAUDE.md files. Nodal now reads them itself (packages/tools/src/builtin/
// code-task/workspace-memory.ts) and writes them, wrapped as quoted project
// instructions, after the persona in `--append-system-prompt-file`. The unit
// tests prove WHAT is written; only a real model turn proves the model FOLLOWS
// it, and that a planted import to a file outside the folder carried nothing.
//
// ## What it does
//
// Builds a throwaway repository with a CLAUDE.md ("begin your answer with
// PINEAPPLE"), an `@` import inside the folder, a CLAUDE.local.md, and a
// secret outside the folder that the CLAUDE.md tries to import. It asks the
// REAL reader (through tsx) for the persona text, then runs real turns with the
// runtime turn's flags:
//
//   - 5 times "What is 2+2?" : the answer must begin with PINEAPPLE in at
//     least 4 of 5 (one LLM observation is not a measurement);
//   - once, "list the XXX-WORD tokens you can see": the imported word and the
//     local word must be present, the outside secret must not.
//
// Usage:
//   node scripts/probe-claude-md.mjs
//
// Exit 0 = the rules reach the model and nothing outside the folder does.
// Exit 1 = they do not (PINEAPPLE under 4/5, an imported word missing, or the
//          outside secret visible to the model).
// Exit 2 = could not tell (claude or tsx missing, not logged in, timeout).
//
// Costs six small model calls against the owner's subscription. Not run in CI
// (no model there): `pnpm test` covers the bytes, this covers the model.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TIMEOUT_MS = 240_000;
const REPS = 5;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// Same trick as buildSpawnArgv in the product: a .cmd path travels in an env
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
  console.error('Cannot tell: the `claude` CLI is not on PATH (or does not answer --version).');
  process.exit(2);
}
console.log(`Platform : ${process.platform}`);
console.log(`Claude   : ${version.split('\n')[0]}\n`);

const root = mkdtempSync(join(tmpdir(), 'claude-md-probe-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const repo = join(root, 'repo');
const put = (rel, content) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};
put('outside/secret.md', 'The outside secret word is OUTSIDE-WORD.\n');
put(
  'repo/CLAUDE.md',
  [
    'Project rules.',
    'ALWAYS begin your final answer with the single word PINEAPPLE.',
    'More rules: @docs/imported.md',
    'Also: @../outside/secret.md',
    '',
  ].join('\n'),
);
put('repo/docs/imported.md', 'The imported word is IMPORT-WORD.\n');
put('repo/CLAUDE.local.md', 'The local word is LOCAL-WORD.\n');

// The persona text comes from the REAL reader, not from a copy of its rules.
const helper = join(root, 'read.mts');
writeFileSync(
  helper,
  `import { readWorkspaceMemory } from ${JSON.stringify(
    pathToFileURL(
      join(repoRoot, 'packages', 'tools', 'src', 'builtin', 'code-task', 'workspace-memory.ts'),
    ).href,
  )};
const mem = await readWorkspaceMemory({ cwd: process.argv[2], roots: [process.argv[2]] });
process.stdout.write(mem ? mem.text : '');
`,
);
const read = spawnSync('pnpm', ['--filter', '@nodal-agents/runner', 'exec', 'tsx', helper, repo], {
  cwd: repoRoot,
  encoding: 'utf-8',
  shell: process.platform === 'win32',
  timeout: 120_000,
});
if (read.status !== 0 || !read.stdout.includes('PINEAPPLE')) {
  console.error(
    `Cannot tell: the reader did not run (tsx missing? run pnpm install).\n${(read.stderr ?? '').slice(0, 400)}`,
  );
  process.exit(2);
}
const persona = join(root, 'persona.txt');
writeFileSync(persona, `Your persona word is PERSONA-WORD.\n\n${read.stdout}`);

function turn(prompt) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--setting-sources',
    'user',
    '--append-system-prompt-file',
    persona,
    '--permission-mode',
    'acceptEdits',
  ];
  const run = callClaude(cli, args, {
    cwd: repo,
    input: prompt,
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of (run.stdout ?? '').split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'result' && typeof e.result === 'string') return e.result;
    } catch {
      /* not an event */
    }
  }
  return null;
}

let pineapple = 0;
for (let i = 0; i < REPS; i++) {
  const text = turn('What is 2+2? Answer in one short sentence.');
  if (text === null) {
    console.error('Cannot tell: a turn produced no result.');
    process.exit(2);
  }
  if (/^\W*PINEAPPLE/i.test(text)) pineapple++;
}
const listed = turn(
  'WITHOUT using any tool: list every token of the form XXX-WORD (capital letters, then -WORD) that appears in your system prompt or instructions. Answer on ONE line: WORDS=<comma list or NONE>.',
);
if (listed === null) {
  console.error('Cannot tell: the listing turn produced no result.');
  process.exit(2);
}

const has = (w) => listed.includes(w);
console.log(`PINEAPPLE first        : ${String(pineapple)}/${String(REPS)}`);
console.log(`imported word visible  : ${String(has('IMPORT-WORD'))}`);
console.log(`local word visible     : ${String(has('LOCAL-WORD'))}`);
console.log(`outside secret visible : ${String(has('OUTSIDE-WORD'))}`);
console.log(`listing                : ${listed.trim()}\n`);

if (has('OUTSIDE-WORD')) {
  console.error('NOT CONFINED: the model saw a file from outside the folder.');
  process.exit(1);
}
if (pineapple < 4 || !has('IMPORT-WORD') || !has('LOCAL-WORD')) {
  console.error('NOT DELIVERED: the project rules did not reach the model.');
  process.exit(1);
}
console.log('DELIVERED: the rules reach the model, and nothing outside the folder does.');
process.exit(0);
