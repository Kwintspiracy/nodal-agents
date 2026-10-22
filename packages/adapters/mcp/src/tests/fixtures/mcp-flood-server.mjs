// mcp-flood-server.mjs — a stdio MCP server that answers its `flood` tool with
// ONE message larger than the SDK's read-buffer ceiling (10 MB), never ended
// by a newline: the shape of a runaway or hostile server (SDK >= 1.32 bounds
// the buffer; the transport must close the connection, not crash the runner).
//
// Speaks raw JSON-RPC lines so the test depends on nothing but the wire:
//   argv[2]  the file that receives this server's pid
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

writeFileSync(process.argv[2], String(process.pid));
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
    reply(msg.id, { tools: [{ name: 'flood', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    process.stdout.write('x'.repeat(11 * 1024 * 1024));
  }
});
// The pipe may close under the flood; the test reads the outcome on the client side.
process.stdout.on('error', () => {});
setInterval(() => {}, 1000);
