// shell-checklist-gate.test.ts — the autonomy checklist at the approval gate (#464).
//
// Each case runs the REAL gate (`executeTool`) against the real database: the
// approval row and its reasons are read back, and a refusal is the text the
// model reads.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { approvalRequests } from '@nodal-agents/db';
import { DEFAULT_SHELL_POLICY, resolveShellPolicy, type ShellPolicy } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import { judgeShellChecklist, shellChecklistDeclined, type ShellPlace } from '../shell-checklist';
import { runCommandTool } from '../builtin/run-command';
import { codeTaskTool } from '../builtin/code-task';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
/** The agent's workspace, and a real folder that is not one (#614). */
let workspace: string;
let elsewhere: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'nodal-gate-ws-')));
  elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'nodal-gate-out-')));
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

const gate = (policy: ShellPolicy | undefined, rules: ApprovalRule[] = []): ExecuteOptions => ({
  approvalRules: rules,
  autonomy: 'destructive_gate',
  onApprovalRequired: async () => {},
  ...(policy ? { shellPolicy: policy } : {}),
});

const run = (command: string, opts: ExecuteOptions) =>
  executeTool(runCommand, { command, purpose: 'Tidy the project.' }, ctx(), opts);

/** An auto_approve rule on run_command: the Yolo toggle, or the runner's replay of an approved call. */
const yolo = (): ApprovalRule => ({
  id: 'yolo',
  toolName: 'run_command',
  action: 'auto_approve',
  agentId: null,
  entityId: seed.entityId,
});

/** What migration 0125 stored for an agent that had Yolo on everywhere: six kinds, before #667. */
const MIGRATED_0125 = {
  inline_code: 'allow',
  delete_files: 'allow',
  install_software: 'allow',
  download: 'allow',
  stop_programs: 'allow',
  system_settings: 'allow',
};

async function reasonsOf(approvalRequestId: string): Promise<unknown> {
  const [row] = await db
    .select({ gateReasons: approvalRequests.gateReasons })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId));
  return row?.gateReasons;
}

describe('the autonomy checklist at the gate (#464) @cap:executer-une-commande/moteur', () => {
  it('"ask" holds the command, with each kind of action and the command named', async () => {
    const command = 'pip install pandas && rm -rf build';

    const res = await run(command, gate(DEFAULT_SHELL_POLICY));

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      { category: 'install_software', state: 'ask', details: [command] },
      { category: 'delete_files', state: 'ask', details: [command] },
    ]);
  });

  // #581 : l'owner qui laisse un agent récupérer ses modèles sans demander ne
  // le laisse pas pour autant installer des logiciels.
  it('download allowed, install asked: a model or package download runs, an install is held (#581)', async () => {
    const policy: ShellPolicy = {
      ...DEFAULT_SHELL_POLICY,
      download: 'allow',
      install_software: 'ask',
    };
    for (const command of [
      'pip download torch -d wheels',
      'comfy --json model download --url "https://huggingface.co/x/y.safetensors" --relative-path models/checkpoints',
      'hf download black-forest-labs/FLUX.1-dev flux1-dev.safetensors --local-dir models/unet',
    ]) {
      const res = await run(command, gate(policy, [yolo()]));
      expect(res, command).toMatchObject({ outcome: 'success' });
      if (res.outcome === 'success') expect(res.output).toBe(`ran:${command}`);
    }

    const held = await run('pip install pandas', gate(policy, [yolo()]));
    expect(held.outcome).toBe('awaiting_approval');
    if (held.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(held.approvalRequestId)).toEqual([
      { category: 'install_software', state: 'ask', details: ['pip install pandas'] },
    ]);
  });

  it('"never" blocks, tells the agent what, and asks no one', async () => {
    const before = await db.select({ id: approvalRequests.id }).from(approvalRequests);

    const res = await run('rm -rf build', gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'never' }));

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain(
      'blocked: the owner does not allow this agent to delete files or discard work',
    );
    const after = await db.select({ id: approvalRequests.id }).from(approvalRequests);
    expect(after).toHaveLength(before.length);
  });

  it('an ordinary command runs as before', async () => {
    const res = await run('git status', gate(DEFAULT_SHELL_POLICY));

    expect(res.outcome).toBe('success');
  });

  // #614 : du code écrit dans la commande a le pouvoir d'un script que l'agent
  // écrit puis lance, qui n'a jamais demandé (décision de Quentin, 29/09). Un
  // état enregistré le retient toujours.
  it('inline code runs by default, a stored "ask" asks, and "never" refuses it', async () => {
    const code = `python -c "import shutil; shutil.rmtree('build')"`;

    const ran = await run(code, gate(DEFAULT_SHELL_POLICY));
    const asked = await run(code, gate({ ...DEFAULT_SHELL_POLICY, inline_code: 'ask' }));
    const refused = await run(code, gate({ ...DEFAULT_SHELL_POLICY, inline_code: 'never' }));

    expect(ran).toMatchObject({ outcome: 'success', output: `ran:${code}` });
    expect(asked.outcome).toBe('awaiting_approval');
    expect(refused.outcome).toBe('error');
    if (refused.outcome !== 'error') throw new Error('unreachable');
    expect(refused.error).toContain('run code written into a command');
  });

  it('what the owner allows runs: a deletion allowed for this agent is not asked', async () => {
    const allowed = await run(
      'rm -rf ./build',
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'allow' }),
    );
    const asked = await run('rm -rf ./build', gate(DEFAULT_SHELL_POLICY));

    expect(allowed.outcome).toBe('success');
    expect(asked.outcome).toBe('awaiting_approval');
  });

  it('a Yolo rule does not lift a "never": the list only hardens', async () => {
    const res = await run(
      'rm -rf build',
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'never' }, [yolo()]),
    );

    expect(res.outcome).toBe('error');
  });

  it('a Yolo agent as migration 0125 leaves it runs everything unasked', async () => {
    // What migration 0125 stored for an agent that had Yolo on everywhere,
    // read the way the runner reads it.
    const migrated = resolveShellPolicy(MIGRATED_0125);
    const res = await run(`node -e "console.log(1)" && rm -rf build`, gate(migrated, [yolo()]));

    expect(res.outcome).toBe('success');
  });

  it('without a checklist (a replay a human approved), the command is not judged again', async () => {
    const res = await run('rm -rf build', gate(undefined, [yolo()]));

    expect(res.outcome).toBe('success');
  });

  it('a declared proof is judged the same way: its commands will run unasked later', async () => {
    const declare: ToolDefinition<z.ZodTypeAny, string> = {
      name: 'declare_verification',
      description: 'declare how a project is proven',
      inputSchema: z.object({
        project_path: z.string(),
        commands: z.array(z.object({ command: z.string() })),
        purpose: z.string(),
      }),
      riskLevel: 'write',
      execute: async () => 'declared',
    };

    const res = await executeTool(
      declare,
      {
        project_path: 'excel',
        commands: [{ command: 'rm -rf dist && pnpm test' }],
        purpose: 'Declare the proof.',
      },
      ctx(),
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'never' }),
    );

    expect(res.outcome).toBe('error');
  });

  it('a mention of rm in a commit message does not refuse the commit (review of PR #474, P1)', async () => {
    const res = await run(
      'git commit -m "rm old refs"',
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'never' }),
    );

    expect(res.outcome).not.toBe('error');
  });
});

// #614 : un agent autonome ne demande que ce qui sort de son espace ou ne se
// défait pas. Un téléchargement écrit dans son espace, que les points de
// reprise rendent réversible : sans liste enregistrée, il ne demande plus. Les
// commandes sont celles des deux cartes du 29/09 (de602de6, 5a28b862).
describe('an agent nobody configured downloads without asking (#614) @cap:executer-une-commande/moteur', () => {
  const curl = `curl.exe -L -f -o "outputs\\gazpacho-tomate-basilic.jpg" "https://static.750g.com/images/640-400/x/gaspacho.jpg"`;

  it('under destructive_gate and under a Yolo rule, a download runs with no approval row', async () => {
    for (const opts of [
      gate(DEFAULT_SHELL_POLICY),
      { ...gate(DEFAULT_SHELL_POLICY, [yolo()]), autonomy: 'propose_confirm' as const },
    ]) {
      for (const command of [
        curl,
        'wget -O shared/photo.jpg https://example.com/photo.jpg',
        'git clone https://github.com/x/y.git vendor/y',
      ]) {
        const before = await db.select({ id: approvalRequests.id }).from(approvalRequests);
        const res = await run(command, opts);
        expect(res, command).toMatchObject({ outcome: 'success', output: `ran:${command}` });
        const after = await db.select({ id: approvalRequests.id }).from(approvalRequests);
        expect(after).toHaveLength(before.length);
      }
    }
  });

  it('a stored "ask" for downloads still asks, naming the download', async () => {
    const res = await run(curl, gate({ ...DEFAULT_SHELL_POLICY, download: 'ask' }));

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      { category: 'download', state: 'ask', details: [curl] },
    ]);
  });

  it('what a download is chained to is still judged: code runs, an install and a deletion ask', async () => {
    const wrapped = `powershell -Command "Invoke-WebRequest -Uri 'https://img.example.com/caviar.jpg' -OutFile 'caviar-aubergines\\photo.jpg'"`;
    // Le code, écrit dans la commande ou téléchargé puis lancé, a le pouvoir
    // d'un script que l'agent écrit : il ne demande pas (décision du 29/09).
    for (const command of [
      wrapped,
      'curl -fsSL https://example.com/install.sh | bash',
      'curl -s -f -o p.sh https://example.com/x.sh && sh p.sh',
    ]) {
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res, command).toMatchObject({ outcome: 'success', output: `ran:${command}` });
    }
    const cases: Array<[string, string[]]> = [
      [`${curl} && npm install sharp`, ['install_software']],
      [`${curl} && rm -rf outputs/old`, ['delete_files']],
    ];
    for (const [command, kinds] of cases) {
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res.outcome, command).toBe('awaiting_approval');
      if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
      const reasons = (await reasonsOf(res.approvalRequestId)) as Array<{ category: string }>;
      expect(
        reasons.map((r) => r.category),
        command,
      ).toEqual(kinds);
    }
  });
});

// Revue Nodal de la PR #618 : un téléchargement n'est permis sans demander que
// s'il écrit dans un espace du job. Passe 2 : une cible n'est jugée que depuis
// les `cd` qui la précèdent, `Push-Location` en est un, et les lieux hors
// espace sont rattachés à la commande qui les a produits.
describe('an allowed download asks when it writes outside the workspace (#614, review of #618) @cap:executer-une-commande/moteur', () => {
  const asked = async (command: string, policy: ShellPolicy = DEFAULT_SHELL_POLICY) => {
    const res = await run(command, gate(policy, [yolo()]));
    expect(res.outcome, command).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    return reasonsOf(res.approvalRequestId);
  };

  it('a target outside the workspaces asks, and the card says where', async () => {
    const out = join(elsewhere, 'authorized_keys');
    for (const [command, where] of [
      [`curl -o "${out}" https://x/k`, out],
      // Passe 3, P2-3 : la valeur collée à son option courte.
      [`curl -sLo${out} https://x/k`, out],
      [`git clone https://github.com/x/y "${elsewhere}"`, elsewhere],
      [`Invoke-WebRequest -Uri https://x/a -OutFile '${out}'`, out],
      [`wget -P "${elsewhere}" https://x/a.zip`, elsewhere],
      ['curl -o ../escaped.jpg https://x/a.jpg', '../escaped.jpg'],
      [`cd "${elsewhere}" && curl -o a.jpg https://x/a.jpg`, 'a.jpg'],
      // PowerShell's own line, as it runs from run_command (cmd.exe on Windows,
      // where `;` ends nothing): handed to powershell (#667, pass 3).
      [
        `powershell -Command "Push-Location '${elsewhere}'; iwr https://x/a -OutFile a.jpg"`,
        'a.jpg',
      ],
      ['curl -o $HOME/a https://x/a', 'a path decided when the command runs'],
    ] as const) {
      expect(await asked(command), command).toEqual([
        {
          category: 'download',
          state: 'ask',
          details: [command],
          outside: [{ command, places: [where] }],
        },
      ]);
    }
  });

  it('a target inside the workspace runs, absolute or relative, and a later cd does not move it', async () => {
    for (const command of [
      `curl -o "${join(workspace, 'a.jpg')}" https://x/a.jpg`,
      'curl -o outputs/a.jpg https://x/a.jpg',
      'cd outputs && curl -O https://x/a.jpg',
      'git clone https://github.com/x/y vendor/y',
      `curl -o a.jpg https://x/a.jpg && cd "${elsewhere}"`,
    ]) {
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res, command).toMatchObject({ outcome: 'success' });
    }
  });

  it('each place outside is attached to the command that writes there', async () => {
    const inside = 'curl -o outputs/a.jpg https://x/a.jpg';
    const outsideCmd = `curl -o "${join(elsewhere, 'b.jpg')}" https://x/b.jpg`;
    const declare: ToolDefinition<z.ZodTypeAny, string> = {
      name: 'declare_verification',
      description: 'declare how a project is proven',
      inputSchema: z.object({
        project_path: z.string(),
        commands: z.array(z.object({ command: z.string() })),
        purpose: z.string(),
      }),
      riskLevel: 'write',
      execute: async () => 'declared',
    };

    const res = await executeTool(
      declare,
      {
        project_path: '.',
        commands: [{ command: inside }, { command: outsideCmd }],
        purpose: 'Declare the proof.',
      },
      ctx(),
      gate(DEFAULT_SHELL_POLICY, [yolo()]),
    );

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [outsideCmd],
        outside: [{ command: outsideCmd, places: [join(elsewhere, 'b.jpg')] }],
      },
    ]);
  });

  // Passe 3, P2-1 : un lien PENDANT dans l'espace est suivi jusqu'à sa cible,
  // par le résolveur que la porte partage avec les outils de fichiers.
  it('a download through a dangling link is judged where the link points', async () => {
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    const out = `out-link-${Date.now()}`;
    const inn = `in-link-${Date.now()}`;
    try {
      await symlink(join(elsewhere, 'not-yet'), join(workspace, out), kind);
      await symlink(join(workspace, 'later'), join(workspace, inn), kind);
    } catch {
      return; // links cannot be made here; the resolver's own tests say so too
    }
    const outCmd = `curl -o ${out}/a.jpg https://x/a.jpg`;
    expect(await asked(outCmd)).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [outCmd],
        // The card names what the gate judged: the path as written, then
        // where the link leads (review of #618, minor).
        outside: [
          {
            command: outCmd,
            places: [`${out}/a.jpg → ${join(elsewhere, 'not-yet', 'a.jpg')}`],
          },
        ],
      },
    ]);
    const inCmd = `curl -o ${inn}/a.jpg https://x/a.jpg`;
    const res = await run(inCmd, gate(DEFAULT_SHELL_POLICY, [yolo()]));
    expect(res).toMatchObject({ outcome: 'success' });
  });

  it('a stored "never" for downloads blocks, inside the workspace too', async () => {
    const res = await run(
      'curl -o outputs/a.jpg https://x/a.jpg',
      gate({ ...DEFAULT_SHELL_POLICY, download: 'never' }, [yolo()]),
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('blocked: the owner does not allow this agent to download');
  });
});

// #669 (approbation 0330a0fc, 02/10) : un téléchargement qui n'écrivait que
// dans l'espace a interrogé la personne. Deux causes : `-o /dev/null` lu comme
// un emplacement, et un dossier de départ irrésolu (l'agent a plusieurs
// espaces, `cwd` absent) qui rendait tout chemin relatif « hors espace » — pour
// une commande qui, approuvée, échoue de toute façon sur ce même dossier.
describe('nowhere is not a place, and an unaddressed start never reaches a person (#669) @cap:executer-une-commande/moteur', () => {
  // The null sink of the host that runs the tests: the only name that is no place.
  const NOWHERE = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const commons =
    'curl -s "https://commons.wikimedia.org/w/api.php?action=query&format=json" -o commons.json && ' +
    `curl -s -o ${NOWHERE} -w "%{http_code}" -L "https://commons.wikimedia.org/wiki/File:x.jpg"`;
  let other: string;

  beforeAll(async () => {
    other = await realpath(await mkdtemp(join(tmpdir(), 'nodal-gate-other-')));
  });
  afterAll(async () => {
    await rm(other, { recursive: true, force: true });
  });

  /** The Researcher of 02/10: two workspaces of its own. */
  const twoWorkspaces = (): ToolContext => ({
    ...ctx(),
    workspaces: [
      { label: 'ws', path: workspace },
      { label: 'other', path: other },
    ],
  });
  const approvalCount = async () =>
    (await db.select({ id: approvalRequests.id }).from(approvalRequests)).length;

  it('the exact command of 02/10, from a resolved folder, runs with no approval row', async () => {
    for (const opts of [gate(DEFAULT_SHELL_POLICY), gate(DEFAULT_SHELL_POLICY, [yolo()])]) {
      const before = await approvalCount();
      const res = await executeTool(
        runCommand,
        { command: commons, purpose: 'Check the image.', cwd: 'ws' },
        twoWorkspaces(),
        opts,
      );
      expect(res).toMatchObject({ outcome: 'success', output: `ran:${commons}` });
      expect(await approvalCount()).toBe(before);
    }
  });

  it('a download sent to the null sink of the host asks no one, in any form', async () => {
    for (const command of [
      `curl -s -o ${NOWHERE} -w "%{http_code}" https://x/a`,
      `curl -s https://x/a > ${NOWHERE}`,
      `curl -s https://x/a 2>${NOWHERE}`,
      `curl -s https://x/a &>${NOWHERE}`,
      `curl -s -o commons.json https://x/a 2>${NOWHERE}`,
    ]) {
      const before = await approvalCount();
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res, command).toMatchObject({ outcome: 'success', output: `ran:${command}` });
      expect(await approvalCount(), command).toBe(before);
    }
  });

  it('a download really outside the workspace still asks, naming the place', async () => {
    const system = process.platform === 'win32' ? 'C:\\Windows\\x' : '/etc/x';
    const command = `curl -s -o ${system} https://x/a && curl -s -o ${NOWHERE} https://x/b`;

    const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [command],
        outside: [{ command, places: [system] }],
      },
    ]);
  });

  it('the card names the place as written: never a path the command did not write (#669)', async () => {
    // A rooted path with no drive (`/srv/x`, what a POSIX or Git-Bash command
    // writes) is judged on Windows as the current drive's `\srv\x`. The reason
    // shown to the person said `/srv/x → D:\rv/x`, a place nobody wrote.
    for (const named of [
      '/nodal-gate-void/a.jpg',
      '/dev/nodal-gate-void/a.jpg',
      '/c/nodal/x.jpg',
    ]) {
      const command = `curl -s -o ${named} -w "%{http_code}" https://x/a 2>${NOWHERE}`;
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res.outcome, named).toBe('awaiting_approval');
      if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
      expect(await reasonsOf(res.approvalRequestId), named).toEqual([
        {
          category: 'download',
          state: 'ask',
          details: [command],
          outside: [{ command, places: [named] }],
        },
      ]);
    }
  });

  it('the null sink in the line never hides the real place, in any form (#669)', async () => {
    const outside = join(elsewhere, 'x.bin');
    for (const command of [
      `curl -s -o ${outside} https://x/a 2>${NOWHERE}`,
      `curl -s https://x/a 2>${NOWHERE} > ${outside}`,
      `curl -s https://x/a &>${NOWHERE} > ${outside}`,
      `curl -s -o ${NOWHERE} https://x/b && curl -s -o ${outside} https://x/a`,
      `curl -s https://x/a 2>${NOWHERE}>${outside}`,
      `curl -s https://x/a 1<>${outside}`,
    ]) {
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res.outcome, command).toBe('awaiting_approval');
      if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
      expect(await reasonsOf(res.approvalRequestId), command).toEqual([
        {
          category: 'download',
          state: 'ask',
          details: [command],
          outside: [{ command, places: [outside] }],
        },
      ]);
    }
  });

  it('$null is a plain file name for the shell run_command uses, so it asks (#669)', async () => {
    // Where it is judged from decides: the cmd.exe of a Windows host names a file `$null`.
    for (const command of ['iwr https://x/a -OutFile $null', 'curl -s https://x/a > $null']) {
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res.outcome, command).toBe('awaiting_approval');
      if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
      expect(await reasonsOf(res.approvalRequestId), command).toEqual([
        {
          category: 'download',
          state: 'ask',
          details: [command],
          outside: [{ command, places: ['a path decided when the command runs'] }],
        },
      ]);
    }
  });

  it('a redirection inside a wrapper or after an escaped quote still asks (#669)', async () => {
    const commands = [
      "bash -c 'wget -O - https://x/a > ../outside.txt'",
      'curl -s -H "X-Name: O\\"Brien" https://x/a > ../outside.txt',
    ];
    for (const command of commands) {
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res.outcome, command).toBe('awaiting_approval');
      if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
      expect(await reasonsOf(res.approvalRequestId), command).toEqual([
        {
          category: 'download',
          state: 'ask',
          details: [command],
          outside: [{ command, places: ['../outside.txt'] }],
        },
      ]);
    }
  });

  it('every name that is not the null sink is a place, and asks, shown as written (#669)', async () => {
    // Codex, passes 1 and 2: devices and descriptor aliases lead where the line
    // and the host decide (`3<f 0<&3`, cmd.exe reading `/dev/zero` as `\dev\zero`).
    const commands: Array<[string, string]> = [
      ['curl -s -o /dev/zero https://x/a', '/dev/zero'],
      ['curl -s -o /dev/stdout https://x/a', '/dev/stdout'],
      ['curl -s -o /dev/fd/7 https://x/a', '/dev/fd/7'],
      ['curl -s https://x/a > /dev/tty', '/dev/tty'],
      [`curl -s -o /dev/stdin https://x/a < ${join(elsewhere, 'in.txt')}`, '/dev/stdin'],
      [`curl -s -o /dev/stdin https://x/a 3<${join(elsewhere, 'in.txt')} 0<&3`, '/dev/stdin'],
      [
        `exec < ${join(elsewhere, 'in.txt')}; cd sub && curl -s -o /dev/stdin https://x/a`,
        '/dev/stdin',
      ],
    ];
    for (const [command, place] of commands) {
      const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
      expect(res.outcome, command).toBe('awaiting_approval');
      if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
      expect(await reasonsOf(res.approvalRequestId), command).toEqual([
        {
          category: 'download',
          state: 'ask',
          details: [command],
          outside: [{ command, places: [place] }],
        },
      ]);
    }
  });

  it('a Windows device name is a device on Windows and a real file elsewhere (#669)', async () => {
    // From a folder outside the workspace, `nul` is the device only on Windows.
    const command = `cd ${elsewhere} && curl -s -o nul https://x/a`;
    const res = await run(command, gate(DEFAULT_SHELL_POLICY, [yolo()]));
    if (process.platform === 'win32') {
      expect(res).toMatchObject({ outcome: 'success' });
      return;
    }
    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [command],
        outside: [{ command, places: ['nul'] }],
      },
    ]);
  });

  it('the host the commands run on decides what a Windows device name is, on any machine running the tests (#669)', async () => {
    const root = resolve('/nodal-fake-ws');
    const placeOn = (host: ShellPlace['host']): ShellPlace => ({
      cwd: root,
      host,
      inWorkspace: async (p) => resolve(p).toLowerCase().startsWith(root.toLowerCase()),
      leadsTo: async () => null,
      // The command runs no script: nothing is read (#635).
      readSource: async () => ({ kind: 'unread', why: 'not_found' }),
    });
    const command = 'cd /nodal-fake-elsewhere && curl -s -o nul https://x/a';
    expect(await judgeShellChecklist([command], DEFAULT_SHELL_POLICY, placeOn('windows'))).toEqual(
      [],
    );
    expect(await judgeShellChecklist([command], DEFAULT_SHELL_POLICY, placeOn('posix'))).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [command],
        outside: [{ command, places: ['nul'] }],
      },
    ]);
  });

  it('run_command with no cwd and several workspaces: the agent is told, no one is asked', async () => {
    // The SHIPPED tool: its own refusal, not a fake's. Every posture that
    // would otherwise reach a person — the checklist (a "relative" download
    // outside), the safe-by-default approval of a plain command.
    for (const [command, opts] of [
      [commons, gate(DEFAULT_SHELL_POLICY)],
      [commons, gate(DEFAULT_SHELL_POLICY, [yolo()])],
      ['git status', { ...gate(undefined), autonomy: 'propose_confirm' as const }],
    ] as const) {
      const before = await approvalCount();
      const res = await executeTool(
        runCommandTool,
        { command, purpose: 'Check the image.' },
        twoWorkspaces(),
        opts,
      );
      expect(res.outcome, command).toBe('error');
      if (res.outcome !== 'error') throw new Error('unreachable');
      expect(res.error).toContain('This agent has multiple workspaces');
      expect(res.error).toContain('Valid labels: ws, other');
      expect(await approvalCount(), command).toBe(before);
    }
    // A cwd outside every workspace is just as impossible, whoever approves it.
    const before = await approvalCount();
    const outside = await executeTool(
      runCommandTool,
      { command: 'git status', purpose: 'Look.', cwd: elsewhere },
      ctx(),
      { ...gate(undefined), autonomy: 'propose_confirm' },
    );
    expect(outside).toMatchObject({ outcome: 'error' });
    if (outside.outcome === 'error') expect(outside.error).toContain('does not reside in any');
    expect(await approvalCount()).toBe(before);
  });

  it('code_task, the other tool with a starting folder, refuses the same way', async () => {
    const before = await approvalCount();
    const res = await executeTool(
      codeTaskTool,
      { purpose: 'Read the code.', provider: 'claude', task: 'Summarise.', mode: 'read' },
      twoWorkspaces(),
      { ...gate(undefined), autonomy: 'propose_confirm' },
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('This agent has multiple workspaces');
    expect(await approvalCount()).toBe(before);
  });
});

// #667 : prié d'imprimer, un agent qui tenait un outil d'impression demandant
// l'accord de la personne a imprimé par le shell (`Start-Process -Verb Print`),
// sans que personne soit consulté. Ce qui atteint l'écran, une imprimante ou
// quelqu'un est une sorte d'action à part, demandée par défaut ; un refus dit
// au modèle d'emprunter un outil qui demande, sans en nommer aucun.
describe('what reaches the screen, a printer or someone is asked (#667) @cap:executer-une-commande/moteur', () => {
  const reproduction = `powershell -NoProfile -Command "Start-Process -FilePath 'C:\\Users\\x\\shared\\outputs\\test-nodal.txt' -Verb Print -PassThru"`;
  const commands = [
    reproduction,
    'lp -d office report.pdf',
    'open -a Preview report.pdf',
    'xdg-open report.pdf',
    'cmd /c start "" report.pdf',
    'Get-Content report.txt | Out-Printer',
    'mail -s "Report" bob@example.com < body.txt',
  ];

  it('with the default policy, each is held for the person, under destructive_gate and under a Yolo rule', async () => {
    for (const opts of [gate(DEFAULT_SHELL_POLICY), gate(DEFAULT_SHELL_POLICY, [yolo()])]) {
      for (const command of commands) {
        const res = await run(command, opts);
        expect(res.outcome, command).toBe('awaiting_approval');
        if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
        const reasons = (await reasonsOf(res.approvalRequestId)) as Array<{ category: string }>;
        expect(
          reasons.find((r) => r.category === 'open_or_send'),
          command,
        ).toEqual({ category: 'open_or_send', state: 'ask', details: [command] });
      }
    }
  });

  it('an agent stored before #667, even with every kind allowed, is asked', async () => {
    const command = 'lp -d office report.pdf';

    const res = await run(command, gate(resolveShellPolicy(MIGRATED_0125), [yolo()]));

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      { category: 'open_or_send', state: 'ask', details: [command] },
    ]);
  });

  it('allowed by the owner, it runs; a background dev server is never held', async () => {
    const allowed = await run(
      'xdg-open report.pdf',
      gate({ ...DEFAULT_SHELL_POLICY, open_or_send: 'allow' }),
    );
    const server = 'Start-Process node -ArgumentList server.js -WindowStyle Hidden -PassThru';
    const background = await run(server, gate(DEFAULT_SHELL_POLICY, [yolo()]));

    expect(allowed).toMatchObject({ outcome: 'success', output: 'ran:xdg-open report.pdf' });
    expect(background).toMatchObject({ outcome: 'success', output: `ran:${server}` });
  });

  it('"never" refuses, asks no one, and points the agent to a tool that asks the person', async () => {
    const before = await db.select({ id: approvalRequests.id }).from(approvalRequests);

    const res = await run(reproduction, gate({ ...DEFAULT_SHELL_POLICY, open_or_send: 'never' }));

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toBe(
      "blocked: the owner does not allow this agent to open a program or a file on the person's " +
        'screen, print, or send a message through the shell. This is an intentional restriction ' +
        '— do NOT retry it and do NOT work around it via other commands, scripts or sub-agents. ' +
        'Instead, if one of your tools does this action and its description says it asks the ' +
        'person first, use that tool: the person decides there. Otherwise report the limitation ' +
        'in your result.',
    );
    const after = await db.select({ id: approvalRequests.id }).from(approvalRequests);
    expect(after).toHaveLength(before.length);
  });

  // Revue de la PR #682, passe 3 : `(`, `)`, `{`, `}` ouvrent une commande ;
  // `(xdg-open x)` n'est pas un programme nommé `(xdg-open`.
  // Passe 4 : un programme que le texte ne nomme pas demande, même quand le
  // code en ligne est permis (comme un téléchargement permis dont la cible est
  // décidée à l'exécution, #614) ; « never » sur le code en ligne le refuse.
  it('a program decided at run time asks under the default policy, and "never" on inline code refuses it', async () => {
    for (const command of ['$PYTHON script.py', '%COMSPEC% /c lpr report.pdf']) {
      for (const policy of [
        DEFAULT_SHELL_POLICY,
        { ...DEFAULT_SHELL_POLICY, inline_code: 'allow' as const },
      ]) {
        const res = await run(command, gate(policy, [yolo()]));
        expect(res.outcome, command).toBe('awaiting_approval');
        if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
        const reasons = (await reasonsOf(res.approvalRequestId)) as Array<{ category: string }>;
        expect(
          reasons.find((r) => r.category === 'inline_code'),
          command,
        ).toEqual({ category: 'inline_code', state: 'ask', details: [command] });
      }
      const refused = await run(command, gate({ ...DEFAULT_SHELL_POLICY, inline_code: 'never' }));
      expect(refused.outcome, command).toBe('error');
    }
    // a named program still runs unasked under the default policy
    const named = await run('python script.py', gate(DEFAULT_SHELL_POLICY, [yolo()]));
    expect(named).toMatchObject({ outcome: 'success', output: 'ran:python script.py' });
  });

  it('"never" refuses what a group or a block starts, glued or spaced', async () => {
    for (const command of [
      'bash -c "(xdg-open report.pdf)"',
      'bash -c "{ lpr report.pdf; }"',
      'powershell -Command "(Start-Process report.pdf -Verb Print)"',
    ]) {
      const res = await run(command, gate({ ...DEFAULT_SHELL_POLICY, open_or_send: 'never' }));
      expect(res.outcome, command).toBe('error');
      if (res.outcome !== 'error') throw new Error('unreachable');
      expect(res.error, command).toContain("open a program or a file on the person's screen");
    }
  });

  // La même issue pour toute sorte : la règle est générale, pas taillée pour l'impression.
  it('every kind refused says the same remedy, never naming a tool', async () => {
    const res = await run('rm -rf build', gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'never' }));

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain(
      'if one of your tools does this action and its description says it asks the person first, use that tool',
    );
  });

  it('after a decline, the model reads which kinds held the command and the same remedy', () => {
    expect(
      shellChecklistDeclined([
        { category: 'open_or_send', state: 'ask', details: ['lp report.pdf'] },
        { category: 'delete_files', state: 'ask', details: ['lp report.pdf'] },
      ]),
    ).toBe(
      "The shell checklist held this command because it would open a program or a file on the person's " +
        'screen, print, or send a message; delete files or discard work. Do not run it through the shell ' +
        "again. Unless the person's reason rules the action out: if one of your tools does this action " +
        'and its description says it asks the person first, use that tool: the person decides there.',
    );
  });
});
