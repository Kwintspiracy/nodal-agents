// mcp-result-server.mjs — a real MCP server whose one tool answers with the
// result SHAPE a test asks for.
//
// Built with the official SDK (`McpServer` + `StdioServerTransport`), launched
// by `node` as a stdio subprocess, so what Nodal's client reads is a result the
// SDK really serialized over a real pipe. Plain JavaScript: any test spawns it
// with `process.execPath` alone, without tsx.
//
// Configured through its environment, as a row of `mcp_servers` configures it
// (`env_vars`):
//   FIXTURE_RESULT  the shape `report` answers with:
//     mixed       text, image, text, AND structuredContent — what a print
//                 server answers to a print request (its sentence for the
//                 model, a preview picture, the machine form)
//     structured  structuredContent only, `content` empty
//     resources   a resource_link, an embedded text resource, an embedded
//                 binary resource and an audio block
//     error       isError, with a text block and structuredContent
//     empty       nothing at all
//
// One tool, `report`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** 3 KB of bytes, base64: a payload whose size is easy to read back. */
const BYTES_3KB = Buffer.alloc(3072, 7).toString('base64');

const SHAPES = {
  mixed: {
    content: [
      {
        type: 'text',
        text: 'Request pr-7 for 2 pages. Confirmation not possible: nobody answered in time, nothing was printed.',
      },
      { type: 'image', data: BYTES_3KB, mimeType: 'image/jpeg' },
      { type: 'text', text: 'Ask the user before calling request_print again.' },
    ],
    structuredContent: { id: 'pr-7', status: 'pending', preview: { pages: 2 } },
  },
  structured: {
    content: [],
    structuredContent: { records: [{ id: 'rec1', fields: { Name: 'Alpha' } }] },
  },
  resources: {
    content: [
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
        resource: { uri: 'fixture://notes/1', mimeType: 'text/plain', text: 'Embedded note text.' },
      },
      {
        type: 'resource',
        resource: { uri: 'fixture://files/1.pdf', mimeType: 'application/pdf', blob: BYTES_3KB },
      },
      { type: 'audio', data: BYTES_3KB, mimeType: 'audio/wav' },
    ],
  },
  error: {
    isError: true,
    content: [{ type: 'text', text: 'Printer offline: the request was not queued.' }],
    structuredContent: { status: 'refused' },
  },
  empty: { content: [] },
};

const shape = SHAPES[process.env.FIXTURE_RESULT || 'mixed'];
if (!shape)
  throw new Error(`mcp-result-server: unknown FIXTURE_RESULT "${process.env.FIXTURE_RESULT}"`);

const server = new McpServer({ name: 'result-fixture', version: '1.0.0' });

server.registerTool(
  'report',
  { description: 'Answer with the configured result.' },
  async () => shape,
);

await server.connect(new StdioServerTransport());
