// descriptor-binding.test.ts — the operation descriptor is the one source of a
// connector tool's risk and default approval (issue #735).
//
// Before #735 the descriptor (`risk` + `requiresApproval`) was read by the UI
// only. No factory-built tool declared `defaultApproval`, so `executeTool` ran
// every connector operation without asking, under every autonomy level: 18 of
// the 20 operations the Connectors tab marks ⚠ never asked, and Gmail's two
// sends declared `write` where their descriptor said `destructive`.
//
// Two levels here:
//   1. every tool of every ADAPTER_REGISTRY entry, through both factories,
//      carries exactly what its descriptor declares — so a new connector cannot
//      drift again;
//   2. the REAL production gate (`executeTool`, through `createGateHarness`)
//      asks for every operation marked `requiresApproval`, built by the real
//      factories, and keeps the meaning of each autonomy level and of a rule.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  createGateHarness,
  aToolRule,
  TEST_AGENT_ID,
  type BuiltTool,
  type ExecuteToolFn,
} from '@nodal-agents/test-kit';
import {
  executeTool,
  exposeStatedPurpose,
  type ConnectorToolDefinition,
  type ToolDefinition,
} from '@nodal-agents/tools';
import type { OperationDescriptor } from '@nodal-agents/shared';
import { ADAPTER_REGISTRY, bindOperationDescriptors } from '../registry.ts';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

const MOCK_TOKEN = 'mock-access-token';

/** Every (connector, factory, tool, descriptor) the registry can hand a job. */
function everyBoundTool(): Array<{
  slug: string;
  factory: 'toolFactory' | 'toolFactoryWithResolver';
  tool: AnyTool;
  op: OperationDescriptor | undefined;
}> {
  const out: ReturnType<typeof everyBoundTool> = [];
  for (const [slug, entry] of Object.entries(ADAPTER_REGISTRY)) {
    const bySlug = new Map(entry.operations.map((op) => [op.slug, op]));
    const factories: Array<['toolFactory' | 'toolFactoryWithResolver', AnyTool[]]> = [
      ['toolFactory', entry.toolFactory(MOCK_TOKEN)],
    ];
    if (entry.toolFactoryWithResolver) {
      factories.push([
        'toolFactoryWithResolver',
        entry.toolFactoryWithResolver(async () => MOCK_TOKEN),
      ]);
    }
    for (const [factory, tools] of factories) {
      for (const tool of tools) out.push({ slug, factory, tool, op: bySlug.get(tool.name) });
    }
  }
  return out;
}

describe('ADAPTER_REGISTRY: each connector tool carries its descriptor @cap:approuver-une-action/moteur', () => {
  it('every tool of every factory has the risk and default approval of its descriptor', () => {
    const drift: string[] = [];
    for (const { slug, factory, tool, op } of everyBoundTool()) {
      if (!op) {
        drift.push(`${slug}/${factory}/${tool.name}: no descriptor`);
        continue;
      }
      const expected = {
        riskLevel: op.risk,
        defaultApproval: op.requiresApproval ? 'require_approval' : undefined,
      };
      const actual = { riskLevel: tool.riskLevel, defaultApproval: tool.defaultApproval };
      if (
        actual.riskLevel !== expected.riskLevel ||
        actual.defaultApproval !== expected.defaultApproval
      )
        drift.push(`${slug}/${factory}/${tool.name}: ${JSON.stringify(actual)}`);
    }
    expect(drift).toEqual([]);
  });

  it('covers every connector, both factories, and every operation marked requiresApproval', () => {
    const all = everyBoundTool();
    // Not a vacuous pass: the scan saw all 15 entries, the resolver factories
    // too, and the operations the issue named.
    expect(new Set(all.map((b) => b.slug)).size).toBe(Object.keys(ADAPTER_REGISTRY).length);
    expect(all.some((b) => b.factory === 'toolFactoryWithResolver')).toBe(true);
    const gated = all
      .filter((b) => b.factory === 'toolFactory' && b.tool.defaultApproval === 'require_approval')
      .map((b) => `${b.slug}/${b.tool.name}`);
    const flagged = Object.entries(ADAPTER_REGISTRY).flatMap(([slug, e]) =>
      e.operations.filter((op) => op.requiresApproval).map((op) => `${slug}/${op.slug}`),
    );
    expect(gated.sort()).toEqual(flagged.sort());
    expect(gated).toEqual(
      expect.arrayContaining([
        'gmail/gmail_send_email',
        'gmail/gmail_send_draft',
        'outlook-mail/outlook_send_email',
        'gmail/gmail_reply_message',
        'gmail/gmail_forward_message',
        'outlook-mail/outlook_reply_message',
        'outlook-mail/outlook_forward_message',
        'google-drive/drive_delete_file',
        'google-calendar/gcal_delete_event',
        'notion/notion_archive_page',
        'airtable/airtable_delete_record',
        'cloudflare/cloudflare_deploy',
        'cloudflare/cloudflare_delete_worker',
      ]),
    );
  });

  it('every descriptor has a tool: the factories build exactly the operations the UI shows', () => {
    for (const [slug, entry] of Object.entries(ADAPTER_REGISTRY)) {
      const names = entry
        .toolFactory(MOCK_TOKEN)
        .map((t) => t.name)
        .sort();
      expect({ slug, names }).toEqual({ slug, names: entry.operations.map((o) => o.slug).sort() });
    }
  });

  it("Gmail's sends are destructive, as their descriptor says", () => {
    const gmail = ADAPTER_REGISTRY['gmail']!.toolFactory(MOCK_TOKEN);
    const posture = (name: string) => {
      const t = gmail.find((x) => x.name === name);
      return { riskLevel: t?.riskLevel, defaultApproval: t?.defaultApproval };
    };
    expect(posture('gmail_send_email')).toEqual({
      riskLevel: 'destructive',
      defaultApproval: 'require_approval',
    });
    expect(posture('gmail_send_draft')).toEqual({
      riskLevel: 'destructive',
      defaultApproval: 'require_approval',
    });
    // A write that asks nothing stays that way.
    expect(posture('gmail_create_draft')).toEqual({
      riskLevel: 'write',
      defaultApproval: undefined,
    });
  });
});

describe('bindOperationDescriptors fails loud, never defaults @cap:approuver-une-action/moteur', () => {
  const op = (slug: string, over?: Partial<OperationDescriptor>): OperationDescriptor => ({
    slug,
    name: slug,
    risk: 'write',
    requiresApproval: false,
    ...over,
  });
  const tool = (name: string): ConnectorToolDefinition<z.ZodTypeAny, unknown> =>
    ({
      name,
      description: name,
      inputSchema: {} as z.ZodTypeAny,
      execute: async () => ({}),
    }) as ConnectorToolDefinition<z.ZodTypeAny, unknown>;

  it('a tool without a descriptor throws, naming the connector and the tool', () => {
    expect(() =>
      bindOperationDescriptors('acme', [op('acme_a')], [tool('acme_a'), tool('acme_b')]),
    ).toThrow(/connector 'acme': tool 'acme_b' has no operation descriptor/);
  });

  it('a descriptor without a tool throws, naming the operation', () => {
    expect(() =>
      bindOperationDescriptors('acme', [op('acme_a'), op('acme_gone')], [tool('acme_a')]),
    ).toThrow(/connector 'acme': operation descriptor\(s\) acme_gone match no tool/);
  });

  it('applies risk and approval from the descriptor, whatever the tool object carried', () => {
    const [bound] = bindOperationDescriptors(
      'acme',
      [op('acme_a', { risk: 'destructive', requiresApproval: true })],
      [{ ...tool('acme_a'), riskLevel: 'read' } as ConnectorToolDefinition<z.ZodTypeAny, unknown>],
    );
    expect({ riskLevel: bound?.riskLevel, defaultApproval: bound?.defaultApproval }).toEqual({
      riskLevel: 'destructive',
      defaultApproval: 'require_approval',
    });
  });
});

// ─── The real gate, on the real tools ──────────────────────────────────────────

const { expectGate } = createGateHarness(executeTool as unknown as ExecuteToolFn);

/**
 * The real tool the registry hands a job, prepared the way the runner prepares
 * it (`exposeStatedPurpose`, apps/runner/src/job/execute.ts), with its network
 * `execute` replaced by a recorder: the posture under test is the tool's own,
 * only the call to the provider is not made.
 */
function realConnectorTool(slug: string, name: string): BuiltTool {
  const real = ADAPTER_REGISTRY[slug]!.toolFactory(MOCK_TOKEN).find((t) => t.name === name);
  if (!real) throw new Error(`${slug} builds no ${name}`);
  const [exposed] = exposeStatedPurpose([real], {
    approvalRules: [],
    agentId: TEST_AGENT_ID,
    entityId: 'entity',
  });
  const calls: unknown[] = [];
  const tool = {
    ...exposed!,
    execute: async (input: unknown) => {
      calls.push(input);
      return { ok: true };
    },
  } as unknown as BuiltTool['tool'];
  return { tool, didRun: () => calls.length > 0, calls: () => [...calls] };
}

// The gate validates the input first; the cases that sweep every operation are
// about the posture, not the arguments, so they accept any.
const PERMISSIVE_INPUT = z.object({ purpose: z.string() }).passthrough();

const SEND_EMAIL_INPUT = {
  to: 'someone@example.com',
  subject: 'Hello',
  body: 'Hi.',
  purpose: 'Reply to the owner’s request.',
};

describe('the gate asks for a real connector operation marked requiresApproval @cap:regler-autonomie/moteur', () => {
  it('gmail_send_email asks under the shipped default, propose_confirm and destructive_gate', async () => {
    await expectGate(realConnectorTool('gmail', 'gmail_send_email'))
      .withRules([])
      .withInput(SEND_EMAIL_INPUT)
      .underAutonomy(undefined, 'propose_confirm', 'destructive_gate')
      .toRequireApproval();
  });

  it('gmail_send_email runs under fully_autonomous', async () => {
    await expectGate(realConnectorTool('gmail', 'gmail_send_email'))
      .withRules([])
      .withInput(SEND_EMAIL_INPUT)
      .underAutonomy('fully_autonomous')
      .toRunWithoutAsking();
  });

  it('gmail_send_email runs with an auto_approve rule (the card’s Always allow) and with the agent’s own rule (Yolo)', async () => {
    await expectGate(realConnectorTool('gmail', 'gmail_send_email'))
      .withRules([aToolRule('gmail_send_email')])
      .withInput(SEND_EMAIL_INPUT)
      .underEveryAutonomy()
      .toRunWithoutAsking();
    await expectGate(realConnectorTool('gmail', 'gmail_send_email'))
      .withRules([aToolRule('gmail_send_email', 'auto_approve', { agentId: TEST_AGENT_ID })])
      .withInput(SEND_EMAIL_INPUT)
      .underEveryAutonomy()
      .toRunWithoutAsking();
  });

  it('an approved call runs exactly once: the resume’s synthetic auto_approve rule does not re-gate it', async () => {
    // apps/runner/src/job/execute.ts replays an approved call with a rule
    // `{ toolName, action: 'auto_approve' }` named 'resume-bypass'.
    const built = realConnectorTool('gmail', 'gmail_send_email');
    await expectGate(built)
      .withRules([aToolRule('gmail_send_email', 'auto_approve', { id: 'resume-bypass' })])
      .withInput(SEND_EMAIL_INPUT)
      .underAutonomy(undefined)
      .toRunWithoutAsking();
    expect(built.calls()).toHaveLength(1);
  });

  it('every operation marked requiresApproval, of every connector, asks under the shipped default and propose_confirm', async () => {
    const flagged = Object.entries(ADAPTER_REGISTRY).flatMap(([slug, e]) =>
      e.operations.filter((op) => op.requiresApproval).map((op) => ({ slug, op })),
    );
    // 20 at #735, plus Gmail's and Outlook's reply and forward (#711: sending
    // an email asks by default).
    expect(flagged.length).toBe(24);
    for (const { slug, op } of flagged) {
      // The real tool's posture, with a schema that accepts the harness's
      // `{ purpose }` input (the real one would refuse its missing arguments
      // before the gate).
      const built = realConnectorTool(slug, op.slug);
      const permissive = {
        ...built,
        tool: { ...built.tool, inputSchema: PERMISSIVE_INPUT } as BuiltTool['tool'],
      };
      const results = await expectGate(permissive)
        .withRules([])
        .underAutonomy(undefined, 'propose_confirm')
        .run();
      expect({ op: op.slug, asked: results.map((r) => r.asked && !r.ran) }).toEqual({
        op: op.slug,
        asked: [true, true],
      });
    }
  });

  it('under destructive_gate: a destructive operation asks, a write one marked requiresApproval runs (the existing relaxation)', async () => {
    const at = (slug: string, name: string) => {
      const built = realConnectorTool(slug, name);
      return {
        ...built,
        tool: { ...built.tool, inputSchema: PERMISSIVE_INPUT } as BuiltTool['tool'],
      };
    };
    await expectGate(at('airtable', 'airtable_delete_record'))
      .withRules([])
      .underAutonomy('destructive_gate')
      .toRequireApproval();
    // cloudflare_deploy is the only `write` + requiresApproval operation:
    // `destructive_gate` auto-approves ordinary work and keeps the gate on a
    // `destructive` tool (packages/tools/src/execute.ts). Unchanged by #735.
    await expectGate(at('cloudflare', 'cloudflare_deploy'))
      .withRules([])
      .underAutonomy('destructive_gate')
      .toRunWithoutAsking();
  });

  it('CONTROL: an operation not marked requiresApproval runs without asking in every mode', async () => {
    await expectGate(realConnectorTool('gmail', 'gmail_create_draft'))
      .withRules([])
      .withInput({ to: 'a@example.com', subject: 's', body: 'b', purpose: 'draft it' })
      .underEveryAutonomy()
      .toRunWithoutAsking();
  });
});
