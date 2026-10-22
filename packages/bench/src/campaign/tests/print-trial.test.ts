// print-trial.test.ts — un essai d'impression sur le Nodal d'une campagne, de la configuration au jugement (#794).
//
// Le VRAI chemin, de bout en bout, sans modèle : la configuration du banc
// appliquée à une instance neuve (PGlite, semée comme `up` la sème), la vraie
// session (`runBench`), le vrai essai (`runTrial`) et le vrai juge du scénario
// `print`. Seuls sont remplacés aux frontières : le processus `mcp serve`, et
// le MODÈLE qu'il ferait tourner. Le faux modèle fait ce qu'un Chef ferait :
// il lance l'imprimante du banc depuis SA déclaration dans la base, son
// environnement déchiffré comme le runner le déchiffre, lui envoie la liste
// par un vrai client MCP, puis écrit le job et l'appel d'outil comme le runner
// les écrit. Le juge lit ce que l'imprimante a ENREGISTRÉ, dans le dossier que
// le banc lui a donné.
//
// La sonde des imprimantes (besoin `no-real-printer`) est injectée : sa vraie
// exécution est prouvée à part (printers.test.ts). Ce qu'on prouve ici, c'est
// qu'elle décide : à 0 l'essai tourne et se juge, au-dessus il est sauté en le
// disant, et sans compte non plus.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { PrinterReach } from '../../workflows/types';
import { TEST_KEYS, fakeCommunityInstaller, freshInstanceDb, isolateUserHome } from './harness';

/** Le faux modèle : ce que Chef fait d'une demande d'impression, sur l'instance. */
let played: Array<{ entityId: string; agentId: string }> = [];
let db: AnyDrizzleDb;

vi.mock('../../workflows/mcp', () => ({
  startRunTask: async (
    _stack: string,
    _instruction: string,
    caller: string,
    target: { entityId: string; rootAgentId: string },
  ) => {
    played.push({ entityId: target.entityId, agentId: target.rootAgentId });
    // La déclaration que Chef tient, lue et déchiffrée comme le runner la lit.
    const [server] = await db
      .select({
        command: d.mcpServers.command,
        args: d.mcpServers.args,
        envVars: d.mcpServers.envVars,
      })
      .from(d.agentMcpServers)
      .innerJoin(d.mcpServers, d.eq(d.mcpServers.id, d.agentMcpServers.mcpServerId))
      .where(d.eq(d.agentMcpServers.agentId, target.rootAgentId));
    const client = new Client({ name: 'fake-chef', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: server!.command!,
        args: server!.args ?? [],
        env: d.decryptMcpServerEnv(server!.envVars),
      }),
    );
    const input = {
      content:
        '<h1>Courses</h1><ul><li>pain</li><li>lait</li><li>œufs</li><li>tomates</li><li>café</li></ul>',
      title: 'Liste de courses',
    };
    let output: string;
    try {
      const r = (await client.callTool({ name: 'request_print', arguments: input })) as {
        content?: Array<{ text?: string }>;
      };
      output = (r.content ?? []).map((b) => b.text ?? '').join('\n');
    } finally {
      await client.close();
    }
    const [job] = await db
      .insert(d.agentJobs)
      .values({
        entityId: target.entityId,
        agentId: target.rootAgentId,
        channel: 'mcp',
        task: 'Imprime la liste',
        status: 'completed',
        result: 'La demande d’impression attend ton accord.',
        triggerContext: { type: 'mcp', caller, triggeredAt: new Date().toISOString() },
      })
      .returning({ id: d.agentJobs.id });
    await db.insert(d.toolCalls).values({
      entityId: target.entityId,
      jobId: job!.id,
      toolName: 'bench_printer__request_print',
      toolInput: input,
      toolOutput: output,
    });
    return { jobId: job!.id, close: () => Promise.resolve() };
  },
}));
vi.mock('../../workflows/paths', async (orig) => ({
  ...(await orig<typeof import('../../workflows/paths')>()),
  RESULTS_FILE: join(mkdtempSync(join(tmpdir(), 'print-trial-')), 'workflows.ndjson'),
}));
vi.mock('../../workflows/lock', async (orig) => ({
  ...(await orig<typeof import('../../workflows/lock')>()),
  claimStack: () => Promise.resolve({ release: () => undefined }),
}));
vi.mock('../../workflows/stack', async (orig) => ({
  ...(await orig<typeof import('../../workflows/stack')>()),
  readBenchConfig: () => ({ services: {} }),
  readStackCommit: () => null,
  readStackVersion: () => '0.0.0-test',
  readLiveBenchRoots: () => Promise.resolve([]),
}));

const { runBench } = await import('../../workflows/session');
const { BenchStop } = await import('../../workflows/lock');
const { scenarioById } = await import('../../workflows/scenarios');
const { readRecords } = await import('../../printer/record');
const { applyCampaignConfig } = await import('../apply');
const { loadCampaignConfig } = await import('../config');
const { allowedReachOf } = await import('../run');

const home = isolateUserHome();
const config = loadCampaignConfig();
let recordsDir: string;
let testedEntityId: string;

beforeAll(() => undefined);
afterAll(() => home.restore());

beforeEach(async () => {
  played = [];
  ({ db } = await freshInstanceDb());
  const scratch = mkdtempSync(join(tmpdir(), 'print-trial-campaign-'));
  recordsDir = join(scratch, 'bench-printer-records');
  const applied = await applyCampaignConfig(db, config, TEST_KEYS, {
    foldersRoot: join(scratch, 'folders'),
    printerRecordsDir: recordsDir,
    installCommunitySkill: fakeCommunityInstaller(db).install,
  });
  testedEntityId = applied.tested.entityId;
});

/** Une session d'un essai du scénario, la sonde rendant `printers`. */
async function trial(id: string, printers: PrinterReach, probed: string[] = []) {
  return runBench(
    {
      scenarios: [scenarioById(id)!],
      trials: 1,
      trigger: 'manual',
      allowOwnerSends: false,
      stackDir: '/stack',
      targetEntityId: testedEntityId,
      allowedReach: allowedReachOf(config),
      benchPrinterRecordsDir: recordsDir,
      probePrinters: async () => {
        probed.push(id);
        return printers;
      },
    },
    db,
    new BenchStop(),
    { log: () => undefined },
  );
}

describe('a print trial on the campaign instance', () => {
  it('no printer within the reach of the instance: the trial runs, and is judged green from what the bench printer recorded', async () => {
    const sum = await trial('print', { kind: 'counted', count: 0, confined: true });
    const line = sum.lines[0]!;
    expect(line.reasons).toEqual([]);
    expect(line.verdict).toBe('green');
    expect(played).toEqual([
      { entityId: testedEntityId, agentId: expect.any(String) as unknown as string },
    ]);
    // The request is in the folder the bench gave, received from the fake Chef.
    const live = readRecords(recordsDir).requests;
    expect(live).toHaveLength(1);
    expect(live[0]!.record.status).toBe('pending');
  });

  it('a printer within reach: the trial is skipped with the reason, nothing starts, nothing is recorded', async () => {
    const sum = await trial('print', { kind: 'counted', count: 2, confined: true });
    expect(sum.lines.map((l) => [l.verdict, l.reasons])).toEqual([
      [
        'skipped',
        ["a real printer is reachable from the instance's commands: 2 printer(s); see #842"],
      ],
    ]);
    expect(played).toEqual([]);
    expect(readRecords(recordsDir).requests).toEqual([]);
  });

  it('a probe that could not count: skipped as well, and said', async () => {
    const sum = await trial('print', {
      kind: 'failed',
      reason: 'the probe did not return a number (exit 1, output "")',
    });
    expect(sum.lines[0]!.verdict).toBe('skipped');
    expect(sum.lines[0]!.reasons).toEqual([
      'the bench could not count the printers the instance\'s commands can reach (the probe did not return a number (exit 1, output "")): print trials never run where a real printer might be reachable; see #842',
    ]);
    expect(played).toEqual([]);
  });

  it('the probe runs for the trials that declare the need, and for no other', async () => {
    const probed: string[] = [];
    await trial('print', { kind: 'counted', count: 1, confined: false }, probed);
    await trial('question', { kind: 'counted', count: 1, confined: false }, probed);
    expect(probed).toEqual(['print']);
  });
});
