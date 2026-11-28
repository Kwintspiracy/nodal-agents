// tool-sources.test.ts — in a job, a tool name designates exactly one target.
//
// `oneTargetPerName` is where every source of a job's tools meets (built-ins,
// delegation, delivery, connectors, MCP servers): a name two sources lend is
// refused, naming both. `lendConnectorTools` turns several accounts of one
// service into one tool per name with an `account` argument. These cases run
// on synthetic tools whose `execute` says which account answered; the runner
// suite (apps/runner/src/tests/job/connector-accounts.test.ts) proves the
// same on the real job loop and the real adapters.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ConnectorAccountsError,
  ToolNameCollisionError,
  BUILTIN_TOOLS_SOURCE,
  DELIVERY_TOOLS_SOURCE,
  connectorSource,
  lendConnectorTools,
  mcpServerSource,
  oneTargetPerName,
  type ConnectorAccount,
  type ConnectorLending,
} from '../tool-sources';
import { agentBuiltinToolNames } from '../whitelist';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin/index';
import type { ToolContext, ToolDefinition } from '../types';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;
const ctx = {} as ToolContext;

/** A connector tool that answers with the account it belongs to. */
function op(name: string, account: string, extra: Partial<AnyTool> = {}): AnyTool {
  return {
    name,
    description: `Operation ${name}.`,
    inputSchema: z.object({ to: z.string() }),
    riskLevel: 'write',
    execute: async (input: { to: string }) => ({ ranOn: account, input }),
    ...extra,
  } as AnyTool;
}

function account(name: string, slug = 'gmail', address: string | null = null): ConnectorAccount {
  return { id: `id-${slug}-${name}`, slug, name, address };
}

function lending(acc: ConnectorAccount, names: string[]): ConnectorLending {
  return { connector: acc, tools: names.map((n) => op(n, acc.name)) };
}

function jsonOf(tool: AnyTool): unknown {
  return z.toJSONSchema(tool.inputSchema);
}

describe('oneTargetPerName: one name, one source, for every source @cap:assigner-outils/moteur', () => {
  it('keeps the order of the sources and of their tools', () => {
    const tools = oneTargetPerName([
      { source: BUILTIN_TOOLS_SOURCE, tools: [op('a', 'x'), op('b', 'x')] },
      { source: mcpServerSource({ name: 'Fetch', slug: 'fetch' }), tools: [op('fetch__get', 'x')] },
    ]);
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'fetch__get']);
  });

  const clashes: Array<[string, Parameters<typeof oneTargetPerName>[0], string[]]> = [
    [
      'a connector tool and an MCP tool',
      [
        { source: connectorSource([account('Work')]), tools: [op('shared_name', 'Work')] },
        {
          source: mcpServerSource({ name: 'Mail', slug: 'mail' }),
          tools: [op('shared_name', 'm')],
        },
      ],
      ['the connector "Work" (gmail)', 'the MCP server "Mail" (mail)'],
    ],
    [
      'a built-in and a delivery tool',
      [
        { source: BUILTIN_TOOLS_SOURCE, tools: [op('send_file', 'b')] },
        { source: DELIVERY_TOOLS_SOURCE, tools: [op('send_file', 'd')] },
      ],
      ["Nodal's built-in tools", 'the channel delivery tools'],
    ],
    [
      'two MCP servers',
      [
        { source: mcpServerSource({ name: 'One', slug: 'srv' }), tools: [op('srv__ping', '1')] },
        { source: mcpServerSource({ name: 'Two', slug: 'srv' }), tools: [op('srv__ping', '2')] },
      ],
      ['the MCP server "One" (srv)', 'the MCP server "Two" (srv)'],
    ],
    [
      'one source lending a name twice',
      [{ source: BUILTIN_TOOLS_SOURCE, tools: [op('dup', '1'), op('dup', '2')] }],
      ["Nodal's built-in tools"],
    ],
  ];
  for (const [label, lent, named] of clashes) {
    it(`refuses ${label}, naming both sources and the tool`, () => {
      let error: unknown;
      try {
        oneTargetPerName(lent);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ToolNameCollisionError);
      const message = (error as Error).message;
      for (const n of named) expect(message.toLowerCase()).toContain(n.toLowerCase());
      expect(message).toContain(`a tool named "${(error as ToolNameCollisionError).toolName}"`);
      expect(message).toContain('Untick it on one of them');
    });
  }

  it('two skills naming the same built-in designate the one built-in: lent once, nothing refused', () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const names = agentBuiltinToolNames(
      {
        requiredBuiltins: ['file_read', 'file_read'],
        scriptsAuthorized: false,
        filesWritable: false,
        metaToolNames: [],
        job: { delegated: false, routine: false, inConversation: false },
      },
      registry,
    );
    const tools = oneTargetPerName([
      { source: BUILTIN_TOOLS_SOURCE, tools: names.map((n) => registry.get(n)!) },
    ]);
    expect(tools.filter((t) => t.name === 'file_read')).toHaveLength(1);
  });
});

describe('lendConnectorTools: several accounts of one service @cap:assigner-outils/moteur', () => {
  it('one account: its tools, unchanged (no account argument)', () => {
    const only = lending(account('Only'), ['gmail_send_email']);
    const [lent] = lendConnectorTools([only]);
    expect(lent!.tools[0]).toBe(only.tools[0]);
    expect(lent!.source.label).toBe('the connector "Only" (gmail)');
  });

  it('two accounts: each name once, with both accounts, required; each call runs on its account', async () => {
    const lent = lendConnectorTools([
      lending(account('Work', 'gmail', 'me@work.example'), ['gmail_send_email', 'gmail_list']),
      lending(account('Personal', 'gmail', 'me@home.example'), ['gmail_send_email', 'gmail_list']),
    ]);
    expect(lent).toHaveLength(1);
    const tools = oneTargetPerName(lent);
    expect(tools.map((t) => t.name)).toEqual(['gmail_send_email', 'gmail_list']);
    const send = tools[0]!;
    const schema = jsonOf(send) as {
      properties: Record<string, { enum?: string[]; description?: string }>;
      required: string[];
    };
    expect(schema.properties['account']!.enum).toEqual(['Personal', 'Work']);
    expect(schema.required).toContain('account');
    expect(schema.properties['account']!.description).toContain('"Work" (me@work.example)');

    const onWork = send.inputSchema.parse({ to: 'a', account: 'Work' });
    expect(await send.execute(onWork, ctx)).toEqual({
      account: 'Work',
      result: { ranOn: 'Work', input: { to: 'a' } },
    });
    const onHome = send.inputSchema.parse({ to: 'b', account: 'Personal' });
    expect(await send.execute(onHome, ctx)).toEqual({
      account: 'Personal',
      result: { ranOn: 'Personal', input: { to: 'b' } },
    });
  });

  it('the order the accounts come in decides nothing', async () => {
    const work = account('Work');
    const home = account('Personal');
    const ab = oneTargetPerName(
      lendConnectorTools([
        lending(work, ['gmail_send_email']),
        lending(home, ['gmail_send_email']),
      ]),
    );
    const ba = oneTargetPerName(
      lendConnectorTools([
        lending(home, ['gmail_send_email']),
        lending(work, ['gmail_send_email']),
      ]),
    );
    expect(JSON.stringify(jsonOf(ab[0]!))).toBe(JSON.stringify(jsonOf(ba[0]!)));
    for (const tools of [ab, ba]) {
      const out = await tools[0]!.execute(
        tools[0]!.inputSchema.parse({ to: 'x', account: 'Work' }),
        ctx,
      );
      expect(out).toMatchObject({ result: { ranOn: 'Work' } });
    }
  });

  it('a call that names no account, or one that is not there, is refused with the list', () => {
    const [send] = oneTargetPerName(
      lendConnectorTools([
        lending(account('Work', 'gmail', 'me@work.example'), ['gmail_send_email']),
        lending(account('Personal'), ['gmail_send_email']),
      ]),
    );
    const none = send!.inputSchema.safeParse({ to: 'x' });
    expect(none.success).toBe(false);
    const said = JSON.stringify(none.error?.issues);
    expect(said).toContain('account_required');
    expect(said).toContain('none is chosen for you');
    expect(said).toContain('\\"Work\\" (me@work.example)');
    expect(said).toContain('\\"Personal\\"');

    const stale = send!.inputSchema.safeParse({ to: 'x', account: 'Office' });
    expect(stale.success).toBe(false);
    expect(JSON.stringify(stale.error?.issues)).toContain(
      '\\"Office\\" is not one of the accounts',
    );
  });

  it('an operation one account allows only is offered with that account only', () => {
    const tools = oneTargetPerName(
      lendConnectorTools([
        lending(account('Reader'), ['gmail_list']),
        lending(account('Writer'), ['gmail_list', 'gmail_send_email']),
      ]),
    );
    const enumOf = (name: string) =>
      (
        jsonOf(tools.find((t) => t.name === name)!) as {
          properties: Record<string, { enum?: string[] }>;
        }
      ).properties['account']!.enum;
    expect(enumOf('gmail_list')).toEqual(['Reader', 'Writer']);
    expect(enumOf('gmail_send_email')).toEqual(['Writer']);
    expect(
      tools
        .find((t) => t.name === 'gmail_send_email')!
        .inputSchema.safeParse({
          to: 'x',
          account: 'Reader',
        }).success,
    ).toBe(false);
  });

  it('the two forms of one service (an API key and an OAuth app) are accounts of it', () => {
    const lent = lendConnectorTools([
      lending(account('Team', 'airtable'), ['airtable_list_bases']),
      lending(account('Mine', 'airtable-oauth'), ['airtable_list_bases']),
    ]);
    expect(lent).toHaveLength(1);
    expect(lent[0]!.source.label).toBe(
      'the connectors "Mine" (airtable-oauth) and "Team" (airtable)',
    );
  });

  it('two services under the same account name are two services: no argument, no refusal', () => {
    const lent = lendConnectorTools([
      lending(account('Work', 'gmail'), ['gmail_list']),
      lending(account('Work', 'google-calendar'), ['calendar_list']),
    ]);
    const tools = oneTargetPerName(lent);
    expect(tools.map((t) => t.name).sort()).toEqual(['calendar_list', 'gmail_list']);
    for (const t of tools) expect(jsonOf(t)).not.toHaveProperty('properties.account');
  });

  it('two accounts of one service under names a model could not tell apart are refused, naming both', () => {
    let error: unknown;
    try {
      lendConnectorTools([
        lending(account('Notion', 'notion'), ['notion_search']),
        lending(account(' notion ', 'notion-oauth'), ['notion_search']),
      ]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConnectorAccountsError);
    expect((error as Error).message).toContain('"Notion" (notion)');
    expect((error as Error).message).toContain('" notion " (notion-oauth)');
  });

  it('one name under two different definitions on two accounts is refused, naming both', () => {
    const a = account('A');
    const b = account('B');
    expect(() =>
      lendConnectorTools([
        { connector: a, tools: [op('gmail_x', 'A')] },
        {
          connector: b,
          tools: [op('gmail_x', 'B', { inputSchema: z.object({ other: z.number() }) })],
        },
      ]),
    ).toThrow(ToolNameCollisionError);
  });

  it('a tool that already has an `account` argument, or a per-call hook, is refused rather than guessed', () => {
    const withAccount = op('gmail_y', 'A', { inputSchema: z.object({ account: z.string() }) });
    expect(() =>
      lendConnectorTools([
        { connector: account('A'), tools: [withAccount] },
        { connector: account('B'), tools: [withAccount] },
      ]),
    ).toThrow(/already has an argument named "account"/);
    const withHook = op('gmail_z', 'A', { preflight: () => undefined });
    expect(() =>
      lendConnectorTools([
        { connector: account('A'), tools: [withHook] },
        { connector: account('B'), tools: [withHook] },
      ]),
    ).toThrow(/declares `preflight`/);
  });
});
