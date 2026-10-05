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
import { executeTool } from '../execute';
import { MAX_SOURCE_BYTES } from '../shell-checklist';
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
        'powershell -NoProfile -ExecutionPolicy Bypass -File .\\setup.ps1',
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
