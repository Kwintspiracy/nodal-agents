import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpToolToToolDefinition, slugToPrefix } from '../tools.ts';
import type { McpToolDescriptor } from '../client.ts';

function clientWithCallTool(impl: () => unknown): Client {
  return { callTool: vi.fn(impl) } as unknown as Client;
}

const descriptor: McpToolDescriptor = {
  name: 'get_home',
  description: 'Return the home view',
  inputSchema: { type: 'object', properties: { detail: { type: 'boolean' } } },
  annotations: { readOnlyHint: true },
};

describe('slugToPrefix', () => {
  it('sanitises non-alphanumerics to underscores, lowercased', () => {
    expect(slugToPrefix('cogni-cortex')).toBe('cogni_cortex');
    expect(slugToPrefix('My Server')).toBe('my_server');
  });
});

describe('mcpToolToToolDefinition', () => {
  it('namespaces the tool name with the server slug', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      descriptor,
      'cogni-cortex',
    );
    expect(def.name).toBe('cogni_cortex__get_home');
  });

  it('maps readOnlyHint → riskLevel read', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      descriptor,
      'c',
    );
    expect(def.riskLevel).toBe('read');
  });

  it('maps destructiveHint → riskLevel destructive', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      { name: 'wipe', annotations: { destructiveHint: true } },
      'c',
    );
    expect(def.riskLevel).toBe('destructive');
  });

  it('defaults riskLevel to write when there are no annotations', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      { name: 'mystery' },
      'c',
    );
    expect(def.riskLevel).toBe('write');
  });

  it('execute() dispatches to callTool with the original un-prefixed name and returns content', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
    }));
    const client = { callTool } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'cogni-cortex');

    const out = await def.execute({ detail: true }, {} as never);

    expect(callTool).toHaveBeenCalledWith({ name: 'get_home', arguments: { detail: true } });
    expect(out).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('execute() throws when the MCP tool returns isError', async () => {
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    await expect(def.execute({}, {} as never)).rejects.toThrow(/boom/);
  });
});
