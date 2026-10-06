// script-content-gate.test.ts — a command that runs a script is judged by the
// script (#635).
//
// Run 074e7161 (bench #634): an agent wrote a Python script that pip-installs
// openpyxl and ran it with `python …`. The checklist read `python <file>` and
// never asked about installing software. Each case here runs the REAL gate
// (`executeTool`) on real files in a real workspace, against the real
// database: the approval row and its reasons are read back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { approvalRequests } from '@nodal-agents/db';
import { DEFAULT_SHELL_POLICY, type ShellPolicy } from '@nodal-agents/shared';
import { executeTool, isCatastrophicCall } from '../execute';
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_DEPTH,
  MAX_JUDGED_COMMANDS,
  MAX_SOURCE_FILES,
  MAX_SOURCE_TOTAL_BYTES,
} from '../shell-checklist';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let workspace: string;
let elsewhere: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'nodal-script-ws-')));
  elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'nodal-script-out-')));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: workspace }],
  };
}

const runCommand: ToolDefinition<z.ZodObject<{ command: z.ZodString }>, string> = {
  name: 'run_command',
  description: 'run a shell command',
  inputSchema: z.object({ command: z.string(), purpose: z.string(), cwd: z.string().optional() }),
  riskLevel: 'write',
  defaultApproval: 'require_approval',
  execute: async (input: { command: string }) => `ran:${input.command}`,
};

const gate = (policy: ShellPolicy, rules: ApprovalRule[] = []): ExecuteOptions => ({
  approvalRules: rules,
  autonomy: 'destructive_gate',
  onApprovalRequired: async () => {},
  shellPolicy: policy,
});

/** An auto_approve rule on run_command: the Yolo toggle. */
const yolo = (): ApprovalRule => ({
  id: 'yolo',
  toolName: 'run_command',
  action: 'auto_approve',
  agentId: null,
  entityId: seed.entityId,
});

/**
 * The folder separator of the host the tests run on: `run_command` hands its
 * line to cmd on Windows (a backslash separates folders) and to sh elsewhere
 * (a backslash escapes), and the gate reads the line as that shell will.
 */
const HOST_SEP = process.platform === 'win32' ? String.fromCharCode(92) : '/';

const run = (command: string, opts: ExecuteOptions) =>
  executeTool(runCommand, { command, purpose: 'Build the sheet.' }, ctx(), opts);

/** Write `content` at `path` under the workspace (or at an absolute path). */
async function put(path: string, content: string | Buffer): Promise<string> {
  const full =
    path.startsWith(workspace) || path.startsWith(elsewhere) ? path : join(workspace, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

async function reasonsOf(approvalRequestId: string): Promise<unknown> {
  const [row] = await db
    .select({ gateReasons: approvalRequests.gateReasons })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId));
  return row?.gateReasons;
}

async function asked(command: string, policy: ShellPolicy = DEFAULT_SHELL_POLICY) {
  const res = await run(command, gate(policy, [yolo()]));
  expect(res.outcome, command).toBe('awaiting_approval');
  if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
  return reasonsOf(res.approvalRequestId);
}

/** The command runs, and no approval row was written for it. */
async function ranUnasked(command: string, policy: ShellPolicy = DEFAULT_SHELL_POLICY) {
  const before = await db.select({ id: approvalRequests.id }).from(approvalRequests);
  const res = await run(command, gate(policy, [yolo()]));
  expect(res, command).toMatchObject({ outcome: 'success', output: `ran:${command}` });
  const after = await db.select({ id: approvalRequests.id }).from(approvalRequests);
  expect(after, command).toHaveLength(before.length);
}

const TICKET_SCRIPT = [
  'import subprocess, sys',
  'try:',
  '    import openpyxl',
  'except ImportError:',
  '    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl"])',
  'wb = openpyxl.Workbook()',
  'wb.save("ventes.xlsx")',
].join('\n');

describe('a command that runs a script is judged by the script (#635) @cap:executer-une-commande/moteur', () => {
  it('the run of the ticket: a Python script that pip-installs asks for installing software', async () => {
    await put('shared/scripts/_temp_create_ventes_bench.py', TICKET_SCRIPT);
    const command = 'python shared/scripts/_temp_create_ventes_bench.py';

    expect(await asked(command)).toEqual([
      {
        category: 'install_software',
        state: 'ask',
        details: [command],
        found: [
          {
            source: 'shared/scripts/_temp_create_ventes_bench.py',
            line: 5,
            text: 'subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl"])',
          },
        ],
      },
    ]);
  });

  // The channel card (Telegram, Discord…) is built from what the gate hands
  // the notifier: the reasons travel with it, so the card says what was read.
  it('the notifier receives what the gate read, the same as the row', async () => {
    await put('scripts/notify.py', TICKET_SCRIPT);
    const command = 'python scripts/notify.py';
    const handed: unknown[] = [];

    const res = await run(command, {
      ...gate(DEFAULT_SHELL_POLICY, [yolo()]),
      onApprovalRequired: async (req) => {
        handed.push(req.gateReasons);
      },
    });

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(handed).toEqual([await reasonsOf(res.approvalRequestId)]);
    expect(handed[0]).toEqual([
      expect.objectContaining({
        category: 'install_software',
        found: [expect.objectContaining({ source: 'scripts/notify.py', line: 5 })],
      }),
    ]);
  });

  it('"never" refuses the script, tells the agent what, and asks no one', async () => {
    await put('scripts/setup.py', TICKET_SCRIPT);
    const before = await db.select({ id: approvalRequests.id }).from(approvalRequests);

    const res = await run(
      'python scripts/setup.py',
      gate({ ...DEFAULT_SHELL_POLICY, install_software: 'never' }, [yolo()]),
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain(
      'blocked: the owner does not allow this agent to install software or packages',
    );
    const after = await db.select({ id: approvalRequests.id }).from(approvalRequests);
    expect(after).toHaveLength(before.length);
  });

  it('every interpreter and every way of running a file, on every OS', async () => {
    const cases: Array<
      [file: string, content: string, command: string, kind: string, line: number]
    > = [
      [
        'tools/build.mjs',
        "import { execSync } from 'node:child_process';\nexecSync('npm i sharp');",
        'node tools/build.mjs',
        'install_software',
        2,
      ],
      [
        'tools/gen.ts',
        '// generate\nawait $`npm install zod`;',
        'tsx tools/gen.ts',
        'install_software',
        2,
      ],
      [
        'tools/add.ts',
        "Bun.spawn(['pnpm', 'add', 'zod']);",
        'bun run tools/add.ts',
        'install_software',
        1,
      ],
      ['clean.sh', '#!/bin/sh\nset -e\nrm -rf dist', 'bash clean.sh', 'delete_files', 3],
      [
        'run',
        '#!/usr/bin/env python3\nimport os\nos.system("taskkill /F /IM excel.exe")',
        './run',
        'stop_programs',
        3,
      ],
      [
        'setup.ps1',
        "Write-Host 'go'\nSet-Acl -Path C:\\data -AclObject $acl",
        // A backslash is a folder separator where cmd reads the line (Windows),
        // an escape where sh does: the path is written for the host.
        `powershell -NoProfile -ExecutionPolicy Bypass -File .${HOST_SEP}setup.ps1`,
        'system_settings',
        2,
      ],
      [
        'setup.bat',
        '@echo off\r\n@pip install openpyxl\r\n',
        'cmd /c setup.bat',
        'install_software',
        2,
      ],
      ['deps.bat', '@echo off\r\ncall npm ci\r\n', 'deps.bat', 'install_software', 2],
      ['tool.rb', 'system("gem install rails")', 'ruby tool.rb', 'install_software', 1],
      [
        'tool.php',
        '<?php\nshell_exec("composer install && rm -rf vendor/x");',
        'php tool.php',
        'delete_files',
        2,
      ],
      ['tool.pl', 'my $x = 1;\n`kill -9 1234`;', 'perl tool.pl', 'stop_programs', 2],
    ];
    for (const [file, content, command, kind, line] of cases) {
      await put(file, content);
      const reasons = (await asked(command)) as Array<Record<string, unknown>>;
      expect(reasons, command).toEqual([
        expect.objectContaining({
          category: kind,
          state: 'ask',
          details: [command],
          found: [expect.objectContaining({ line })],
        }),
      ]);
    }
  });

  it('the code written into a command is read the same way', async () => {
    const command = `python -c "import os; os.system('pip install openpyxl')"`;

    const reasons = (await asked(command)) as Array<Record<string, unknown>>;

    // inline_code itself stays allowed by default (#614); the install asks.
    expect(reasons).toEqual([
      {
        category: 'install_software',
        state: 'ask',
        details: [command],
        found: [{ source: null, line: 1, text: "import os; os.system('pip install openpyxl')" }],
      },
    ]);
  });

  it('a script run by a script is read too, and named where it is', async () => {
    await put('ci/all.sh', '#!/bin/bash\necho start\npython ci/inner.py\n');
    await put('ci/inner.py', 'import os\nos.system("npm install left-pad")\n');

    expect(await asked('bash ci/all.sh')).toEqual([
      {
        category: 'install_software',
        state: 'ask',
        details: ['bash ci/all.sh'],
        found: [{ source: 'ci/inner.py', line: 2, text: 'os.system("npm install left-pad")' }],
      },
    ]);
  });

  it('a script that only reads and writes its own files runs unasked', async () => {
    await put(
      'report.py',
      [
        'import csv, json',
        '# subprocess.run(["pip", "install", "openpyxl"])  (not needed any more)',
        "rows = list(csv.reader(open('data/ventes.csv', encoding='utf-8')))",
        'print(f"{len(rows)} rows, install complete")',
        "json.dump(rows, open('out/ventes.json', 'w'))",
      ].join('\n'),
    );
    await put('build.sh', '#!/bin/sh\n# rm -rf dist\nnode report.js > out.txt\n');
    await put(
      'report.js',
      "const fs = require('fs');\nconsole.log(fs.readFileSync('a.txt', 'utf8'));\n",
    );

    await ranUnasked('python report.py');
    await ranUnasked('sh build.sh');
  });

  it('a binary run directly is a program like any other: judged by its name', async () => {
    await put('bin/tool', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1, 2, 3]));

    await ranUnasked('./bin/tool --run', { ...DEFAULT_SHELL_POLICY, inline_code: 'ask' });
  });

  it('a download in a script runs inside the workspace, and asks when the script sends it outside', async () => {
    await put('fetch-in.sh', 'mkdir -p img\ncd img\ncurl -o a.jpg https://x/a.jpg\n');
    await put('fetch-out.sh', `cd "${elsewhere}"\ncurl -o a.jpg https://x/a.jpg\n`);
    await put('fetch-var.py', 'import subprocess\nsubprocess.run(["git", "clone", url, dest])\n');

    await ranUnasked('sh fetch-in.sh');
    expect(await asked('sh fetch-out.sh')).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: ['sh fetch-out.sh'],
        outside: [{ command: 'sh fetch-out.sh', places: ['a.jpg'] }],
        found: [{ source: 'fetch-out.sh', line: 2, text: 'curl -o a.jpg https://x/a.jpg' }],
      },
    ]);
    // A target held in a variable is decided when the script runs: it asks.
    expect(await asked('python fetch-var.py')).toEqual([
      expect.objectContaining({
        category: 'download',
        outside: [
          { command: 'python fetch-var.py', places: ['a path decided when the command runs'] },
        ],
      }),
    ]);
  });
});

// A script the gate cannot read is code nobody read ahead: the kind
// `inline_code` names, under its state. Allowed by default (the owner's
// decision of 29/09, #618: a script downloaded then run in the same line does
// not ask); asked or refused when the owner set it so, the card naming the
// file and why.
describe('a script that cannot be read is code nobody read ahead (#635) @cap:executer-une-commande/moteur', () => {
  const askCode: ShellPolicy = { ...DEFAULT_SHELL_POLICY, inline_code: 'ask' };

  it('outside the workspaces, missing, too large, or named at run time: asked under "ask", and why', async () => {
    const outside = await put(join(elsewhere, 'x.py'), 'print(1)');
    await put('big.py', `x = "${'a'.repeat(MAX_SOURCE_BYTES)}"`);
    const cases: Array<[string, string, string]> = [
      [`python "${outside}"`, outside, 'outside_workspaces'],
      ['python missing.py', 'missing.py', 'not_found'],
      ['python big.py', 'big.py', 'too_large'],
      ['python scripts', 'scripts', 'not_a_file'],
      ['python $SCRIPT', 'python $SCRIPT', 'decided_at_run_time'],
    ];
    await mkdir(join(workspace, 'scripts'), { recursive: true });
    for (const [command, source, why] of cases) {
      expect(await asked(command, askCode), command).toEqual([
        { category: 'inline_code', state: 'ask', details: [command], unread: [{ source, why }] },
      ]);
    }
  });

  it('by default it runs, like a script downloaded then run in the same line', async () => {
    await ranUnasked('python missing.py');
    await ranUnasked('curl -s -f -o p.sh https://example.com/x.sh && sh p.sh');
  });

  // A script whose path the text does not say cannot be named ahead, like a
  // program decided at run time (#667): it asks even when inline code is
  // allowed, as `$c x` does.
  it('a script path decided at run time asks even by default', async () => {
    expect(await asked('python $SCRIPT')).toEqual([
      {
        category: 'inline_code',
        state: 'ask',
        details: ['python $SCRIPT'],
        unread: [{ source: 'python $SCRIPT', why: 'decided_at_run_time' }],
      },
    ]);
  });

  it('"never" refuses it', async () => {
    const res = await run(
      'python missing.py',
      gate({ ...DEFAULT_SHELL_POLICY, inline_code: 'never' }, [yolo()]),
    );
    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('run code written into a command');
  });

  it('a bare name not in the folder is a program from the PATH, not a missing script', async () => {
    await ranUnasked('deploy.bat --dry-run', askCode);
  });
});

// Review pass 1 of PR #683 (Nodal, Reviewer A): four ways the code a command
// runs went unjudged.
describe('review pass 1 of #683: no source a command runs goes unjudged @cap:executer-une-commande/moteur', () => {
  const NL = String.fromCharCode(10);
  const askCode: ShellPolicy = { ...DEFAULT_SHELL_POLICY, inline_code: 'ask' };

  // P1 : un fichier donné à un interpréteur est une SOURCE. Un octet NUL ne
  // le rend pas « programme » : il se lit comme du texte, et s'il ne se lit
  // pas comme du texte, il est illisible (jamais sauté en silence).
  it('P1: a source with a NUL byte is still read; one that is not text is unread', async () => {
    await put(
      'nulbyte/setup.js',
      `//${String.fromCharCode(0)}${NL}require('child_process').execSync('npm install left-pad');${NL}`,
    );
    expect(await asked('node nulbyte/setup.js')).toEqual([
      {
        category: 'install_software',
        state: 'ask',
        details: ['node nulbyte/setup.js'],
        found: [
          {
            source: 'nulbyte/setup.js',
            line: 2,
            text: "require('child_process').execSync('npm install left-pad');",
          },
        ],
      },
    ]);
    await put('nulbyte/bad.py', Buffer.from([0x70, 0x69, 0x70, 0x80, 0x81, 0xfe, 0x0a]));
    expect(await asked('python nulbyte/bad.py', askCode)).toEqual([
      {
        category: 'inline_code',
        state: 'ask',
        details: ['python nulbyte/bad.py'],
        unread: [{ source: 'nulbyte/bad.py', why: 'not_text' }],
      },
    ]);
  });

  // P2 : une chaîne se lit comme le langage la lit, échappements compris.
  it('P2: string escapes are decoded as the language decodes them', async () => {
    // The files hold each escape as the language writes it: a backslash, then
    // the code (built from BS so the test source carries no escape of its own).
    const BS = String.fromCharCode(92);
    await put('esc/setup.py', `import os${NL}os.system("pip${BS}x20install openpyxl")${NL}`);
    await put(
      'esc/setup.js',
      `require('child_process').execSync('npm${BS}u0020install sharp');${NL}`,
    );
    for (const [command, line] of [
      ['python esc/setup.py', 2],
      ['node esc/setup.js', 1],
    ] as const) {
      expect(await asked(command), command).toEqual([
        expect.objectContaining({
          category: 'install_software',
          found: [expect.objectContaining({ line })],
        }),
      ]);
    }
  });

  // P2 : une construction de contrôle sur une ligne (`if …; then …; fi`) lance
  // la commande qui suit le mot-clé.
  it('P2: the command inside a one-line control construct is judged', async () => {
    await put('ctl/setup.sh', 'if true; then pip install openpyxl; fi\n');
    await put('ctl/setup.bat', '@if exist req.txt (pip install -r req.txt)\r\n');
    await put('ctl/setup.ps1', 'if ($true) { Stop-Process -Name excel }\n');
    for (const [command, kind] of [
      ['bash ctl/setup.sh', 'install_software'],
      ['cmd /c ctl/setup.bat', 'install_software'],
      ['powershell -File ctl/setup.ps1', 'stop_programs'],
    ] as const) {
      expect(await asked(command), command).toEqual([
        expect.objectContaining({ category: kind, found: [expect.objectContaining({ line: 1 })] }),
      ]);
    }
  });

  // P2 : la lecture est bornée (nombre de fichiers, octets, profondeur) ; ce
  // qui dépasse est illisible, donc sous inline_code, jamais lâché en silence.
  it('P2: past the reading budget, the rest is unread, never dropped', async () => {
    const many = Array.from({ length: MAX_SOURCE_FILES + 5 }, (_, i) => `b/s${i}.py`);
    for (const f of many) await put(f, 'print(1)\n');
    await put('b/run.py', many.map((f) => `subprocess.run(["python", "${f}"])`).join('\n') + '\n');
    const files = (await asked('python b/run.py', askCode)) as Array<{
      unread?: Array<{ why: string }>;
    }>;
    expect(files[0]?.unread?.map((u) => u.why)).toContain('over_budget');

    const big = 'x = 1\n'.repeat(Math.floor((MAX_SOURCE_BYTES - 1024) / 6));
    const count = Math.ceil(MAX_SOURCE_TOTAL_BYTES / big.length) + 1;
    const bigs = Array.from({ length: count }, (_, i) => `big/s${i}.py`);
    for (const f of bigs) await put(f, big);
    await put('big/run.sh', bigs.map((f) => `python ${f}`).join('\n') + '\n');
    const bytes = (await asked('sh big/run.sh', askCode)) as Array<{
      unread?: Array<{ why: string }>;
    }>;
    expect(bytes[0]?.unread?.map((u) => u.why)).toContain('over_budget');

    // Deeper than MAX_SOURCE_DEPTH: the next script is not read, and says so.
    const chain = Array.from({ length: MAX_SOURCE_DEPTH + 2 }, (_, i) => `deep/d${i}.sh`);
    for (const [i, f] of chain.entries())
      await put(f, i + 1 < chain.length ? `sh ${chain[i + 1]}\n` : 'echo end\n');
    expect(await asked(`sh ${chain[0]}`, askCode)).toEqual([
      expect.objectContaining({
        category: 'inline_code',
        unread: [{ source: chain[MAX_SOURCE_DEPTH], why: 'over_budget' }],
      }),
    ]);

    // More commands than are kept to judge: the rest of the file is unread.
    await put(
      'long/run.sh',
      Array(MAX_JUDGED_COMMANDS + 10)
        .fill('echo x')
        .join(NL) + NL,
    );
    expect(await asked('sh long/run.sh', askCode)).toEqual([
      expect.objectContaining({
        category: 'inline_code',
        unread: [{ source: 'long/run.sh', why: 'over_budget' }],
      }),
    ]);

    // Under the default policy it runs, as any code nobody read ahead.
    await ranUnasked('python b/run.py');
  });
});

// Review pass 2 of PR #683 (Nodal, Reviewer A).
describe('review pass 2 of #683: a script the system runs is source, and every shell construct is read @cap:executer-une-commande/moteur', () => {
  const askCode: ShellPolicy = { ...DEFAULT_SHELL_POLICY, inline_code: 'ask' };
  const NL = String.fromCharCode(10);
  const CRLF = String.fromCharCode(13, 10);
  const NUL = String.fromCharCode(0);

  // C1 : un NUL ne fait pas d'un script un programme. Seul un exécutable (ELF,
  // PE, Mach-O, par ses octets de tête) en est un.
  it('C1: a script run directly that holds a NUL is still read', async () => {
    await put('c1/deploy.bat', `::${NUL}${CRLF}pip install openpyxl${CRLF}`);
    await put('c1/after.bat', `pip install openpyxl${CRLF}rem ${NUL}${CRLF}`);
    await put('c1/deploy.sh', `#!/bin/sh${NL}pip install openpyxl${NL}# ${NUL}${NL}`);
    for (const command of [
      'c1/deploy.bat',
      `.${HOST_SEP}c1${HOST_SEP}deploy.bat`,
      'call c1/deploy.bat',
      'c1/after.bat',
      './c1/deploy.sh',
    ]) {
      expect(await asked(command), command).toEqual([
        expect.objectContaining({
          category: 'install_software',
          found: [expect.objectContaining({ line: 2 - (command.includes('after') ? 1 : 0) })],
        }),
      ]);
    }
  });

  it('C1: an executable (ELF, PE, Mach-O) is a program; bytes that are neither text nor one are unread', async () => {
    await put('c1/tool.elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x70, 0x69, 0x70]));
    await put('c1/tool.pe', Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 0x70, 0x69, 0x70]));
    await put('c1/tool.macho', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1, 0x70]));
    for (const command of ['./c1/tool.elf', './c1/tool.pe', './c1/tool.macho']) {
      await ranUnasked(command, askCode);
    }
    await put('c1/blob', Buffer.from([0x70, 0x69, 0x70, 0x80, 0x81, 0xfe, 0x0a]));
    expect(await asked('./c1/blob', askCode)).toEqual([
      {
        category: 'inline_code',
        state: 'ask',
        details: ['./c1/blob'],
        unread: [{ source: './c1/blob', why: 'not_text' }],
      },
    ]);
  });

  // C2 : une commande peut commencer à chaque position que la grammaire du
  // shell lui ouvre, pas seulement après une liste de mots-clés.
  it('C2: case, select, functions, switch, try and trap blocks are read, in sh and PowerShell', async () => {
    const cases: Array<[string, string, string]> = [
      ['c2/case.sh', `case $x in *) pip install openpyxl ;; esac${NL}`, 'bash c2/case.sh'],
      ['c2/select.sh', `select p in a b; do pip install $p; done${NL}`, 'bash c2/select.sh'],
      ['c2/func.sh', `function f { pip install x; }${NL}f${NL}`, 'bash c2/func.sh'],
      ['c2/func2.sh', `f() { pip install x; }${NL}f${NL}`, 'bash c2/func2.sh'],
      [
        'c2/switch.ps1',
        `switch ($x) { 1 { Stop-Process -Name excel } }${NL}`,
        'pwsh -File c2/switch.ps1',
      ],
      [
        'c2/function.ps1',
        `function F { Stop-Process -Name excel }${NL}`,
        'pwsh -File c2/function.ps1',
      ],
      ['c2/filter.ps1', `filter F { Stop-Process -Name excel }${NL}`, 'pwsh -File c2/filter.ps1'],
      ['c2/try.ps1', `try { Stop-Process -Name excel } catch { }${NL}`, 'pwsh -File c2/try.ps1'],
      ['c2/trap.ps1', `trap { Stop-Process -Name excel }${NL}`, 'pwsh -File c2/trap.ps1'],
      ['c2/else.bat', `if exist a (echo a) else (pip install x)${CRLF}`, 'cmd /c c2/else.bat'],
    ];
    for (const [file, content, command] of cases) {
      await put(file, content);
      const reasons = (await asked(command)) as Array<{ category: string }>;
      expect(
        reasons.map((r) => r.category),
        command,
      ).toEqual([file.endsWith('.ps1') ? 'stop_programs' : 'install_software']);
    }
  });
});

// Before review pass 3 of #683: cmd conditions and here-docs, at the gate.
describe('cmd conditions and here-docs at the gate (#683) @cap:executer-une-commande/moteur', () => {
  const askCode: ShellPolicy = { ...DEFAULT_SHELL_POLICY, inline_code: 'ask' };
  const NL = String.fromCharCode(10);
  const CRLF = String.fromCharCode(13, 10);

  it('a cmd script with if, without brackets, is read', async () => {
    await put('hd/setup.bat', `@echo off${CRLF}if not exist venv pip install -r req.txt${CRLF}`);
    expect(await asked('cmd /c hd/setup.bat')).toEqual([
      expect.objectContaining({
        category: 'install_software',
        found: [expect.objectContaining({ source: 'hd/setup.bat', line: 2 })],
      }),
    ]);
  });

  it('a here-doc in a script is read in the language of the program it feeds, at its line', async () => {
    await put(
      'hd/run.sh',
      [
        '#!/bin/sh',
        'cat <<EOF > notes.txt',
        'rm -rf build',
        'EOF',
        "python3 - <<'PY'",
        'import subprocess, sys',
        'subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl"])',
        'PY',
        '',
      ].join(NL),
    );
    // The body fed to cat is data, as sh reads it; the one fed to python is
    // read as Python, which only Python finds an install in.
    expect(await asked('sh hd/run.sh')).toEqual([
      expect.objectContaining({
        category: 'install_software',
        found: [
          {
            source: 'hd/run.sh',
            line: 7,
            text: 'subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl"])',
          },
        ],
      }),
    ]);
  });

  it('a here-doc and a here-string in the command itself, and a file on standard input', async () => {
    expect(await asked(`bash <<EOF${NL}pip install x${NL}EOF`)).toEqual([
      expect.objectContaining({ category: 'install_software' }),
    ]);
    expect(await asked('bash <<< "pip install x"')).toEqual([
      expect.objectContaining({ category: 'install_software' }),
    ]);
    await put('hd/stdin.txt', `pip install x${CRLF}`);
    expect(await asked('cmd < hd/stdin.txt')).toEqual([
      expect.objectContaining({
        category: 'install_software',
        found: [expect.objectContaining({ source: 'hd/stdin.txt', line: 1 })],
      }),
    ]);
    // A file on standard input that is not there yet is unread, like any script.
    expect(await asked('cmd < hd/missing.txt', askCode)).toEqual([
      expect.objectContaining({
        category: 'inline_code',
        unread: [{ source: 'hd/missing.txt', why: 'not_found' }],
      }),
    ]);
  });
});

// Review pass 3 of #683.
describe('review pass 3 of #683: no line dropped, and the hard floor reads the code too @cap:executer-une-commande/moteur', () => {
  const NL = String.fromCharCode(10);
  const allAllowed: ShellPolicy = {
    inline_code: 'allow',
    delete_files: 'allow',
    install_software: 'allow',
    download: 'allow',
    stop_programs: 'allow',
    system_settings: 'allow',
    open_or_send: 'allow',
  } as ShellPolicy;

  // Passe 5 : le corps d'un here-doc n'est pas de la grammaire de script.
  it('pass 5: an apostrophe in a body does not hide the next here-document', async () => {
    await put(
      'p5/run.sh',
      [
        'cat <<END > notes.txt',
        "Don't panic",
        'END',
        "python3 - <<'PY'",
        'subprocess.check_call([sys.executable, "-m", "pip", "install", "evil"])',
        'PY',
        '',
      ].join(NL),
    );
    expect(await asked('sh p5/run.sh')).toEqual([
      expect.objectContaining({
        category: 'install_software',
        found: [expect.objectContaining({ source: 'p5/run.sh', line: 5 })],
      }),
    ]);
  });

  // Passe 4 : `#` après `)` est un commentaire pour sh, `(( ))` est de
  // l'arithmétique : aucun faux here-doc n'avale les lignes suivantes.
  it('C2 (pass 4): a comment after ) and (( )) arithmetic open no here-document', async () => {
    await put(
      'p4/case.sh',
      ['case $v in', 'x)#<<END', 'pip install openpyxl', 'rm -rf build', 'END', ';;', 'esac'].join(
        NL,
      ),
    );
    await put('p4/arith.sh', ['((x<<END))', 'pip install openpyxl', 'END'].join(NL));
    for (const [command, kinds] of [
      ['sh p4/case.sh', ['delete_files', 'install_software']],
      ['bash p4/arith.sh', ['install_software']],
    ] as const) {
      const reasons = (await asked(command)) as Array<{ category: string }>;
      expect(reasons.map((r) => r.category).sort(), command).toEqual(kinds);
    }
    // In the command itself too.
    const typed = ['((x<<END))', 'pip install openpyxl', 'END'].join(NL);
    expect(((await asked(typed)) as Array<{ category: string }>).map((r) => r.category)).toContain(
      'install_software',
    );
  });

  // P2 (pass 4): without a checklist, destructive_gate still sees a body
  // fed to a shell, as main did.
  it('P2 (pass 4): destructive_gate holds a here-document fed to a shell', async () => {
    const cmd = `bash <<EOF${NL}Stop-Process -Name excel${NL}EOF`;
    const res = await run(cmd, {
      approvalRules: [],
      autonomy: 'destructive_gate',
      onApprovalRequired: async () => {},
    });
    expect(res.outcome).toBe('awaiting_approval');
  });

  // C2 : un `<<` cité ou commenté n'ouvre aucun here-doc.
  it('C2: a quoted << opens no here-document, and the lines after it are judged', async () => {
    await put(
      'p3/build.sh',
      ['echo "usage: <<END"', 'pip install openpyxl', 'END', 'rm -rf build'].join(NL),
    );
    const reasons = (await asked('sh p3/build.sh')) as Array<{ category: string }>;
    expect(reasons.map((r) => r.category).sort()).toEqual(['delete_files', 'install_software']);
  });

  // C3 : le plancher lit le code lancé. Même tout permis et sous Yolo, la porte
  // retient, et le runner refusera même approuvé.
  it('C3: a machine-wide destroyer in a script reaches the floor, typed or not', async () => {
    const cases: Array<[string, string, string]> = [
      ['p3/reboot.py', 'import os' + NL + 'os.system("reboot")' + NL, 'python p3/reboot.py'],
      ['p3/down.py', 'import os' + NL + 'os.system("shutdown /s /t 0")' + NL, 'python p3/down.py'],
      ['p3/wipe.py', 'import os' + NL + 'os.system("rm -rf /")' + NL, 'python p3/wipe.py'],
    ];
    for (const [file, content, command] of cases) {
      await put(file, content);
      const res = await run(command, gate(allAllowed, [yolo()]));
      expect(res.outcome, command).toBe('awaiting_approval');
      expect(await isCatastrophicCall('run_command', { command }, ctx()), command).toBe(true);
    }
    // A fork bomb fed to bash in a here-document (in the command, not in a
    // file: an antivirus may refuse to open a file that holds one).
    const bomb = `bash <<EOF${NL}:(){ :|:& };:${NL}EOF`;
    expect((await run(bomb, gate(allAllowed, [yolo()]))).outcome).toBe('awaiting_approval');
    expect(await isCatastrophicCall('run_command', { command: bomb }, ctx())).toBe(true);
  });

  it('C3: a string that only mentions a destroyer is no command', async () => {
    await put('p3/msg.py', 'print("Please reboot your machine, then shutdown the old one")' + NL);
    await ranUnasked('python p3/msg.py', allAllowed);
    expect(await isCatastrophicCall('run_command', { command: 'python p3/msg.py' }, ctx())).toBe(
      false,
    );
  });
});
