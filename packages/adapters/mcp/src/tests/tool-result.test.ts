// tool-result.test.ts — every block of an MCP tool result is kept, and the
// model reads what the server wrote for it.
//
// Proven against a REAL server (fixtures/mcp-result-server.mjs, built on the
// SDK's `McpServer`, spawned over stdio): Nodal's own client, the SDK's own
// serialization, one server process per result shape.
//
//  - the record (`execute()`, what `tool_calls.tool_output` keeps) holds every
//    content block in order AND `structuredContent`, binaries as their size;
//  - the model (`toModelOutput`) reads the text blocks in order, the other
//    blocks said one per line, then `structuredContent` serialized — unless a
//    text block already IS that serialization (compared as JSON, not as text);
//    nothing the server sent is dropped in silence;
//  - `isError` stays a failure, and carries the server's text.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createMcpTools, type McpToolset } from '../index.ts';
import type { McpToolOutput } from '../result.ts';
import { MCP_TOOL_OUTPUT_FORMAT } from '@nodal-agents/shared';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-result-server.mjs', import.meta.url));
const SHAPES = ['mixed', 'structured', 'resources', 'echoed', 'blank', 'error', 'empty'] as const;
type Shape = (typeof SHAPES)[number];

const servers = new Map<Shape, McpToolset>();

beforeAll(async () => {
  await Promise.all(
    SHAPES.map(async (shape) => {
      servers.set(
        shape,
        await createMcpTools({
          transport: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
          env: { FIXTURE_RESULT: shape },
          slug: `result-${shape}`,
        }),
      );
    }),
  );
}, 60_000);

afterAll(async () => {
  await Promise.all([...servers.values()].map((s) => s.close()));
});

function report(shape: Shape) {
  const tool = servers.get(shape)?.tools.find((t) => t.name.endsWith('__report'));
  if (!tool) throw new Error(`no report tool on the ${shape} server`);
  return tool;
}

async function call(shape: Shape): Promise<{ record: McpToolOutput; model: string }> {
  const tool = report(shape);
  const record = (await tool.execute({ purpose: 'test' }, {} as never)) as McpToolOutput;
  if (!tool.toModelOutput) throw new Error('an MCP tool declares no toModelOutput');
  return { record, model: tool.toModelOutput(record) };
}

describe('an MCP tool result, kept whole and read by the model @cap:connecter-un-service/moteur', () => {
  it('text + image + structuredContent: the model reads every text block in order, is told of the image, and reads the structured result', async () => {
    const { record, model } = await call('mixed');

    expect(model).toBe(
      'Request pr-7 for 2 pages. Confirmation not possible: nobody answered in time, nothing was printed.\n' +
        '[Image returned by the tool (image/jpeg, 3 KB): not passed to you. ' +
        "Nodal does not give a tool's image to the model.]\n" +
        'Ask the user before calling request_print again.\n' +
        // The machine form too: the id is what the next call needs.
        '{"id":"pr-7","status":"pending","preview":{"pages":2}}',
    );
    // The record keeps it where the server put it, next to every block.
    expect(record).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [
        {
          type: 'text',
          text: 'Request pr-7 for 2 pages. Confirmation not possible: nobody answered in time, nothing was printed.',
        },
        { type: 'image', mimeType: 'image/jpeg', bytes: 3072 },
        { type: 'text', text: 'Ask the user before calling request_print again.' },
      ],
      structuredContent: { id: 'pr-7', status: 'pending', preview: { pages: 2 } },
    });
  });

  it('structuredContent alone: the model reads it, serialized', async () => {
    const { record, model } = await call('structured');

    expect(model).toBe('{"records":[{"id":"rec1","fields":{"Name":"Alpha"}}]}');
    expect(record).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [],
      structuredContent: { records: [{ id: 'rec1', fields: { Name: 'Alpha' } }] },
    });
  });

  it('a text block that already IS the structuredContent is not repeated (compared as JSON, not as text)', async () => {
    const { record, model } = await call('echoed');

    // Indented, keys in another order: textually different, the same JSON.
    expect(model).toBe(
      JSON.stringify({ preview: { pages: 2 }, status: 'pending', id: 'pr-7' }, null, 2),
    );
    expect(record.structuredContent).toEqual({
      id: 'pr-7',
      status: 'pending',
      preview: { pages: 2 },
    });
  });

  it('an empty text block next to structuredContent: the model reads the structured result, never an empty string', async () => {
    const { model } = await call('blank');

    expect(model).toBe('{"id":"pr-7","status":"pending"}');
  });

  it('resource links, embedded resources and audio are each said, never dropped', async () => {
    const { record, model } = await call('resources');

    expect(model.split('\n')).toEqual([
      '[Resource link: fixture://guides/card "Card guide" (text/markdown) — How to show the card]',
      '[Embedded resource fixture://notes/1 (text/plain)]',
      'Embedded note text.',
      '[Embedded resource fixture://files/1.pdf (application/pdf, 3 KB): binary content, not passed to you.]',
      "[Audio returned by the tool (audio/wav, 3 KB): not passed to you. Nodal does not give a tool's audio to the model.]",
    ]);
    expect(record.content).toEqual([
      {
        type: 'resource_link',
        uri: 'fixture://guides/card',
        name: 'card-guide',
        title: 'Card guide',
        mimeType: 'text/markdown',
        description: 'How to show the card',
      },
      {
        type: 'resource',
        uri: 'fixture://notes/1',
        mimeType: 'text/plain',
        text: 'Embedded note text.',
      },
      { type: 'resource', uri: 'fixture://files/1.pdf', mimeType: 'application/pdf', bytes: 3072 },
      { type: 'audio', mimeType: 'audio/wav', bytes: 3072 },
    ]);
    // No base64 survives into the record: the row is an audit, not a store.
    expect(JSON.stringify(record)).not.toContain(
      Buffer.alloc(16, 7).toString('base64').slice(0, 16),
    );
  });

  it('isError stays a failure, carrying the text the server wrote', async () => {
    await expect(report('error').execute({ purpose: 'test' }, {} as never)).rejects.toThrow(
      'MCP tool report failed: Printer offline: the request was not queued.',
    );
  });

  it('an empty result is said as empty', async () => {
    const { record, model } = await call('empty');

    expect(record).toEqual({ format: MCP_TOOL_OUTPUT_FORMAT, content: [] });
    expect(model).toBe('[The MCP tool returned an empty result.]');
  });
});
