// mcp-elicit-server.mjs — a real MCP server that ASKS its client a question
// (`elicitation/create`, form mode) in the middle of a tool call, for tests.
//
// Built with the official SDK (`McpServer` + `StdioServerTransport`), spawned
// by `node` as a stdio subprocess: what Nodal's client answers here is a real
// server over a real pipe, not a mock of the SDK. Plain JavaScript so any test
// can spawn it with `process.execPath` alone, without tsx.
//
// Tools:
//   - `order`       asks for { color (enum), copies (integer 1..5), duplex
//                   (boolean) } and returns, as JSON text, exactly what the
//                   client answered: `{ action, content }`, or `{ error }`
//                   when the question itself failed. Arguments:
//                     attach            join two images under
//                                       `_meta["nodal/attachments"]` (one
//                                       valid PNG, one that is not an image)
//                     serverTimeoutMs   how long the SERVER waits for the
//                                       answer before withdrawing its question
//                                       (SDK `timeout` → `notifications/cancelled`)
//                     afterMs           work the tool does AFTER the answer
//                     actions           labels for the two buttons, sent as
//                                       `_meta["nodal/actions"]` as given
//                     times             ask that many questions, one after
//                                       the other, and return the list of
//                                       replies
//   - `capabilities` returns the client capabilities the server received at
//                   initialize, as JSON text.
//   - `ask_later`   returns at once, then asks a question OUTSIDE any tool
//                   call; `later_result` returns what the client answered.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'elicit-fixture', version: '1.0.0' });

// 1×1 transparent PNG.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const ORDER_FORM = {
  type: 'object',
  properties: {
    color: { type: 'string', title: 'Color', enum: ['color', 'grayscale'] },
    copies: { type: 'integer', title: 'Copies', minimum: 1, maximum: 5 },
    duplex: { type: 'boolean', title: 'Two-sided', default: false },
  },
  required: ['color', 'copies'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.registerTool(
  'order',
  {
    description: 'Ask the person how to print, then report what they answered.',
    inputSchema: {
      attach: z.boolean().optional(),
      actions: z.record(z.string(), z.unknown()).optional(),
      serverTimeoutMs: z.number().optional(),
      afterMs: z.number().optional(),
      times: z.number().optional(),
    },
  },
  async ({ attach, actions, serverTimeoutMs, afterMs, times }) => {
    const meta = {
      ...(attach
        ? {
            'nodal/attachments': [
              { mimeType: 'image/png', data: PNG_1PX, caption: 'Page 1 preview' },
              { mimeType: 'text/html', data: 'PGI+aGk8L2I+' },
            ],
          }
        : {}),
      ...(actions ? { 'nodal/actions': actions } : {}),
    };
    const params = {
      message: 'How should "report.pdf" be printed?',
      requestedSchema: ORDER_FORM,
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    };
    const ask = async () => {
      try {
        const answer = await server.server.elicitInput(
          params,
          serverTimeoutMs ? { timeout: serverTimeoutMs } : undefined,
        );
        return { action: answer.action, content: answer.content ?? null };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };
    let reply;
    if (times) {
      reply = [];
      for (let i = 0; i < times; i++) reply.push(await ask());
    } else {
      reply = await ask();
    }
    if (afterMs) await sleep(afterMs);
    return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
  },
);

server.registerTool('capabilities', { description: 'What the client announced.' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(server.server.getClientCapabilities() ?? null) }],
}));

let later = null;
server.registerTool('ask_later', { description: 'Ask outside any call.' }, async () => {
  setTimeout(() => {
    server.server
      .elicitInput({ message: 'Out of the blue?', requestedSchema: ORDER_FORM })
      .then((a) => {
        later = { action: a.action, content: a.content ?? null };
      })
      .catch((err) => {
        later = { error: err instanceof Error ? err.message : String(err) };
      });
  }, 20);
  return { content: [{ type: 'text', text: 'asked' }] };
});

server.registerTool('later_result', { description: 'What ask_later received.' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(later) }],
}));

await server.connect(new StdioServerTransport());
