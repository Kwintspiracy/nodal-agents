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
//     echoed      a text block that IS the structuredContent, serialized
//                 differently (indented, keys in another order), next to it
//     blank       an empty text block and structuredContent
//     long        30,000 characters of text, then structuredContent: more text
//                 than the model's budget for one tool result
//     echoed-long the spec's recommended form, larger than the budget: a text
//                 block that IS the structuredContent (30k of notes first,
//                 the id and status last), next to it
//     tokens      text close to the budget, full of the untrusted-frame token
//                 that the frame neutralizes (and lengthens)
//     error       isError, with a text block and structuredContent
//     error-long  isError, 30,000 characters of text and structuredContent
//     empty       nothing at all
//
// One tool, `report`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** 3 KB of bytes, base64: a payload whose size is easy to read back. */
const BYTES_3KB = Buffer.alloc(3072, 7).toString('base64');

/** A machine form whose id and status come AFTER 30k of notes. */
const LONG_STRUCTURED = { notes: 'A long note. '.repeat(2_400), id: 'pr-11', status: 'pending' };

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
  echoed: {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ preview: { pages: 2 }, status: 'pending', id: 'pr-7' }, null, 2),
      },
    ],
    structuredContent: { id: 'pr-7', status: 'pending', preview: { pages: 2 } },
  },
  blank: {
    content: [{ type: 'text', text: '' }],
    structuredContent: { id: 'pr-7', status: 'pending' },
  },
  long: {
    content: [{ type: 'text', text: 'A long page. '.repeat(2_400) }],
    structuredContent: { id: 'pr-9', status: 'pending' },
  },
  error: {
    isError: true,
    content: [{ type: 'text', text: 'Printer offline: the request was not queued.' }],
    structuredContent: { status: 'refused' },
  },
  'echoed-long': {
    content: [{ type: 'text', text: JSON.stringify(LONG_STRUCTURED) }],
    structuredContent: LONG_STRUCTURED,
  },
  tokens: {
    content: [{ type: 'text', text: 'untrusted_tool_result '.repeat(1_130) }],
  },
  'error-long': {
    isError: true,
    content: [{ type: 'text', text: 'The printer said: '.repeat(1_700) }],
    structuredContent: { id: 'pr-12', status: 'refused' },
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
