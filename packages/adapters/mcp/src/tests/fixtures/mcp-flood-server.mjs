// mcp-flood-server.mjs — a stdio MCP server with two big answers, for the
// read-buffer ceiling of the transport (SDK >= 1.32 bounds it).
//
//   `big`    answers with ONE well-formed message whose text is BIG_BYTES long,
//            ended by its newline: a large tool result (pages rendered as
//            images are tens of MB), which the platform must receive whole;
//   `flood`  writes FLOOD_BYTES without ever ending the line: the shape of a
//            runaway or hostile server, which the transport must cut off;
//   `die`    exits at once: a crashed server, whose failure must stay a plain
//            `Connection closed`.
//
// Speaks raw JSON-RPC lines so the test depends on nothing but the wire:
//   argv[2]  the file that receives this server's pid
//   argv[3]  BIG_BYTES
//   argv[4]  FLOOD_BYTES
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

writeFileSync(process.argv[2], String(process.pid));
const BIG_BYTES = Number(process.argv[3]);
const FLOOD_BYTES = Number(process.argv[4]);
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'flood', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: ['big', 'flood', 'die'].map((name) => ({ name, inputSchema: { type: 'object' } })),
    });
  } else if (msg.method === 'tools/call' && msg.params.name === 'big') {
    reply(msg.id, { content: [{ type: 'text', text: 'x'.repeat(BIG_BYTES) }] });
  } else if (msg.method === 'tools/call' && msg.params.name === 'die') {
    process.exit(1);
  } else if (msg.method === 'tools/call') {
    process.stdout.write('x'.repeat(FLOOD_BYTES));
  }
});
// The pipe may close under the flood; the test reads the outcome on the client side.
process.stdout.on('error', () => {});
setInterval(() => {}, 1000);
