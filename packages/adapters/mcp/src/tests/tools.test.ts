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

  it('execute() dispatches with the original un-prefixed name and joins text-only content', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
    }));
    const client = { callTool } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'cogni-cortex');

    const out = await def.execute({ detail: true }, {} as never);

    expect(callTool).toHaveBeenCalledWith(
      { name: 'get_home', arguments: { detail: true } },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number), resetTimeoutOnProgress: true }),
    );
    // Text-only content blocks are joined into their text (often serialized JSON),
    // not surfaced as the raw block wrapper.
    expect(out).toBe('hi');
  });

  it('execute() prefers structuredContent over (empty) content blocks', async () => {
    // Airtable & other structured-output servers return data here while the SDK
    // defaults `content` to []. Regression for live job c66f1db0 (empty results).
    const records = [{ id: 'rec1', fields: { Name: 'A' } }];
    const client = {
      callTool: vi.fn(async () => ({ content: [], structuredContent: { records } })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'airtable');

    const out = await def.execute({ baseId: 'app1', tableId: 'JobList' }, {} as never);

    expect(out).toEqual({ records });
  });

  it('execute() returns the raw blocks when content has non-text blocks', async () => {
    const blocks = [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }];
    const client = {
      callTool: vi.fn(async () => ({ content: blocks })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    const out = await def.execute({}, {} as never);

    expect(out).toEqual(blocks);
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
