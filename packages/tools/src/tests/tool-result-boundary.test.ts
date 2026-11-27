// tool-result-boundary.test.ts — what a tool returns is masked once, at the seam, for every tool.
//
// `executeTool` is the one place where a tool's result becomes both what the
// runner hands the model and the `tool_calls` row. These cases run the REAL
// seam on a real database, with the workspace's secrets stored as Nodal stores
// them, and assert the value returned (what the model will read) and the row
// (what every store keeps): the same text, without the registered value nor
// the shaped one, for a file read, a shell command, a skill script, a
// connector's structured result, an MCP server's text and its error. Then the
// two rules around it: a held call runs with its real input, and a masked
// read is never written back. Values are assembled at run time.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  approvalRequests,
  connectors,
  encryptChannelSecret as encrypt,
  eq,
  toolCalls,
} from '@nodal-agents/db';
// The one encryption Nodal stores secrets with, through the package that owns it.
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeAlnum, fakeSecret } from '@nodal-agents/test-kit';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import { ToolFailedWithOutput } from '../errors';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';
import { autonomousRows } from './autonomy-rows-fixture';

const registry = createToolRegistry();
registerBuiltins(registry);
const builtin = (name: string) => registry.get(name) as ToolDefinition<z.ZodTypeAny, unknown>;

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let dir = '';
let skillStore = '';
/** A value with no credential shape: stored as a connector key, known only to the registry. */
let registered = '';
/** A value with a credential's shape, known to no store. */
let shaped = '';

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  registered = randomBytes(20).toString('hex');
  shaped = fakeSecret('github', fakeAlnum(36));
  await db
    .insert(connectors)
    .values({ entityId: seed.entityId, name: 'Acme', slug: 'acme', apiKey: encrypt(registered) });
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-boundary-')));
  await writeFile(
    join(dir, 'settings.env'),
    ['NAME=demo', `ACME_KEY=${registered}`, `GH_TOKEN=${shaped}`, 'PORT=8080', ''].join('\n'),
  );
  skillStore = await mkdtemp(join(tmpdir(), 'nodal-boundary-skills-'));
  await mkdir(join(skillStore, 'demo', 'scripts'), { recursive: true });
  await writeFile(
    join(skillStore, 'demo', 'scripts', 'print.js'),
    'console.log(process.argv.slice(2).join(" "));\n',
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await rm(skillStore, { recursive: true, force: true }).catch(() => {});
});

const rules = (extra: string[] = []): ApprovalRule[] => autonomousRows(seed, extra);
const opts = (extra: string[] = []): ExecuteOptions => ({
  approvalRules: rules(extra),
  onApprovalRequired: async () => {},
});

async function freshJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'boundary' })
    .returning();
  return job!.id;
}

async function ctx(over: Partial<ToolContext> = {}): Promise<ToolContext> {
  return {
    db: db as unknown as ToolContext['db'],
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: await freshJob(),
    jobChatId: null,
    workspaces: [{ label: 'ws', path: dir }],
    skillStoreDir: skillStore,
    assignedSkillSlugs: ['demo'],
    scriptAuthorizedSkillSlugs: ['demo'],
    turn: 1,
    ...over,
  } as ToolContext;
}

/** The rows of the job, oldest first. */
async function rowsOf(jobId: string) {
  return db.select().from(toolCalls).where(eq(toolCalls.jobId, jobId)).orderBy(toolCalls.seq);
}

/** The value handed on and the row both hold neither secret, and the same text. */
async function expectMaskedEverywhere(
  res: Awaited<ReturnType<typeof executeTool>>,
  jobId: string,
): Promise<void> {
  const handed = JSON.stringify(res);
  expect(handed, 'the registered value reaches the model').not.toContain(registered);
  expect(handed, 'the shaped value reaches the model').not.toContain(shaped);
  expect(handed).toContain(REDACTED_TEXT);
  const rows = await rowsOf(jobId);
  const row = rows.at(-1)!;
  expect(row.toolOutput, 'the registered value is stored').not.toContain(registered);
  expect(row.toolOutput, 'the shaped value is stored').not.toContain(shaped);
  expect(row.resultMasked).toBe(true);
  if (res.outcome === 'success') {
    // Same text to the model and to the store.
    expect(JSON.parse(row.toolOutput!)).toEqual(res.output);
  }
}

describe('every tool result is masked at the seam, the same text to the model and the store @cap:connecter-un-service/moteur', () => {
  it('a file read', async () => {
    const c = await ctx();
    const res = await executeTool(
      builtin('file_read'),
      { path: 'settings.env', purpose: 'Read the settings.' },
      c,
      opts(),
    );
    expect(res.outcome).toBe('success');
    await expectMaskedEverywhere(res, c.jobId);
    // Ordinary lines reach the model as they are.
    expect(JSON.stringify(res)).toContain('PORT=8080');
  });

  it('a shell command’s output', async () => {
    const c = await ctx();
    const res = await executeTool(
      builtin('run_command'),
      {
        purpose: 'Print the settings.',
        command: `node -e "process.stdout.write(require('fs').readFileSync('settings.env','utf8'))"`,
      },
      c,
      opts(),
    );
    expect(res.outcome, JSON.stringify(res)).toBe('success');
    await expectMaskedEverywhere(res, c.jobId);
  });

  it('a skill script’s output', async () => {
    const c = await ctx();
    const res = await executeTool(
      builtin('run_skill_script'),
      {
        purpose: 'Run the script.',
        skill: 'demo',
        script: 'scripts/print.js',
        args: [registered, shaped],
      },
      c,
      opts(),
    );
    expect(res.outcome, JSON.stringify(res)).toBe('success');
    await expectMaskedEverywhere(res, c.jobId);
  });

  it('a connector’s structured result: every string at any depth, the structure kept', async () => {
    const tool: ToolDefinition<z.ZodTypeAny, unknown> = {
      ...builtin('file_list'),
      name: 'acme__get_record',
      description: 'A connector call.',
      riskLevel: 'read',
      card: 'generic',
      present: undefined,
      execute: async () => ({
        ok: true,
        record: { id: 42, fields: { notes: `key ${registered}`, extra: [shaped] } },
        nextPageToken: 'CAESBggDEAEYAQ',
      }),
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
    const c = await ctx();
    const res = await executeTool(tool, {}, c, opts(['acme__get_record']));
    expect(res.outcome, JSON.stringify(res)).toBe('success');
    await expectMaskedEverywhere(res, c.jobId);
    if (res.outcome === 'success') {
      expect(res.output).toEqual({
        ok: true,
        record: { id: 42, fields: { notes: `key ${REDACTED_TEXT}`, extra: [REDACTED_TEXT] } },
        nextPageToken: 'CAESBggDEAEYAQ',
      });
    }
  });

  it('an MCP server’s text, and the error it raises', async () => {
    const base = builtin('file_list');
    const text = {
      ...base,
      name: 'srv__read_config',
      riskLevel: 'read',
      card: 'generic',
      present: undefined,
      execute: async () => `{"config": {"note": "${registered}", "gh": "${shaped}"}}`,
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
    const c1 = await ctx();
    const ok = await executeTool(text, {}, c1, opts(['srv__read_config']));
    expect(ok.outcome).toBe('success');
    await expectMaskedEverywhere(ok, c1.jobId);

    const failing = {
      ...text,
      name: 'srv__fail',
      execute: async () => {
        throw new ToolFailedWithOutput(`upstream refused key ${registered}`, {
          echoed: shaped,
        });
      },
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
    const c2 = await ctx();
    const err = await executeTool(failing, {}, c2, opts(['srv__fail']));
    expect(err.outcome).toBe('error');
    if (err.outcome === 'error') expect(err.raisedByTool).toBe(true);
    await expectMaskedEverywhere(err, c2.jobId);
  });

  it('the switch off for this agent: the shape passes, the registered value does not; another agent is unaffected', async () => {
    const [other] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Other',
        slug: `other-${randomBytes(4).toString('hex')}`,
        personality: 'x',
      })
      .returning();
    await db.update(agents).set({ maskSecretShapes: false }).where(eq(agents.id, seed.agentId));
    try {
      const cOff = await ctx();
      const off = await executeTool(
        builtin('file_read'),
        { path: 'settings.env', purpose: 'Read.' },
        cOff,
        opts(),
      );
      expect(JSON.stringify(off)).toContain(shaped);
      expect(JSON.stringify(off)).not.toContain(registered);
      const [rowOff] = await rowsOf(cOff.jobId);
      expect(rowOff!.toolOutput).toContain(shaped);
      expect(rowOff!.toolOutput).not.toContain(registered);

      const cOn = await ctx({ agentId: other!.id });
      const on = await executeTool(
        builtin('file_read'),
        { path: 'settings.env', purpose: 'Read.' },
        cOn,
        {
          approvalRules: autonomousRows({ ...seed, agentId: other!.id }),
          onApprovalRequired: async () => {},
        },
      );
      expect(JSON.stringify(on)).not.toContain(shaped);
      expect(JSON.stringify(on)).not.toContain(registered);
    } finally {
      await db.update(agents).set({ maskSecretShapes: true }).where(eq(agents.id, seed.agentId));
    }
  });

  it('a result with nothing to hide is handed on and stored as it is, unmarked', async () => {
    await writeFile(join(dir, 'plain.txt'), 'nothing to hide\n');
    const c = await ctx();
    const res = await executeTool(
      builtin('file_read'),
      { path: 'plain.txt', purpose: 'Read.' },
      c,
      opts(),
    );
    expect(JSON.stringify(res)).toContain('nothing to hide');
    const [row] = await rowsOf(c.jobId);
    expect(row!.resultMasked).toBe(false);
  });
});

describe('a call held for approval runs with its real input @cap:approuver-une-action/moteur', () => {
  it('stored raw for execution, recorded masked, executed with the real value', async () => {
    let received: unknown = null;
    const tool = {
      ...builtin('file_list'),
      name: 'acme__send',
      inputSchema: z.object({ body: z.string(), purpose: z.string() }),
      riskLevel: 'write',
      defaultApproval: 'require_approval',
      card: 'generic',
      present: undefined,
      execute: async (input: unknown) => {
        received = input;
        return { sent: true };
      },
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
    const input = { body: `token ${shaped}`, purpose: 'Send the note.' };
    const c = await ctx({ toolCallId: 'call-held-1' });
    const held = await executeTool(tool, input, c, {
      approvalRules: [
        ...rules(),
        {
          id: 'ask',
          toolName: 'acme__send',
          action: 'require_approval',
          agentId: seed.agentId,
          entityId: seed.entityId,
        } as ApprovalRule,
      ],
      onApprovalRequired: async () => {},
    });
    expect(held.outcome, JSON.stringify(held)).toBe('awaiting_approval');
    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, c.jobId));
    // What is stored for execution is the real input.
    expect(JSON.stringify(req!.toolInput)).toContain(shaped);

    // Approved: the runner re-runs the call from that row.
    const ran = await executeTool(tool, req!.toolInput, c, opts(['acme__send']));
    expect(ran.outcome).toBe('success');
    expect(received).toEqual(input);
    const rows = await rowsOf(c.jobId);
    // What is recorded of the input is masked.
    for (const r of rows) expect(JSON.stringify(r.toolInput)).not.toContain(shaped);
  });
});

describe('a masked read is never written back @cap:travailler-sur-des-fichiers/moteur', () => {
  async function readThenWrite(tool: string, input: Record<string, unknown>) {
    const file = join(dir, 'app.env');
    const original = ['NAME=demo', `ACME_KEY=${registered}`, 'PORT=8080', `GH=${shaped}`, ''].join(
      '\n',
    );
    await writeFile(file, original);
    const c = await ctx();
    const read = await executeTool(
      builtin('file_read'),
      { path: 'app.env', purpose: 'Read.' },
      c,
      opts(),
    );
    expect(JSON.stringify(read)).toContain(REDACTED_TEXT);
    const res = await executeTool(builtin(tool), { path: 'app.env', ...input }, c, opts());
    return { res, original, onDisk: await readFile(file, 'utf8') };
  }

  it('an overwrite with the masked text is refused, naming the hidden lines; the file is untouched', async () => {
    const masked = [
      'NAME=demo',
      `ACME_KEY=${REDACTED_TEXT}`,
      'PORT=9090',
      `GH=${REDACTED_TEXT}`,
      '',
    ].join('\n');
    const { res, original, onDisk } = await readThenWrite('file_write', {
      content: masked,
      purpose: 'Change the port.',
    });
    expect(res.outcome).toBe('success');
    const out = (res as { output: { ok: boolean; reason?: string } }).output;
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('lines 2, 4');
    expect(onDisk).toBe(original);
  });

  it('an edit that quotes a masked line is refused with the reason, not "not found"', async () => {
    const { res, original, onDisk } = await readThenWrite('file_edit', {
      old_string: `ACME_KEY=${REDACTED_TEXT}`,
      new_string: 'ACME_KEY=other',
      purpose: 'Change the key.',
    });
    const out = (res as { output: { ok: boolean; reason?: string } }).output;
    expect(out.ok).toBe(false);
    expect(out.reason).toContain(REDACTED_TEXT);
    expect(out.reason).toContain('lines 2, 4');
    expect(onDisk).toBe(original);
  });

  it('an edit of other lines goes through and leaves the hidden bytes as they are on disk', async () => {
    const { res, original, onDisk } = await readThenWrite('file_edit', {
      old_string: 'PORT=8080',
      new_string: 'PORT=9090',
      purpose: 'Change the port.',
    });
    const out = (res as { output: { ok: boolean } }).output;
    expect(out.ok).toBe(true);
    expect(onDisk).toBe(original.replace('PORT=8080', 'PORT=9090'));
    expect(onDisk).toContain(`ACME_KEY=${registered}`);
    expect(onDisk).toContain(`GH=${shaped}`);
  });

  it('a file that already holds the words is edited like any other', async () => {
    const file = join(dir, 'doc.md');
    await writeFile(file, `The mask writes ${REDACTED_TEXT} in place of a value.\n`);
    const c = await ctx();
    const res = await executeTool(
      builtin('file_edit'),
      {
        path: 'doc.md',
        old_string: `writes ${REDACTED_TEXT} in`,
        new_string: `writes ${REDACTED_TEXT} at the place of`,
        purpose: 'Reword.',
      },
      c,
      opts(),
    );
    expect((res as { output: { ok: boolean } }).output.ok).toBe(true);
  });
});
