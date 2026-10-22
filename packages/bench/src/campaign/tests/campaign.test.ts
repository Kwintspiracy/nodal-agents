// campaign.test.ts — une campagne entière : remise à zéro avant chaque essai, preuves exportées, plafond tenu, rien ne reste.
//
// Aux frontières seulement, des faux : le CLI de Nodal (un vrai processus
// d'écoute, harness.ts), la base de l'instance (PGlite, semée comme `up` la
// sème), la route d'installation des skills communautaires, et la session
// d'essais, remplacée par une qui « joue » chaque essai en écrivant ce qu'un
// vrai run écrit (un souvenir, un job et son coût, un fichier) et en
// observant l'état AU DÉPART de chaque essai. Aucun modèle n'est appelé.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { readNodalInstances } from '@nodal-agents/shared/nodal-instances';
import { SHARED_WORKSPACE_LABEL } from '@nodal-agents/tools';
import type { BenchRun, SessionHooks, SessionSummary } from '../../workflows/session';
import type { TreeFacts } from '../../workflows/facts';
import type { AnyScenario, TrialLine } from '../../workflows/types';
import { loadCampaignConfig, type CampaignConfig } from '../config';
import { campaignHome } from '../home';
import { isInside } from '../keys';
import { runCampaign, type CampaignDeps } from '../run';
import {
  TEST_KEYS,
  dead,
  fakeCli,
  fakeCommunityInstaller,
  freePorts,
  freshInstanceDb,
  isolateUserHome,
} from './harness';

const home = isolateUserHome();
const userHome = home.userHome;
const stackDir = mkdtempSync(join(tmpdir(), 'bench-campaign-checkout-'));
const evidenceRoot = mkdtempSync(join(tmpdir(), 'bench-campaign-evidence-'));
const workspacesRoot = mkdtempSync(join(tmpdir(), 'bench-campaign-ws-'));
const spawned: number[] = [];

afterAll(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid);
    } catch {
      /* déjà mort */
    }
  }
  for (const dir of [stackDir, evidenceRoot, workspacesRoot])
    rmSync(dir, { recursive: true, force: true });
  home.restore();
});

const scenario = (id: string): AnyScenario =>
  ({ id, version: 1, activity: 'question' }) as unknown as AnyScenario;

/** Ce qu'un essai a trouvé en partant : la preuve que la remise à zéro a eu lieu, ou pas. */
interface Seen {
  scenario: string;
  memories: number;
  jobs: number;
  sharedFiles: string[];
  runBudgetUsd: number;
  treeCapUsd: number | undefined;
}

/**
 * La session d'essais, jouée sans modèle : avant chaque essai, `beforeTrial`
 * (la campagne), puis l'état observé, puis ce que le run écrit, puis
 * `afterTrial`. Elle honore `stop` comme la vraie.
 */
function fakeSession(costs: number[], seen: Seen[], runs: BenchRun[]) {
  return async (
    run: BenchRun,
    db: AnyDrizzleDb,
    _stop: unknown,
    hooks: SessionHooks,
  ): Promise<SessionSummary> => {
    runs.push(run);
    const lines: TrialLine[] = [];
    let i = 0;
    for (const s of run.scenarios) {
      i++;
      await hooks.beforeTrial!(s, i);
      const sharedDir = join(workspacesRoot, run.targetEntityId!, SHARED_WORKSPACE_LABEL);
      const [m] = await db.select({ n: d.count() }).from(d.agentMemory);
      const [j] = await db.select({ n: d.count() }).from(d.agentJobs);
      const [ent] = await db
        .select({ cap: d.entities.maxRunCostUsd })
        .from(d.entities)
        .where(d.eq(d.entities.id, run.targetEntityId!));
      seen.push({
        scenario: s.id,
        memories: Number(m!.n),
        jobs: Number(j!.n),
        sharedFiles: existsSync(sharedDir) ? readdirSync(sharedDir) : [],
        runBudgetUsd: ent!.cap,
        treeCapUsd: run.maxTreeCostUsd?.(),
      });
      // Le run : un souvenir, un job facturé, un livrable.
      const [root] = await db
        .select({ id: d.entities.rootAgentId })
        .from(d.entities)
        .where(d.eq(d.entities.id, run.targetEntityId!));
      await db
        .insert(d.agentMemory)
        .values({ entityId: run.targetEntityId!, agentId: root!.id, fact: `remember ${s.id}` });
      const [job] = await db
        .insert(d.agentJobs)
        .values({
          entityId: run.targetEntityId!,
          agentId: root!.id!,
          channel: 'mcp',
          task: s.id,
          status: 'completed',
        })
        .returning({ id: d.agentJobs.id });
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, `${s.id}.txt`), s.id);
      const line = {
        scenario: s.id,
        verdict: 'green',
        reasons: [],
        costUsd: costs[i - 1] ?? 0,
        llmCalls: 1,
        cliRuns: 0,
        rootJobId: job!.id,
        campaign: run.campaign,
        configFingerprint: run.configFingerprint,
        modelUnderTest: run.modelUnderTest,
      } as unknown as TrialLine;
      lines.push(line);
      if ((await hooks.afterTrial!(s, i, line)) === 'stop') break;
    }
    return { lines, failed: 0, skipped: 0 };
  };
}

let db: AnyDrizzleDb;
beforeEach(async () => {
  ({ db } = await freshInstanceDb());
});

async function deps(
  over: Partial<CampaignDeps> & Pick<CampaignDeps, 'runBench'>,
): Promise<CampaignDeps> {
  return {
    cli: fakeCli(userHome, spawned),
    baseEnv: { PATH: process.env['PATH'] ?? '', LLM_API_KEY: 'sk-owner' },
    userHome,
    log: () => undefined,
    quietWaitMs: 3_000,
    openDb: async () => ({ db, close: async () => undefined }),
    readFacts: async (_db, rootJobId) =>
      ({ rootId: rootJobId, jobs: [], toolCalls: [] }) as unknown as TreeFacts,
    folders: { workspacesRoot, sharedLabel: SHARED_WORKSPACE_LABEL },
    evidenceRoot,
    installCommunitySkill: () => fakeCommunityInstaller(db).install,
    ...over,
  };
}

async function configWith(budget: CampaignConfig['budget']): Promise<CampaignConfig> {
  const c = loadCampaignConfig();
  return { ...c, budget, instance: { ports: await freePorts() } };
}

describe('a campaign, end to end, without a model', () => {
  it('resets the instance before every trial: the second one starts with no memory, no run, no file of the first', async () => {
    const seen: Seen[] = [];
    const runs: BenchRun[] = [];
    const config = await configWith({ perTrialUsd: 1, perCampaignUsd: 10 });
    const summary = await runCampaign(
      {
        id: '20261022-110000-r1r1',
        config,
        keys: TEST_KEYS,
        scenarios: [scenario('one'), scenario('two')],
        trials: 1,
        models: null,
        trigger: 'manual',
        stackDir,
      },
      await deps({ runBench: fakeSession([0.1, 0.1], seen, runs) }),
    );
    expect(seen.map((s) => [s.scenario, s.memories, s.jobs, s.sharedFiles])).toEqual([
      ['one', 0, 0, []],
      ['two', 0, 0, []],
    ]);
    expect(summary.lines.map((l) => l.scenario)).toEqual(['one', 'two']);
    // La session joue dans l'espace testé, sur l'instance, avec la portée déclarée.
    expect(runs[0]!.targetEntityId).toBe(summary.applied!.tested.entityId);
    expect(runs[0]!.campaign).toBe('20261022-110000-r1r1');
    expect(runs[0]!.configFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(runs[0]!.modelUnderTest).toBe('openrouter:anthropic/claude-haiku-5.5');
    expect(runs[0]!.allowOwnerSends).toBe(false);
    expect(runs[0]!.childEnv!['NODALAI_HOME']).toBe(campaignHome('20261022-110000-r1r1', userHome));
    expect(runs[0]!.childEnv!['LLM_API_KEY']).toBeUndefined();
    expect(runs[0]!.allowedReach!.map((r) => `${r.agent}:${r.via}`)).toEqual([
      'chercheur:tavily',
      'chercheur:firecrawl',
    ]);
  });

  it('exports each trial’s line, facts and files before the reset wipes them, and a summary at the end', async () => {
    const config = await configWith({ perTrialUsd: 1, perCampaignUsd: 10 });
    const summary = await runCampaign(
      {
        id: '20261022-110100-e1e1',
        config,
        keys: TEST_KEYS,
        scenarios: [scenario('one'), scenario('two')],
        trials: 1,
        models: null,
        trigger: 'manual',
        stackDir,
      },
      await deps({ runBench: fakeSession([0.1, 0.2], [], []) }),
    );
    const dir = summary.evidenceDir;
    expect(readdirSync(dir).sort()).toEqual([
      '001-one',
      '002-two',
      'campaign.json',
      'instance-logs',
    ]);
    // Les journaux de l'instance, effacée depuis, sont dans les preuves.
    expect(readFileSync(join(dir, 'instance-logs', 'web.log'), 'utf8')).toBe(
      'fake web: compiled\n',
    );
    expect(JSON.parse(readFileSync(join(dir, '001-one', 'line.json'), 'utf8'))).toMatchObject({
      scenario: 'one',
      costUsd: 0.1,
    });
    expect(existsSync(join(dir, '001-one', 'facts.json'))).toBe(true);
    // Le livrable du premier essai, effacé de l'instance par la remise à zéro, est dans ses preuves.
    expect(
      readFileSync(join(dir, '001-one', 'files', `1-${SHARED_WORKSPACE_LABEL}`, 'one.txt'), 'utf8'),
    ).toBe('one');
    const camp = JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(camp).toMatchObject({
      id: '20261022-110100-e1e1',
      trials: 2,
      spentUsd: 0.3,
      stopReason: null,
      error: null,
    });
  });

  it('holds the caps: each trial gets min(trial cap, what is left), and the campaign stops at its own', async () => {
    const seen: Seen[] = [];
    const config = await configWith({ perTrialUsd: 1, perCampaignUsd: 1.5 });
    const summary = await runCampaign(
      {
        id: '20261022-110200-b1b1',
        config,
        keys: TEST_KEYS,
        scenarios: [scenario('one'), scenario('two'), scenario('three')],
        trials: 1,
        models: null,
        trigger: 'manual',
        stackDir,
      },
      await deps({ runBench: fakeSession([0.9, 0.6, 0.5], seen, []) }),
    );
    expect(seen.map((s) => [s.scenario, s.runBudgetUsd, s.treeCapUsd])).toEqual([
      ['one', 1, 1],
      ['two', 0.6, 0.6],
    ]);
    expect(summary.lines.map((l) => l.scenario)).toEqual(['one', 'two']);
    expect(summary.spentUsd).toBe(1.5);
    expect(summary.stopReason).toBe('the campaign spent $1.5 of its $1.5 cap');
  });

  it('whatever happens, the instance is stopped and erased: no process, no folder, no registry entry', async () => {
    const config = await configWith({ perTrialUsd: 1, perCampaignUsd: 10 });
    const cli = fakeCli(userHome, spawned);
    const boom = async (): Promise<SessionSummary> => {
      throw new Error('the session broke');
    };
    await expect(
      runCampaign(
        {
          id: '20261022-110300-x1x1',
          config,
          keys: TEST_KEYS,
          scenarios: [scenario('one')],
          trials: 1,
          models: null,
          trigger: 'manual',
          stackDir,
        },
        await deps({ runBench: boom, cli }),
      ),
    ).rejects.toThrow(/the session broke/);
    const instanceHome = campaignHome('20261022-110300-x1x1', userHome);
    expect(cli.commands).toEqual(['up --dev', 'down', 'reset --yes']);
    expect(existsSync(instanceHome)).toBe(false);
    expect(readNodalInstances(userHome).some((r) => isInside(r.home, instanceHome))).toBe(false);
    expect(spawned.every(dead)).toBe(true);
    const camp = JSON.parse(
      readFileSync(join(evidenceRoot, '20261022-110300-x1x1', 'campaign.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(camp['error']).toBe('the session broke');
  });
});
