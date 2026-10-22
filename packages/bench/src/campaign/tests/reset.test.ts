// reset.test.ts — un essai qui écrit un souvenir, un run et des fichiers ne laisse rien au suivant.
//
// Sur un vrai schéma (PGlite) : l'essai « joue » en écrivant ce qu'un vrai run
// écrit (un souvenir, un job terminé et son appel d'outil, une tâche, un
// projet, un fichier dans le dossier partagé et un dans le coffre), puis la
// remise à zéro passe. Le suivant retrouve l'état de départ, relu en base et
// sur le disque. Une équipe modifiée, ou un job vivant, arrête tout en le disant.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { SHARED_WORKSPACE_LABEL } from '@nodal-agents/tools';
import { applyCampaignConfig, type AppliedCampaign } from '../apply';
import { loadCampaignConfig } from '../config';
import { campaignFolders, resetBetweenTrials, type ResetDeps } from '../reset';
import { TEST_KEYS, fakeCommunityInstaller, freshInstanceDb, isolateUserHome } from './harness';

const home = isolateUserHome();
const config = loadCampaignConfig();
const scratch = mkdtempSync(join(tmpdir(), 'bench-campaign-reset-'));
const deps: ResetDeps = {
  workspacesRoot: join(scratch, 'workspaces'),
  sharedLabel: SHARED_WORKSPACE_LABEL,
};
let db: AnyDrizzleDb;
let applied: AppliedCampaign;

beforeAll(async () => {
  ({ db } = await freshInstanceDb());
  applied = await applyCampaignConfig(db, config, TEST_KEYS, {
    foldersRoot: join(scratch, 'folders'),
    installCommunitySkill: fakeCommunityInstaller(db).install,
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  home.restore();
});

const shared = (): string =>
  join(deps.workspacesRoot, applied.tested.entityId, SHARED_WORKSPACE_LABEL);
const vault = (): string => applied.folders.find((f) => f.seed === 'obsidian-vault')!.path;

/** Ce qu'un run laisse derrière lui, écrit comme le runner l'écrit. */
async function playATrial(tag: string): Promise<void> {
  const chef = applied.agents['chef']!.id;
  const chercheur = applied.agents['chercheur']!.id;
  await db.insert(d.agentMemory).values({
    entityId: applied.tested.entityId,
    agentId: chercheur,
    fact: `the user prefers ${tag}`,
  });
  const [job] = await db
    .insert(d.agentJobs)
    .values({
      entityId: applied.tested.entityId,
      agentId: chef,
      channel: 'mcp',
      task: `trial ${tag}`,
      status: 'completed',
    })
    .returning({ id: d.agentJobs.id });
  await db.insert(d.toolCalls).values({ jobId: job!.id, toolName: 'file_write' });
  await db
    .insert(d.agentTasks)
    .values({ entityId: applied.tested.entityId, orchestratorId: chef, title: `task ${tag}` });
  mkdirSync(join(shared(), 'nodal-bench'), { recursive: true });
  writeFileSync(join(shared(), 'nodal-bench', `${tag}.xlsx`), 'x');
  writeFileSync(join(vault(), `${tag}.md`), '# note');
}

async function counts(): Promise<{
  memories: number;
  jobs: number;
  toolCalls: number;
  tasks: number;
}> {
  const [m] = await db.select({ n: d.count() }).from(d.agentMemory);
  const [j] = await db.select({ n: d.count() }).from(d.agentJobs);
  const [t] = await db.select({ n: d.count() }).from(d.toolCalls);
  const [k] = await db.select({ n: d.count() }).from(d.agentTasks);
  return {
    memories: Number(m!.n),
    jobs: Number(j!.n),
    toolCalls: Number(t!.n),
    tasks: Number(k!.n),
  };
}

describe('between two trials, the instance goes back to its starting state', () => {
  it('the first reset lays the folders out: an empty shared folder, a vault with its .obsidian/', async () => {
    await resetBetweenTrials(db, config, applied, deps);
    expect(readdirSync(shared())).toEqual([]);
    expect(readdirSync(vault())).toEqual(['.obsidian']);
  });

  it('a trial that writes a memory, a run and files leaves nothing for the next', async () => {
    await playATrial('trial-1');
    expect(await counts()).toEqual({ memories: 1, jobs: 1, toolCalls: 1, tasks: 1 });

    const report = await resetBetweenTrials(db, config, applied, deps);
    expect(report.memories).toBe(1);
    expect(report.runs).toBe(1);
    expect(await counts()).toEqual({ memories: 0, jobs: 0, toolCalls: 0, tasks: 0 });
    expect(readdirSync(shared())).toEqual([]);
    expect(readdirSync(vault())).toEqual(['.obsidian']);
    expect(report.folders).toEqual(campaignFolders(applied, deps).map((f) => f.path));

    // L'essai suivant écrit les siens, et seulement les siens.
    await playATrial('trial-2');
    const facts = await db.select({ fact: d.agentMemory.fact }).from(d.agentMemory);
    expect(facts).toEqual([{ fact: 'the user prefers trial-2' }]);
    expect(readdirSync(join(shared(), 'nodal-bench'))).toEqual(['trial-2.xlsx']);
    expect(readdirSync(vault()).sort()).toEqual(['.obsidian', 'trial-2.md']);
    await resetBetweenTrials(db, config, applied, deps);
  });

  it('the team is left as configured, and the reset leaves it unchanged', async () => {
    const before = await db.select().from(d.agents).orderBy(d.agents.slug);
    await resetBetweenTrials(db, config, applied, deps);
    const after = await db.select().from(d.agents).orderBy(d.agents.slug);
    expect(after.map((a) => [a.slug, a.personality, a.model, a.llmKeyId])).toEqual(
      before.map((a) => [a.slug, a.personality, a.model, a.llmKeyId]),
    );
  });

  it('a team that changed during a trial stops the campaign, naming the change, and is not rewritten', async () => {
    const chef = applied.agents['chef']!.id;
    await db
      .update(d.agents)
      .set({ personality: 'Changed mid-trial.' })
      .where(d.eq(d.agents.id, chef));
    try {
      await expect(resetBetweenTrials(db, config, applied, deps)).rejects.toThrow(
        /campaign_team_drift: .*\n  - Banc:chef personality is "Changed mid-trial\.", not/,
      );
      const [row] = await db
        .select({ p: d.agents.personality })
        .from(d.agents)
        .where(d.eq(d.agents.id, chef));
      expect(row!.p).toBe('Changed mid-trial.');
    } finally {
      await db
        .update(d.agents)
        .set({ personality: config.agents.find((a) => a.slug === 'chef')!.personality })
        .where(d.eq(d.agents.id, chef));
    }
  });

  it('a run still live refuses the reset, and leaves its memory and files where they are', async () => {
    await playATrial('live');
    const [live] = await db
      .insert(d.agentJobs)
      .values({
        entityId: applied.tested.entityId,
        agentId: applied.agents['chef']!.id,
        channel: 'mcp',
        task: 'still running',
        status: 'processing',
      })
      .returning({ id: d.agentJobs.id });
    await expect(resetBetweenTrials(db, config, applied, deps)).rejects.toThrow(
      /bench_space_busy: 1 job\(s\)/,
    );
    expect((await counts()).memories).toBe(1);
    expect(existsSync(join(vault(), 'live.md'))).toBe(true);
    await db.update(d.agentJobs).set({ status: 'cancelled' }).where(d.eq(d.agentJobs.id, live!.id));
    await resetBetweenTrials(db, config, applied, deps);
    expect(await counts()).toEqual({ memories: 0, jobs: 0, toolCalls: 0, tasks: 0 });
  });
});
