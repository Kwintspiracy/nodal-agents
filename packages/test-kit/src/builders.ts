// builders.ts — fixtures for the objects every test in this repo has to invent.
//
// The problem this solves is measurable: a runner route test opens with a
// 40-line `RunnerEnv` literal, and the next one copies it. When a field is
// added, every copy has to be found. Worse, each copy quietly encodes its own
// idea of "a normal environment" — so two tests can disagree about the default
// posture of the product and neither is wrong on its face.
//
// Builders give ONE definition of "normal" and make the DIFFERENCE the visible
// part of a test:
//
//     const ctx = aToolContext({ entityId: 'other-entity' });
//
// reads as "same as normal, but another entity" — which is the thing the test is
// actually about.
//
// Every builder takes a partial override and returns a plain object. No magic,
// no shared mutable state between tests.

import { z } from 'zod';
import type {
  ApprovalRuleLike as ApprovalRule,
  ToolContextLike as ToolContext,
  ToolDefinitionLike as ToolDefinition,
} from './types';

/** Deep-ish merge: overrides win, nested objects merge one level. */
function merge<T extends object>(base: T, over?: Partial<T>): T {
  if (!over) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
        ? { ...(cur as object), ...(v as object) }
        : v;
  }
  return out as T;
}

// ─── Identities ───────────────────────────────────────────────────────────────

export const TEST_ENTITY_ID = '00000000-0000-0000-0000-0000000000e1';
export const TEST_AGENT_ID = '00000000-0000-0000-0000-0000000000a1';
export const TEST_JOB_ID = '00000000-0000-0000-0000-0000000000j1'.replace('j', 'b');

// ─── ToolContext ──────────────────────────────────────────────────────────────

/**
 * A `db` stub that satisfies the approval gate's only DB need: inserting an
 * `approval_requests` row and returning its id.
 *
 * Deliberately NOT a full mock. A test that needs real rows should use a real
 * database (`spinUpTestDb`); a test about GATE LOGIC should not be able to pass
 * or fail because of a query shape.
 */
export function aStubDb(overrides?: { approvalRowId?: string }) {
  const id = overrides?.approvalRowId ?? 'approval-row-1';
  return {
    insert: () => ({
      values: () => ({ returning: async () => [{ id }] }),
    }),
  };
}

export function aToolContext(over?: Partial<ToolContext>): ToolContext {
  return merge(
    {
      db: aStubDb(),
      entityId: TEST_ENTITY_ID,
      agentId: TEST_AGENT_ID,
      jobId: TEST_JOB_ID,
    } as unknown as ToolContext,
    over,
  );
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export interface ToolBuilderOptions {
  name?: string;
  description?: string;
  riskLevel?: 'read' | 'write' | 'destructive';
  defaultApproval?: 'auto_approve' | 'require_approval' | 'block';
  inputSchema?: z.ZodTypeAny;
  /** Replaces the default no-op executor. */
  execute?: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

/** Records whether the tool actually ran — the only assertion that matters. */
export interface BuiltTool {
  tool: ToolDefinition;
  /** True once `execute` has been called. */
  didRun: () => boolean;
  /** Inputs the tool was called with, in order. */
  calls: () => unknown[];
}

function buildTool(base: ToolBuilderOptions, over?: ToolBuilderOptions): BuiltTool {
  const o = { ...base, ...over };
  const calls: unknown[] = [];
  const tool = {
    name: o.name ?? 'a_tool',
    description: o.description ?? 'A tool.',
    inputSchema: o.inputSchema ?? z.object({}).passthrough(),
    riskLevel: o.riskLevel ?? 'write',
    ...(o.defaultApproval ? { defaultApproval: o.defaultApproval } : {}),
    async execute(input: unknown, ctx: ToolContext) {
      calls.push(input);
      return o.execute ? o.execute(input, ctx) : { ok: true };
    },
  } as unknown as ToolDefinition;

  return { tool, didRun: () => calls.length > 0, calls: () => [...calls] };
}

/** An ordinary product tool: no declared approval posture. */
export function aBuiltinTool(over?: ToolBuilderOptions): BuiltTool {
  return buildTool({ name: 'list_models', riskLevel: 'read' }, over);
}

/** A product tool that gates itself, like run_command or create_agent. */
export function aGatedBuiltinTool(over?: ToolBuilderOptions): BuiltTool {
  return buildTool(
    { name: 'run_command', riskLevel: 'destructive', defaultApproval: 'require_approval' },
    over,
  );
}

/**
 * A tool as `buildMcpToolDefinition` produces one — namespaced name, and the
 * `require_approval` posture MCP-001 gave it.
 *
 * `serverPrefix` matters: the namespace is what a per-server rule keys off.
 */
export function anMcpTool(
  over?: ToolBuilderOptions & { serverPrefix?: string; toolName?: string },
): BuiltTool {
  const prefix = over?.serverPrefix ?? 'srv';
  const tool = over?.toolName ?? 'do_thing';
  return buildTool(
    {
      name: `${prefix}__${tool}`,
      description: 'A tool supplied by a third-party MCP server.',
      riskLevel: 'write',
      defaultApproval: 'require_approval',
    },
    over,
  );
}

// ─── Approval rules ───────────────────────────────────────────────────────────

export function anApprovalRule(over?: Partial<ApprovalRule>): ApprovalRule {
  return merge(
    {
      id: 'rule-1',
      toolName: '*',
      action: 'auto_approve',
      agentId: null,
      entityId: TEST_ENTITY_ID,
    } as ApprovalRule,
    over,
  );
}

/** `auto_approve` covering every tool of one MCP server. */
export function aServerRule(
  serverPrefix: string,
  action: ApprovalRule['action'] = 'auto_approve',
  over?: Partial<ApprovalRule>,
): ApprovalRule {
  return anApprovalRule({ toolName: `${serverPrefix}__*`, action, ...over });
}

/** A rule for one exact tool. */
export function aToolRule(
  toolName: string,
  action: ApprovalRule['action'] = 'auto_approve',
  over?: Partial<ApprovalRule>,
): ApprovalRule {
  return anApprovalRule({ toolName, action, ...over });
}
