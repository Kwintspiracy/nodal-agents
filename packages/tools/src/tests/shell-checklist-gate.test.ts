// shell-checklist-gate.test.ts — the autonomy checklist at the approval gate (#464).
//
// Each case runs the REAL gate (`executeTool`) against the real database: the
// approval row and its reasons are read back, and a refusal is the text the
// model reads.

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { approvalRequests } from '@nodal-agents/db';
import { DEFAULT_SHELL_POLICY, type ShellPolicy } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
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

  it('inline code asks, and "never" refuses it', async () => {
    const code = `python -c "import shutil; shutil.rmtree('build')"`;

    const asked = await run(code, gate(DEFAULT_SHELL_POLICY));
    const refused = await run(code, gate({ ...DEFAULT_SHELL_POLICY, inline_code: 'never' }));

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
    // What migration 0125 gives an agent that had Yolo on everywhere.
    const migrated: ShellPolicy = {
      inline_code: 'allow',
      delete_files: 'allow',
      install_software: 'allow',
      download: 'allow',
      stop_programs: 'allow',
      system_settings: 'allow',
    };
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
