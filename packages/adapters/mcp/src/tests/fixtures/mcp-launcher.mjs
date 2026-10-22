// mcp-launcher.mjs — an INTERMEDIARY in front of a real MCP server, the way
// `npx` (a `.cmd` on Windows: cmd.exe, then npx-cli, then the server's node)
// or `uvx` stand in front of most of them (#750).
//
// It starts the fixture server as its child, sharing its own stdin/stdout (the
// server speaks to Nodal through it), and stays alive as long as the server
// does. The server, in turn, has a background helper DETACHED from it, the way
// a server that starts a worker would. Both pids are written down:
//   argv[2]  the file that receives the server's pid
//   argv[3]  the file that receives the helper's pid
// What Nodal holds directly is only this launcher.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('./mcp-stdio-server.mjs', import.meta.url));
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
});
helper.unref();
writeFileSync(process.argv[3], String(helper.pid));
const child = spawn(process.execPath, [server], { stdio: 'inherit' });
writeFileSync(process.argv[2], String(child.pid));
child.on('exit', (code) => process.exit(code ?? 0));
