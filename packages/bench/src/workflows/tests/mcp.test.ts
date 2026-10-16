// mcp.test.ts — chaque run_task du banc vise l'agent que la session a résolu, et lui seul.
//
// Le VRAI startRunTask démarre un vrai processus MCP par le vrai transport
// stdio (un serveur de test, fixtures/fake-mcp-serve.mjs, à la place de
// `nodal-agents mcp serve`) : ce test prouve ce qui arrive réellement de
// l'autre côté, l'épinglage dans l'environnement du serveur et l'agent nommé
// dans l'appel, pas ce qu'une fonction intermédiaire rendrait.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_PINNED_AGENT_ENV, runTaskEnv, startRunTask } from '../mcp';

const FAKE = join(__dirname, 'fixtures', 'fake-mcp-serve.mjs');
const BENCH_ROOT = { rootAgentId: 'aaaaaaaa-0000-5000-8000-000000000001', rootAgentSlug: 'alfred' };

let out: string;
const saved = new Map<string, string | undefined>();
function setEnv(k: string, v: string | undefined): void {
  if (!saved.has(k)) saved.set(k, process.env[k]);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
beforeEach(() => {
  out = join(mkdtempSync(join(tmpdir(), 'bench-mcp-')), 'seen.json');
  setEnv('BENCH_FAKE_MCP_OUT', out);
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

async function call(): Promise<{ pinned: Array<[string, string]>; args: Record<string, unknown> }> {
  const session = await startRunTask(
    '/unused',
    'Quelle est la capitale ?',
    'nodal-bench/question',
    BENCH_ROOT,
    {
      command: process.execPath,
      args: [FAKE],
      cwd: __dirname,
    },
  );
  expect(session.jobId).toBe('11111111-1111-4111-8111-111111111111');
  await session.close();
  return JSON.parse(readFileSync(out, 'utf8')) as {
    pinned: Array<[string, string]>;
    args: Record<string, unknown>;
  };
}

describe('startRunTask targets the resolved agent, through the real MCP transport', () => {
  it('the server is pinned to the bench root, and run_task names it explicitly', async () => {
    setEnv(MCP_PINNED_AGENT_ENV, undefined);
    const seen = await call();
    expect(seen.pinned).toEqual([[MCP_PINNED_AGENT_ENV, BENCH_ROOT.rootAgentId]]);
    expect(seen.args).toEqual({
      instruction: 'Quelle est la capitale ?',
      caller: 'nodal-bench/question',
      agent: 'alfred',
    });
  });

  it('an agent inherited from the shell never reaches the server, whatever its case', async () => {
    // Sous Windows, process.env ne distingue pas la casse : `nodal_mcp_agent_id`
    // EST la variable que `mcp serve` lirait. Sous Linux, ce sont deux clés,
    // et aucune ne doit passer.
    setEnv(MCP_PINNED_AGENT_ENV, 'owner-agent-upper');
    setEnv('nodal_mcp_agent_id', 'owner-agent-lower');
    setEnv('Nodal_Mcp_Agent_Id', 'owner-agent-mixed');
    const seen = await call();
    expect(seen.pinned).toEqual([[MCP_PINNED_AGENT_ENV, BENCH_ROOT.rootAgentId]]);
  });
});

describe('runTaskEnv', () => {
  it('drops every case variant and sets only the target agent, keeping the rest', () => {
    expect(
      runTaskEnv(
        {
          PATH: '/bin',
          NODAL_MCP_AGENT_ID: 'a',
          nodal_mcp_agent_id: 'b',
          Nodal_MCP_Agent_ID: 'c',
          EMPTY: undefined,
        },
        'target',
      ),
    ).toEqual({ PATH: '/bin', NODAL_MCP_AGENT_ID: 'target' });
  });
});
