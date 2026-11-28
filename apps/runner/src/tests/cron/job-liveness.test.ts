// job-liveness.test.ts — un job est déclaré mort sur QUI le tient, jamais sur
// l'âge d'une date (#1204). Sur de vraies lignes.
//
// Chaque cas pose des lignes `agent_jobs` et `runner_instances`, fait passer
// les faucheurs avec une présence injectée (l'identité de l'instance qui
// observe, les runs qu'elle exécute, son horloge monotone) et lit ce que les
// lignes disent après.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agentJobs,
  agentTasks,
  agents,
  approvalRequests,
  runnerInstances,
} from '@nodal-agents/db';
import type { SweeperObservation } from '@nodal-agents/db';
import { reclaimJobsOfDeadRunners, RUNNER_RESTARTED_CODE } from '../../cron/reclaim-jobs.ts';
import {
  failStalePendingJobs,
  findPendingJobsToRecover,
  resetOrphanedJobs,
} from '../../cron/reset-orphans.ts';
import { BeatRecord, JOB_LIVENESS, createPresence } from '../../job/liveness.ts';
import type { Presence } from '../../job/liveness.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  // Chaque cas part d'une table de jobs vide : les faucheurs regardent TOUTES
  // les lignes d'un statut, et un cas ne doit pas lire celles d'un autre.
  await db.delete(approvalRequests);
  await db.delete(agentTasks);
  await db.update(agentJobs).set({ parentJobId: null });
  await db.delete(agentJobs);
  await db.delete(runnerInstances);
});

/** Une instance de runner, son dernier battement posé où on veut. */
async function instance(opts: { vueIlYa: number; arreteeIlYa?: number }): Promise<string> {
  const id = randomUUID();
  await db.insert(runnerInstances).values({
    id,
    host: 'test-host',
    pid: 4242,
    lastSeenAt: new Date(Date.now() - opts.vueIlYa),
    ...(opts.arreteeIlYa !== undefined
      ? { stoppedAt: new Date(Date.now() - opts.arreteeIlYa) }
      : {}),
  });
  return id;
}

/**
 * L'instance qui observe : son identité, les jobs qu'un de ses runs exécute,
 * son horloge monotone (`mono.t`), et depuis combien de temps elle bat sans
 * trou (sur l'horloge de la base, ici celle du processus de test).
 */
function observatrice(opts: { tient?: string[]; presenteDepuisMs?: number; id?: string } = {}) {
  const beats = new BeatRecord();
  if (opts.presenteDepuisMs !== undefined) {
    const maintenant = Date.now();
    for (let t = maintenant - opts.presenteDepuisMs; t < maintenant; t += 60_000) {
      beats.record(new Date(t));
    }
    beats.record(new Date(maintenant));
  }
  const tenus = new Set(opts.tient ?? []);
  const mono = { t: 1_000_000 };
  const presence: Presence = createPresence({
    instanceId: opts.id ?? randomUUID(),
    holds: (id) => tenus.has(id),
    monotonicNow: () => mono.t,
    beats,
  });
  return { presence, mono, tenus };
}

async function insertJob(values: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Relis la PR',
      status: 'pending',
      messages: [],
      chainCount: 0,
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function ligne(jobId: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      error: agentJobs.error,
      result: agentJobs.result,
      messages: agentJobs.messages,
      claimedBy: agentJobs.claimedBy,
      claimGeneration: agentJobs.claimGeneration,
      sweeperObserved: agentJobs.sweeperObserved,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

/** Tous les faucheurs d'un tour de cron, dans l'ordre du tick. */
async function tousLesFaucheurs(presence: Presence): Promise<string[]> {
  await reclaimJobsOfDeadRunners(db, { presence });
  await resetOrphanedJobs(db, { presence });
  const aRelancer = await findPendingJobsToRecover(db, { presence });
  await failStalePendingJobs(db, { presence });
  return aRelancer;
}

const DEUX_HEURES = 2 * 3_600_000;

describe('un job tenu par une instance qui tourne n’est jamais repris @cap:parler-a-un-agent/moteur', () => {
  it('le job qu’un run de CETTE instance exécute, sans battement depuis deux heures : intact', async () => {
    const o = observatrice({ presenteDepuisMs: 600_000 });
    const jobId = await insertJob({
      status: 'processing',
      claimedBy: o.presence.instanceId,
      claimGeneration: 1,
      updatedAt: new Date(Date.now() - DEUX_HEURES),
    });
    o.tenus.add(jobId);

    for (let i = 0; i < 3; i += 1) {
      await tousLesFaucheurs(o.presence);
      o.mono.t += 10 * 60_000;
    }

    expect(await ligne(jobId)).toMatchObject({
      status: 'processing',
      error: null,
      claimGeneration: 1,
      claimedBy: o.presence.instanceId,
      sweeperObserved: null,
    });
  });

  it('deux instances sur une base : aucune ne reprend les jobs vivants de l’autre', async () => {
    const a = observatrice({ presenteDepuisMs: 600_000 });
    const b = observatrice({ presenteDepuisMs: 600_000 });
    await db.insert(runnerInstances).values([
      { id: a.presence.instanceId, host: 'h', pid: 1 },
      { id: b.presence.instanceId, host: 'h', pid: 1 },
    ]);
    const vieux = new Date(Date.now() - DEUX_HEURES);
    const jobA = await insertJob({
      status: 'processing',
      claimedBy: a.presence.instanceId,
      claimGeneration: 1,
      updatedAt: vieux,
    });
    const jobB = await insertJob({
      status: 'processing',
      claimedBy: b.presence.instanceId,
      claimGeneration: 1,
      updatedAt: vieux,
    });
    a.tenus.add(jobA);
    b.tenus.add(jobB);

    for (let i = 0; i < 2; i += 1) {
      await tousLesFaucheurs(a.presence);
      await tousLesFaucheurs(b.presence);
      a.mono.t += 10 * 60_000;
      b.mono.t += 10 * 60_000;
    }

    expect((await ligne(jobA)).status).toBe('processing');
    expect((await ligne(jobB)).status).toBe('processing');
    expect((await ligne(jobA)).claimedBy).toBe(a.presence.instanceId);
    expect((await ligne(jobB)).claimedBy).toBe(b.presence.instanceId);
  });

  it('l’horloge avance de deux heures d’un coup, la base avec elle : rien n’est repris à l’instance qui battait', async () => {
    // Un recalage NTP ou un réveil sur l'hôte qui porte la base et les deux
    // runners. Ici la base de test lit la même horloge que le processus : le
    // saut fait paraître muette l'autre instance, mais l'observatrice voit le
    // même trou dans SES propres battements — elle ne peut répondre d'aucun
    // silence, et ne décide rien.
    const autre = await instance({ vueIlYa: 5_000 });
    const jobId = await insertJob({
      status: 'processing',
      claimedBy: autre,
      claimGeneration: 1,
      updatedAt: new Date(Date.now() - 5_000),
    });
    const o = observatrice({ presenteDepuisMs: 600_000 });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + DEUX_HEURES);
      await tousLesFaucheurs(o.presence);
    } finally {
      vi.useRealTimers();
    }
    expect(await ligne(jobId)).toMatchObject({ status: 'processing', claimedBy: autre });
  });

  it('une instance qui se réveille d’un long sommeil ne déclare pas partie celle qui dormait avec elle', async () => {
    const endormie = await instance({ vueIlYa: 3_600_000 });
    const jobId = await insertJob({
      status: 'processing',
      claimedBy: endormie,
      claimGeneration: 1,
    });
    // L'observatrice aussi a dormi une heure : un battement avant, un au réveil.
    const beats = new BeatRecord();
    beats.record(new Date(Date.now() - 3_600_000));
    beats.record(new Date());
    const presence = createPresence({
      instanceId: randomUUID(),
      holds: () => false,
      monotonicNow: () => 0,
      beats,
    });

    await reclaimJobsOfDeadRunners(db, { presence });

    expect((await ligne(jobId)).status).toBe('processing');
  });
});

describe('les jobs d’une instance partie sont repris, une fois @cap:parler-a-un-agent/moteur', () => {
  it('arrêtée : repris aussitôt ; ce qui peut reprendre reprend, le reste échoue en disant ce qui a été vu', async () => {
    const arretee = await instance({ vueIlYa: 20_000, arreteeIlYa: 15_000 });
    // Un tour sauvegardé, rien d'exécuté depuis : il reprend.
    const reprenable = await insertJob({
      status: 'processing',
      claimedBy: arretee,
      claimGeneration: 3,
      turn: 2,
    });
    // Aucun tour sauvegardé : rien à rejouer, il échoue.
    const sansPoint = await insertJob({
      status: 'processing',
      claimedBy: arretee,
      claimGeneration: 1,
    });
    const o = observatrice();

    const premier = await reclaimJobsOfDeadRunners(db, { presence: o.presence });
    const second = await reclaimJobsOfDeadRunners(db, { presence: o.presence });

    expect(premier.resumedJobIds).toEqual([reprenable]);
    expect(premier.reclaimed).toBe(1);
    expect(second).toEqual({ reclaimed: 0, parentsResumed: 0, resumed: 0, resumedJobIds: [] });

    const r = await ligne(reprenable);
    expect(r.status).toBe('pending');
    expect(r.claimGeneration).toBe(4);
    expect(r.sweeperObserved).toMatchObject({
      outcome: 'resumed',
      reason: 'holder_gone',
      holder: arretee,
      holderState: 'stopped',
      observedBy: o.presence.instanceId,
    } satisfies Partial<SweeperObservation>);

    const s = await ligne(sansPoint);
    expect(s.status).toBe('failed');
    expect(s.error).toBe(RUNNER_RESTARTED_CODE);
    expect(s.result ?? '').toContain(`runner ${arretee.slice(0, 8)} stopped at `);
    expect(s.result ?? '').not.toContain('no heartbeat');
    expect(s.sweeperObserved?.holderStoppedAt).not.toBeNull();
  });

  it('muette pendant que l’observatrice battait : partie ; observatrice trop récente : rien n’est décidé', async () => {
    const muette = await instance({ vueIlYa: JOB_LIVENESS.silentInstanceMs + 60_000 });
    const jobId = await insertJob({ status: 'processing', claimedBy: muette, claimGeneration: 1 });

    // Vient de démarrer : elle ne peut pas répondre du silence de l'autre.
    await reclaimJobsOfDeadRunners(db, {
      presence: observatrice({ presenteDepuisMs: 30_000 }).presence,
    });
    expect((await ligne(jobId)).status).toBe('processing');

    const o = observatrice({ presenteDepuisMs: JOB_LIVENESS.silentInstanceMs + 60_000 });
    await reclaimJobsOfDeadRunners(db, { presence: o.presence });
    const l = await ligne(jobId);
    expect(l.status).toBe('failed');
    expect(l.result ?? '').toContain(`runner ${muette.slice(0, 8)} last seen at `);
    expect(l.sweeperObserved).toMatchObject({ holderState: 'silent', holder: muette });
  });

  it('un job pris par CETTE instance qu’aucun de ses runs n’exécute est repris une fois vu inchangé assez longtemps', async () => {
    const o = observatrice();
    const jobId = await insertJob({
      status: 'processing',
      claimedBy: o.presence.instanceId,
      claimGeneration: 1,
    });

    await reclaimJobsOfDeadRunners(db, { presence: o.presence });
    expect((await ligne(jobId)).status).toBe('processing');

    o.mono.t += JOB_LIVENESS.stuckRowMs;
    await reclaimJobsOfDeadRunners(db, { presence: o.presence });
    expect(await ligne(jobId)).toMatchObject({
      status: 'failed',
      sweeperObserved: { reason: 'not_held', holder: o.presence.instanceId },
    });
  });

  it('la même règle pour un job de tête, un délégué, une tâche du tableau et un job de runtime CLI', async () => {
    const [cli] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Agent CLI',
        slug: `cli-${randomUUID().slice(0, 8)}`,
        personality: 'p',
        llmKeyId: seed.llmKeyId,
        runtime: 'claude-code',
      } as never)
      .returning({ id: agents.id });
    const vivante = await instance({ vueIlYa: 1_000 });
    const partie = await instance({ vueIlYa: 1_000, arreteeIlYa: 500 });

    const parent = await insertJob({ status: 'awaiting_delegation' });
    const genres = (holder: string) => ({
      tete: { status: 'processing', claimedBy: holder, claimGeneration: 1 },
      delegue: {
        status: 'processing',
        claimedBy: holder,
        claimGeneration: 1,
        channel: 'internal',
        parentJobId: parent,
      },
      tableau: {
        status: 'processing',
        claimedBy: holder,
        claimGeneration: 1,
        channel: 'task-board',
      },
      cli: { status: 'processing', claimedBy: holder, claimGeneration: 1, agentId: cli!.id },
    });
    const ids: Record<string, { vivant: string; parti: string }> = {};
    for (const [genre, v] of Object.entries(genres(vivante))) {
      ids[genre] = { vivant: await insertJob(v), parti: '' };
    }
    for (const [genre, v] of Object.entries(genres(partie))) {
      ids[genre]!.parti = await insertJob(v);
    }
    // La tâche du tableau tient son job.
    await db.insert(agentTasks).values([
      {
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 't1',
        status: 'in_progress',
        jobId: ids['tableau']!.vivant,
      },
      {
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 't2',
        status: 'in_progress',
        jobId: ids['tableau']!.parti,
      },
    ] as never);

    await reclaimJobsOfDeadRunners(db, { presence: observatrice().presence });

    const etats: Record<string, { vivant: string | null; parti: string | null }> = {};
    for (const [genre, { vivant, parti }] of Object.entries(ids)) {
      etats[genre] = {
        vivant: (await ligne(vivant)).status,
        parti: (await ligne(parti)).error,
      };
    }
    expect(etats).toEqual({
      tete: { vivant: 'processing', parti: RUNNER_RESTARTED_CODE },
      delegue: { vivant: 'processing', parti: RUNNER_RESTARTED_CODE },
      tableau: { vivant: 'processing', parti: RUNNER_RESTARTED_CODE },
      cli: { vivant: 'processing', parti: 'runtime_not_resumable' },
    });
  });
});

describe('un parent dont l’enfant a fini reçoit son résultat @cap:organiser-equipe/moteur', () => {
  async function delegationFinie(enfant: Record<string, unknown>) {
    const parentId = await insertJob({
      status: 'awaiting_delegation',
      claimGeneration: 2,
      messages: [
        { role: 'user', content: 'fais relire la PR' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'deleg-1',
              toolName: 'assign_reviewer',
              input: { task: 'relis la PR' },
            },
          ],
        },
      ],
    });
    const childId = await insertJob({
      channel: 'internal',
      parentJobId: parentId,
      claimGeneration: 1,
      ...enfant,
    });
    await db
      .update(agentJobs)
      .set({
        pendingDelegation: {
          type: 'single',
          toolUseId: 'deleg-1',
          toolName: 'assign_reviewer',
          subJobId: childId,
        },
      })
      .where(eq(agentJobs.id, parentId));
    return { parentId, childId };
  }

  it('enfant `completed`, réveil du parent perdu : le parent reçoit le texte de l’enfant, jamais un échec', async () => {
    const { parentId, childId } = await delegationFinie({
      status: 'completed',
      result: 'La PR est relue : deux remarques.',
    });
    const o = observatrice();

    await resetOrphanedJobs(db, { presence: o.presence });
    // Vue une fois : rien encore — le réveil normal est peut-être en route.
    expect((await ligne(parentId)).status).toBe('awaiting_delegation');

    o.mono.t += JOB_LIVENESS.stuckRowMs;
    const echoues = await resetOrphanedJobs(db, { presence: o.presence });

    expect(echoues).toBe(0);
    const p = await ligne(parentId);
    expect(p.status).toBe('pending');
    expect(p.error).toBeNull();
    const dernier = (p.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    expect(dernier.role).toBe('tool');
    const part = dernier.content[0] as {
      toolCallId: string;
      output: { type: string; value: string };
    };
    expect(part.toolCallId).toBe('deleg-1');
    expect(part.output.type).toBe('text');
    expect(part.output.value).toContain('La PR est relue : deux remarques.');
    expect((await ligne(childId)).status).toBe('completed');
  });

  it('enfant `failed` : le parent reçoit l’échec typé de l’enfant, et décide', async () => {
    const { parentId } = await delegationFinie({
      status: 'failed',
      error: 'tool_call_limit_exceeded',
      result: 'Arrêté en cours de route.',
    });
    const o = observatrice();
    await resetOrphanedJobs(db, { presence: o.presence });
    o.mono.t += JOB_LIVENESS.stuckRowMs;
    await resetOrphanedJobs(db, { presence: o.presence });

    const p = await ligne(parentId);
    expect(p.status).toBe('pending');
    const part = (p.messages as Array<{ content: unknown[] }>).at(-1)!.content[0] as {
      output: { type: string; value: string };
    };
    expect(part.output.type).toBe('error-text');
    expect(part.output.value).toContain('tool_call_limit_exceeded');
  });

  it('un enfant qu’un run de cette instance exécute encore : le parent attend', async () => {
    const { parentId, childId } = await delegationFinie({ status: 'completed', result: 'fini' });
    const o = observatrice({ tient: [] });
    o.tenus.add(childId);
    await resetOrphanedJobs(db, { presence: o.presence });
    o.mono.t += 10 * JOB_LIVENESS.stuckRowMs;
    await resetOrphanedJobs(db, { presence: o.presence });
    expect((await ligne(parentId)).status).toBe('awaiting_delegation');
  });

  it('l’enfant n’existe pas : rien ne réparera, le parent échoue avec ce fait', async () => {
    const { parentId, childId } = await delegationFinie({ status: 'completed' });
    await db.update(agentJobs).set({ parentJobId: null }).where(eq(agentJobs.id, childId));
    await db.delete(agentJobs).where(eq(agentJobs.id, childId));
    const o = observatrice();
    await resetOrphanedJobs(db, { presence: o.presence });
    o.mono.t += JOB_LIVENESS.stuckRowMs;
    expect(await resetOrphanedJobs(db, { presence: o.presence })).toBe(1);
    expect(await ligne(parentId)).toMatchObject({
      status: 'failed',
      error: 'orphan_job_reset',
      sweeperObserved: { outcome: 'failed', reason: 'child_missing', childJobId: childId },
    });
  });
});

describe('un job dont l’approbation est tranchée repart @cap:approuver-une-action/moteur', () => {
  it('demande expirée, le job resté `awaiting_approval` : il repart', async () => {
    const jobId = await insertJob({ status: 'awaiting_approval', claimGeneration: 1 });
    await db.insert(approvalRequests).values({
      jobId,
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: {},
      status: 'expired',
    } as never);
    const o = observatrice();
    await resetOrphanedJobs(db, { presence: o.presence });
    expect((await ligne(jobId)).status).toBe('awaiting_approval');
    o.mono.t += JOB_LIVENESS.stuckRowMs;
    await resetOrphanedJobs(db, { presence: o.presence });
    expect((await ligne(jobId)).status).toBe('pending');
  });

  it('une demande encore ouverte : le job attend la personne', async () => {
    const jobId = await insertJob({ status: 'awaiting_approval', claimGeneration: 1 });
    await db.insert(approvalRequests).values({
      jobId,
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: {},
      status: 'pending',
    } as never);
    const o = observatrice();
    await resetOrphanedJobs(db, { presence: o.presence });
    o.mono.t += 10 * JOB_LIVENESS.stuckRowMs;
    await resetOrphanedJobs(db, { presence: o.presence });
    expect((await ligne(jobId)).status).toBe('awaiting_approval');
  });
});

describe('un job `pending` : relancé, ou abandonné seulement s’il n’a jamais été pris @cap:parler-a-un-agent/moteur', () => {
  it('jamais pris, demandé il y a dix minutes (horloge de la base) : abandonné, avec ce fait', async () => {
    const jobId = await insertJob({
      status: 'pending',
      createdAt: new Date(Date.now() - 10 * 60_000),
    });
    const o = observatrice();
    expect(await failStalePendingJobs(db, { presence: o.presence })).toBe(1);
    expect(await ligne(jobId)).toMatchObject({
      status: 'failed',
      error: 'stale_pending_abandoned',
      sweeperObserved: { reason: 'never_claimed', holder: null },
    });
  });

  it('remis en file par le système il y a une heure : relancé, jamais abandonné', async () => {
    const jobId = await insertJob({
      status: 'pending',
      claimGeneration: 2,
      createdAt: new Date(Date.now() - 3_600_000),
      updatedAt: new Date(Date.now() - 3_600_000),
    });
    const o = observatrice();
    expect(await findPendingJobsToRecover(db, { presence: o.presence })).toEqual([]);
    o.mono.t += JOB_LIVENESS.stuckRowMs;
    expect(await failStalePendingJobs(db, { presence: o.presence })).toBe(0);
    expect(await findPendingJobsToRecover(db, { presence: o.presence })).toEqual([jobId]);
    expect((await ligne(jobId)).status).toBe('pending');
  });

  it('un job qu’un run de cette instance va prendre n’est ni relancé ni abandonné', async () => {
    const jobId = await insertJob({
      status: 'pending',
      createdAt: new Date(Date.now() - 10 * 60_000),
    });
    const o = observatrice();
    o.tenus.add(jobId);
    o.mono.t += JOB_LIVENESS.stuckRowMs;
    expect(await failStalePendingJobs(db, { presence: o.presence })).toBe(0);
    o.mono.t += JOB_LIVENESS.stuckRowMs;
    expect(await findPendingJobsToRecover(db, { presence: o.presence })).toEqual([]);
    expect((await ligne(jobId)).status).toBe('pending');
  });
});
