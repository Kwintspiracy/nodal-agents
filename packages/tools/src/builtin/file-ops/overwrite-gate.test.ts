// overwrite-gate.test.ts — D1: gate file_write/file_edit ONLY when they would
// overwrite an EXISTING file inside the entity-wide SHARED workspace.
//
// Born from a real incident: in propose_confirm mode, the orchestrator
// OVERWROTE a shared workflow template with zero approval, while a plain `ls`
// elsewhere still asked for one. The owner's decision: gate destructive
// writes to the SHARED workspace specifically — never an attached workspace
// (e.g. an Obsidian vault via agent_workspaces), never the agent's own
// private workspace, and never a brand-new file (creation isn't destructive).
//
// This exercises the full path through executeTool (real DB, real approval
// gate) with real temp-dir workspaces, so it proves the WIRING — not just
// the pure helper (computeSharedOverwriteApproval / isPathInSharedWorkspace)
// in isolation.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { approvalRequests } from '@nodal-agents/db';
import { executeTool } from '../../execute';
import { SHARED_WORKSPACE_LABEL } from './workspace';
import { fileWriteTool } from './file-write';
import { fileEditTool } from './file-edit';
import type { ToolContext, ExecuteOptions, ApprovalRule } from '../../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let SHARED_ROOT: string;
let ATTACHED_ROOT: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  SHARED_ROOT = await mkdtemp(join(tmpdir(), 'nodal-shared-'));
  ATTACHED_ROOT = await mkdtemp(join(tmpdir(), 'nodal-attached-'));
});

afterEach(async () => {
  await rm(SHARED_ROOT, { recursive: true, force: true });
  await rm(ATTACHED_ROOT, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [
      // Owner-attached workspace (agent_workspaces row) — a real label, e.g.
      // "vault", never the reserved shared label. Positioned first so it's
      // also the single-workspace default when no label prefix is given.
      { label: 'vault', path: ATTACHED_ROOT },
      { label: SHARED_WORKSPACE_LABEL, path: SHARED_ROOT },
    ],
  };
}

function opts(autonomy?: ExecuteOptions['autonomy'], rules: ApprovalRule[] = []): ExecuteOptions {
  return {
    approvalRules: rules,
    autonomy,
    onApprovalRequired: async () => {},
  };
}

describe('D1 overwrite gate — file_write', () => {
  it('shared workspace + existing file + propose_confirm (undefined autonomy) → awaiting_approval', async () => {
    await writeFile(join(SHARED_ROOT, 'template.json'), 'old', 'utf8');
    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/template.json`, content: 'new' },
      ctx(),
      opts(undefined),
    );
    expect(result.outcome).toBe('awaiting_approval');

    const id = result.outcome === 'awaiting_approval' ? result.approvalRequestId : null;
    const rows = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toolName).toBe('file_write');
  });

  it('shared workspace + existing file + destructive_gate → STILL awaiting_approval', async () => {
    await writeFile(join(SHARED_ROOT, 'template.json'), 'old', 'utf8');
    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/template.json`, content: 'new' },
      ctx(),
      opts('destructive_gate'),
    );
    expect(result.outcome).toBe('awaiting_approval');
  });

  it('shared workspace + NEW file (does not exist yet) → executes, no gate', async () => {
    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/brand-new.json`, content: 'hello' },
      ctx(),
      opts(undefined),
    );
    expect(result.outcome).toBe('success');
  });

  it('ATTACHED workspace (owner-attached, e.g. Obsidian vault) + existing file + destructive_gate → executes, exempt', async () => {
    await writeFile(join(ATTACHED_ROOT, 'note.md'), 'old', 'utf8');
    const result = await executeTool(
      fileWriteTool,
      { path: 'vault/note.md', content: 'new' },
      ctx(),
      opts('destructive_gate'),
    );
    expect(result.outcome).toBe('success');
  });

  it('ATTACHED workspace + existing file + propose_confirm → executes, exempt (never gated regardless of mode)', async () => {
    await writeFile(join(ATTACHED_ROOT, 'note.md'), 'old', 'utf8');
    const result = await executeTool(
      fileWriteTool,
      { path: 'vault/note.md', content: 'new' },
      ctx(),
      opts(undefined),
    );
    expect(result.outcome).toBe('success');
  });

  it('shared workspace + existing file + fully_autonomous → executes, no gate', async () => {
    await writeFile(join(SHARED_ROOT, 'template.json'), 'old', 'utf8');
    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/template.json`, content: 'new' },
      ctx(),
      opts('fully_autonomous'),
    );
    expect(result.outcome).toBe('success');
    const written = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(SHARED_ROOT, 'template.json'), 'utf8'),
    );
    expect(written).toBe('new');
  });

  it('resume after approval: synthetic auto_approve rule executes without re-gating', async () => {
    await writeFile(join(SHARED_ROOT, 'template.json'), 'old', 'utf8');
    const resumeRule: ApprovalRule = {
      id: 'resume-bypass',
      toolName: 'file_write',
      action: 'auto_approve',
      agentId: null,
      entityId: seed.entityId,
    };
    // Same shared+existing+propose_confirm shape that gated above — but with
    // the resume-time synthetic rule, it must execute immediately.
    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/template.json`, content: 'resumed' },
      ctx(),
      opts(undefined, [resumeRule]),
    );
    expect(result.outcome).toBe('success');
    const written = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(SHARED_ROOT, 'template.json'), 'utf8'),
    );
    expect(written).toBe('resumed');
  });
});

describe('D1 overwrite gate — file_edit', () => {
  it('shared workspace + propose_confirm → awaiting_approval (file_edit always targets an existing file)', async () => {
    await writeFile(join(SHARED_ROOT, 'doc.md'), 'hello world', 'utf8');
    const result = await executeTool(
      fileEditTool,
      { path: `${SHARED_WORKSPACE_LABEL}/doc.md`, old_string: 'hello', new_string: 'bye' },
      ctx(),
      opts(undefined),
    );
    expect(result.outcome).toBe('awaiting_approval');
  });

  it('attached workspace + destructive_gate → executes, exempt', async () => {
    await writeFile(join(ATTACHED_ROOT, 'doc.md'), 'hello world', 'utf8');
    const result = await executeTool(
      fileEditTool,
      { path: 'vault/doc.md', old_string: 'hello', new_string: 'bye' },
      ctx(),
      opts('destructive_gate'),
    );
    expect(result.outcome).toBe('success');
  });

  it('fully_autonomous → executes, no gate', async () => {
    await writeFile(join(SHARED_ROOT, 'doc.md'), 'hello world', 'utf8');
    const result = await executeTool(
      fileEditTool,
      { path: `${SHARED_WORKSPACE_LABEL}/doc.md`, old_string: 'hello', new_string: 'bye' },
      ctx(),
      opts('fully_autonomous'),
    );
    expect(result.outcome).toBe('success');
  });
});
