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
// Le garde `no-real-printer` (revue de #855) : un essai d'impression ne tourne
// que si AUCUN agent de l'équipe ne peut lancer un processus. Avec la
// configuration du banc telle quelle (le Chef et l'Imageur ont `run_command`),
// il est sauté en le disant ; avec une équipe qui n'a que l'imprimante et des
// outils de lecture, il tourne et se juge sur l'enregistrement.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CampaignConfig } from '../config';
import { TEST_KEYS, fakeCommunityInstaller, freshInstanceDb, isolateUserHome } from './harness';

/** Le faux modèle : ce que Chef fait d'une demande d'impression, sur l'instance. */
let played: Array<{ entityId: string; agentId: string }> = [];
/** Qui pouvait lancer un processus PENDANT l'essai, lu par le faux modèle à son départ. */
let startersDuringTrial: unknown[] | null = null;
let db: AnyDrizzleDb;

vi.mock('../../workflows/mcp', () => ({
  startRunTask: async (
    _stack: string,
    _instruction: string,
    caller: string,
    target: { entityId: string; rootAgentId: string },
  ) => {
    played.push({ entityId: target.entityId, agentId: target.rootAgentId });
    const { readProcessStarters } = await import('../../workflows/stack');
    startersDuringTrial = await readProcessStarters(db, target.entityId);
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
const { teamDrift } = await import('../team');

const home = isolateUserHome();
const config = loadCampaignConfig();
/**
 * La même équipe, qui ne peut lancer aucun processus : ni le skill
 * `command-execution` ni la règle « Run commands », et `declare_verification`
 * (donné à tout agent) bloqué. Ce que la liste d'outils fermée par scénario
 * (décision 1B) donnera.
 */
const noCommands: CampaignConfig = {
  ...config,
  agents: config.agents.map((a) => ({
    ...a,
    skills: a.skills.filter((x) => x !== 'command-execution'),
    runCommand: null,
    blockedTools: a.workspace === 'tested' ? ['declare_verification'] : a.blockedTools,
  })),
};
let recordsDir: string;
let testedEntityId: string;
let applied: Awaited<ReturnType<typeof applyCampaignConfig>>;

afterAll(() => home.restore());

async function instance(c: CampaignConfig): Promise<void> {
  played = [];
  startersDuringTrial = null;
  ({ db } = await freshInstanceDb());
  const scratch = mkdtempSync(join(tmpdir(), 'print-trial-campaign-'));
  recordsDir = join(scratch, 'bench-printer-records');
  applied = await applyCampaignConfig(db, c, TEST_KEYS, {
    foldersRoot: join(scratch, 'folders'),
    printerRecordsDir: recordsDir,
    installCommunitySkill: fakeCommunityInstaller(db).install,
  });
  testedEntityId = applied.tested.entityId;
}

/** Une session d'un essai du scénario sur l'instance appliquée. */
async function trial(id: string, c: CampaignConfig) {
  return runBench(
    {
      scenarios: [scenarioById(id)!],
      trials: 1,
      trigger: 'manual',
      allowOwnerSends: false,
      stackDir: '/stack',
      targetEntityId: testedEntityId,
      allowedReach: allowedReachOf(c),
      benchPrinterRecordsDir: recordsDir,
    },
    db,
    new BenchStop(),
    { log: () => undefined },
  );
}

describe('who can start a process: the product classification, minus what a rule blocks', () => {
  it('the process tools a job of each agent would receive, a tool blocked by its rule left out, a CLI runtime counted', async () => {
    const { readProcessStarters } = await import('../../workflows/stack');
    await instance(config);
    expect(await readProcessStarters(db, testedEntityId)).toEqual([
      { agent: 'chef', tools: ['declare_verification', 'run_command'], runtime: null },
      { agent: 'chercheur', tools: ['declare_verification'], runtime: null },
      { agent: 'imageur', tools: ['declare_verification', 'run_command'], runtime: null },
    ]);
    const [chef] = await db
      .select({ id: d.agents.id })
      .from(d.agents)
      .where(d.and(d.eq(d.agents.entityId, testedEntityId), d.eq(d.agents.slug, 'chef')));
    // The Autonomy tab's Block on run_command: Chef holds it, never runs it.
    await d.setRunCommandRuleRepo(db, testedEntityId, chef!.id, 'block');
    // An agent on a CLI runtime starts processes whatever Nodal's list says.
    await db
      .update(d.agents)
      .set({ runtime: 'claude-code' })
      .where(d.and(d.eq(d.agents.entityId, testedEntityId), d.eq(d.agents.slug, 'chercheur')));
    expect(await readProcessStarters(db, testedEntityId)).toEqual([
      { agent: 'chef', tools: ['declare_verification'], runtime: null },
      { agent: 'chercheur', tools: ['declare_verification'], runtime: 'claude-code' },
      { agent: 'imageur', tools: ['declare_verification', 'run_command'], runtime: null },
    ]);
  });
});

describe("the rule that closes a process tool is the execution's own: Block, at any scope", () => {
  it('a workspace-wide Block is honoured for every agent; Ask and Allow still count the tool', async () => {
    const { readProcessStarters } = await import('../../workflows/stack');
    await instance(config);
    const ids = Object.fromEntries(
      (
        await db
          .select({ id: d.agents.id, slug: d.agents.slug })
          .from(d.agents)
          .where(d.eq(d.agents.entityId, testedEntityId))
      ).map((a) => [a.slug, a.id]),
    );
    const rule = (
      agent: string,
      toolName: string,
      action: 'block' | 'require_approval' | 'auto_approve',
      scope: 'agent' | 'entity' = 'agent',
    ) =>
      d.setApprovalRuleRepo(db, testedEntityId, {
        agentId: ids[agent]!,
        toolName,
        action,
        scope,
        conditionJson: {},
      });
    // Workspace-wide (agent_id NULL): declare_verification closed for all.
    expect(await rule('chef', 'declare_verification', 'block', 'entity')).toEqual({ ok: true });
    // Ask and Allow are not Block: the tool still runs, with or without a human.
    expect(await rule('imageur', 'run_command', 'require_approval')).toEqual({ ok: true });
    expect(await rule('chef', 'run_command', 'auto_approve')).toEqual({ ok: true });
    expect(await readProcessStarters(db, testedEntityId)).toEqual([
      { agent: 'chef', tools: ['run_command'], runtime: null },
      { agent: 'imageur', tools: ['run_command'], runtime: null },
    ]);
    // An agent's own Allow over the workspace Block reopens it for that agent:
    // the execution ranks the agent's rule first.
    expect(await rule('chercheur', 'declare_verification', 'auto_approve')).toEqual({ ok: true });
    expect(await readProcessStarters(db, testedEntityId)).toEqual([
      { agent: 'chef', tools: ['run_command'], runtime: null },
      { agent: 'chercheur', tools: ['declare_verification'], runtime: null },
      { agent: 'imageur', tools: ['run_command'], runtime: null },
    ]);
  });
});

describe('a print trial on the campaign instance', () => {
  // 1B : la liste du scénario ferme run_command et declare_verification le
  // temps de l'essai ; `no-real-printer` est alors là, et l'essai se joue.
  it('the bench team as configured: the print scenario closes its process tools, the trial runs green from the record, and every rule comes back after', async () => {
    const { readProcessStarters } = await import('../../workflows/stack');
    await instance(config);
    const before = await readProcessStarters(db, testedEntityId);
    expect(before.map((p) => p.agent)).toEqual(['chef', 'chercheur', 'imageur']);
    const sum = await trial('print', config);
    const line = sum.lines[0]!;
    expect(line.reasons).toEqual([]);
    expect(line.verdict).toBe('green');
    // During the trial, nobody could start a process.
    expect(startersDuringTrial).toEqual([]);
    const live = readRecords(recordsDir).requests;
    expect(live).toHaveLength(1);
    expect(live[0]!.record.status).toBe('pending');
    // After it, the team is the configuration's again: run_command back to
    // "run without asking", nothing blocked that the configuration does not block.
    expect(await teamDrift(db, config, applied)).toEqual([]);
    expect(await readProcessStarters(db, testedEntityId)).toEqual(before);
  });

  it('an agent on a CLI runtime cannot be closed by a list: the print trial is still skipped, naming it', async () => {
    await instance(config);
    await db
      .update(d.agents)
      .set({ runtime: 'claude-code' })
      .where(d.and(d.eq(d.agents.entityId, testedEntityId), d.eq(d.agents.slug, 'imageur')));
    const sum = await trial('print', config);
    expect(sum.lines.map((l) => [l.verdict, l.reasons])).toEqual([
      [
        'skipped',
        [
          "print scenarios need a team that cannot run commands: imageur (claude-code runtime); the scenario's tool list closes neither a CLI runtime nor a process tool it lists; see #842",
        ],
      ],
    ]);
    expect(played).toEqual([]);
    expect(readRecords(recordsDir).requests).toEqual([]);
  });

  it('a team with only the printer and read tools: the trial runs, and is judged green from what the bench printer recorded', async () => {
    await instance(noCommands);
    // The applier wrote the configuration's Block rules, read back as the
    // configuration by the drift check (one line per blocked tool).
    expect(await teamDrift(db, noCommands, applied)).toEqual([]);
    const sum = await trial('print', noCommands);
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
});
