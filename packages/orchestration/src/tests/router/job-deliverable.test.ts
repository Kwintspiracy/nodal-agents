// router/job-deliverable.test.ts — ce qu'un job a livré, lu en un seul endroit
// (issue #646), sur une vraie base.
//
// Le cas de l'issue : root → Lead → Reviewer A (job 87c37ae8, 12/10/2026). Lead
// relaie sans appeler `review_verdict` ; le verdict de Reviewer A doit quand même
// arriver au root, avec son auteur. Ces cas prouvent la règle générale sur
// davantage que ce scénario : relais à un et deux étages, intermédiaire qui
// remplace, deux verdicts qui se contredisent, ligne illisible, délégation
// ordinaire.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, entities, toolCalls, users } from '@nodal-agents/db';
import { REVIEW_CHANGES_REQUESTED } from '@nodal-agents/shared';
import {
  appendDeliveredVerdicts,
  deliveredSomething,
  readChildDeliverables,
  readJobDeliverable,
  readJobDeliverables,
  renderDeliveredVerdicts,
  verdictsBlockDelivery,
} from '../../router/job-deliverable';
import { resumeDelegated, DELEGATION_FAILED_MARKER } from '../../router/resume';
import type { JobId } from '../../types';

let db: TestDb;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
});

const REQUEST_CHANGES = {
  ok: true,
  verdict: 'request_changes',
  summary: 'Passe 1 : le test de journalisation ne prouve pas la troncature.',
  findings: [
    {
      file: 'packages/db/src/tests/postgres-logging.pg.test.ts',
      line: 100,
      issue: 'L’assertion lit la longueur, pas le contenu tronqué.',
      severity: 'major',
    },
    {
      file: 'packages/db/src/logging.ts',
      issue: 'Le commentaire décrit l’ancienne borne.',
      severity: 'minor',
    },
  ],
  counts: { blocker: 0, major: 1, minor: 1 },
};

const APPROVE = {
  ok: true,
  verdict: 'approve',
  summary: 'Relu, rien à corriger.',
  findings: [],
  counts: { blocker: 0, major: 0, minor: 0 },
};

interface World {
  entityId: string;
  agent: (slug: string) => Promise<string>;
}

async function world(): Promise<World> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `jd-${suffix}@example.test` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: `e-jd-${suffix}` })
    .returning();
  return {
    entityId: entity!.id,
    agent: async (slug: string) => {
      const [a] = await db
        .insert(agents)
        .values({
          entityId: entity!.id,
          name: slug.toUpperCase(),
          slug: `${slug}-${suffix}`,
          personality: 'p',
          role: 'agent',
          active: true,
        })
        .returning();
      return a!.id;
    },
  };
}

let clock = Date.parse('2026-10-12T09:20:00Z');

async function job(
  w: World,
  agentId: string,
  values: { parentJobId?: string; result?: string | null; status?: string } = {},
): Promise<string> {
  clock += 1000;
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: w.entityId,
      agentId,
      channel: 'internal',
      task: 'relis la PR #679',
      status: values.status ?? 'completed',
      result: values.result ?? null,
      parentJobId: values.parentJobId ?? null,
      createdAt: new Date(clock),
    })
    .returning();
  return row!.id;
}

/** Une ligne `tool_calls` dans la forme de production (`JSON.stringify(output)`). */
async function verdict(w: World, jobId: string, output: unknown): Promise<void> {
  await db.insert(toolCalls).values({
    entityId: w.entityId,
    jobId,
    toolName: 'review_verdict',
    toolInput: {},
    toolOutput: JSON.stringify(output),
    turn: 1,
  });
}

async function slugOf(agentId: string): Promise<string> {
  const [a] = await db.select({ slug: agents.slug }).from(agents).where(eq(agents.id, agentId));
  return a!.slug;
}

describe('readJobDeliverables — le verdict traverse les relais @cap:organiser-equipe/moteur', () => {
  it('root → Lead → Reviewer A : Lead livre le verdict de Reviewer A, avec son auteur', async () => {
    const w = await world();
    const [alfred, lead, reviewer] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
    ]);
    const root = await job(w, alfred, { status: 'processing' });
    const leadJob = await job(w, lead, {
      parentJobId: root,
      result: 'Changements demandés, 1 majeur.',
    });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob, result: 'Verdict émis.' });
    await verdict(w, reviewerJob, REQUEST_CHANGES);

    const d = await readJobDeliverable(db, leadJob);

    expect(d?.text).toBe('Changements demandés, 1 majeur.');
    expect(d?.review_verdicts).toEqual([
      {
        author: { agent_slug: await slugOf(reviewer), job_id: reviewerJob },
        verdict: 'request_changes',
        summary: REQUEST_CHANGES.summary,
        findings: REQUEST_CHANGES.findings,
        counts: REQUEST_CHANGES.counts,
      },
    ]);
    // Et au-dessus : le root voit, par son enfant Lead, ce que Reviewer A a dit.
    const kids = await readChildDeliverables(db, root);
    expect(kids.map((k) => k.job_id)).toEqual([leadJob]);
    expect(kids[0]?.review_verdicts.map((v) => v.author.job_id)).toEqual([reviewerJob]);
  });

  it('deux étages de relais : le verdict remonte quand même', async () => {
    const w = await world();
    const [a, b, c] = await Promise.all([w.agent('one'), w.agent('two'), w.agent('three')]);
    const top = await job(w, a, { result: 'Fait.' });
    const mid = await job(w, b, { parentJobId: top, result: 'Fait aussi.' });
    const leaf = await job(w, c, { parentJobId: mid, result: null });
    await verdict(w, leaf, APPROVE);

    const d = await readJobDeliverable(db, top);
    expect(d?.review_verdicts.map((v) => [v.author.job_id, v.verdict])).toEqual([
      [leaf, 'approve'],
    ]);
  });

  it('un intermédiaire qui enregistre SON verdict remplace ceux d’en dessous', async () => {
    const w = await world();
    const [lead, reviewer] = await Promise.all([w.agent('lead'), w.agent('reviewer-a')]);
    const leadJob = await job(w, lead, { result: 'J’arbitre.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, REQUEST_CHANGES);
    await verdict(w, leadJob, APPROVE);

    const d = await readJobDeliverable(db, leadJob);
    expect(d?.review_verdicts.map((v) => [v.author.job_id, v.verdict])).toEqual([
      [leadJob, 'approve'],
    ]);
  });

  it('deux verdicts qui se contredisent : les deux voyagent, dans l’ordre, et l’interdit tient', async () => {
    const w = await world();
    const [lead, ra, rb] = await Promise.all([
      w.agent('lead'),
      w.agent('reviewer-a'),
      w.agent('reviewer-b'),
    ]);
    const leadJob = await job(w, lead, { result: 'Deux relectures.' });
    const first = await job(w, ra, { parentJobId: leadJob });
    const second = await job(w, rb, { parentJobId: leadJob });
    await verdict(w, first, REQUEST_CHANGES);
    await verdict(w, second, APPROVE);

    const d = await readJobDeliverable(db, leadJob);
    expect(d?.review_verdicts.map((v) => [v.author.agent_slug, v.verdict])).toEqual([
      [await slugOf(ra), 'request_changes'],
      [await slugOf(rb), 'approve'],
    ]);
    // Un approve ne lève pas le request_changes d'un autre relecteur.
    expect(verdictsBlockDelivery(d!.review_verdicts)).toBe(true);
    expect(verdictsBlockDelivery(d!.review_verdicts.filter((v) => v.verdict === 'approve'))).toBe(
      false,
    );
  });

  it('une délégation ordinaire : son texte, aucun verdict', async () => {
    const w = await world();
    const a = await w.agent('researcher');
    const j = await job(w, a, { result: 'Longueur de Planck : 1.616255e-35 m.' });

    const d = await readJobDeliverable(db, j);
    expect(d?.text).toBe('Longueur de Planck : 1.616255e-35 m.');
    expect(d?.review_verdicts).toEqual([]);
    expect(d?.unreadable_review_verdicts).toEqual([]);
    expect(deliveredSomething(d!)).toBe(true);
  });

  it('un enfant qui n’a livré QUE son verdict a livré quelque chose', async () => {
    const w = await world();
    const a = await w.agent('reviewer-a');
    const j = await job(w, a, { result: null });
    await verdict(w, j, REQUEST_CHANGES);

    const d = await readJobDeliverable(db, j);
    expect(d?.text).toBe('');
    expect(deliveredSomething(d!)).toBe(true);
  });

  it('une ligne illisible deux étages plus bas est nommée, avec son auteur', async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.agent('lead'), w.agent('reviewer-a')]);
    const top = await job(w, a, { result: 'Relayé.' });
    const leaf = await job(w, b, { parentJobId: top });
    await verdict(w, leaf, { ok: true, verdict: 'approve', findings: 'pas un tableau' });

    const d = await readJobDeliverable(db, top);
    expect(d?.review_verdicts).toEqual([]);
    expect(d?.unreadable_review_verdicts).toEqual([{ agent_slug: await slugOf(b), job_id: leaf }]);
  });

  it('plusieurs jobs en une lecture : chacun reçoit son propre sous-arbre', async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.agent('lead'), w.agent('reviewer-a')]);
    const left = await job(w, a, { result: 'gauche' });
    const right = await job(w, a, { result: 'droite' });
    const leaf = await job(w, b, { parentJobId: right });
    await verdict(w, leaf, APPROVE);

    const read = await readJobDeliverables(db, [left, right]);
    expect(read.get(left)?.review_verdicts).toEqual([]);
    expect(read.get(right)?.review_verdicts.map((v) => v.author.job_id)).toEqual([leaf]);
  });
});

describe('renderDeliveredVerdicts — les champs typés, sans prose (invariant #2) @cap:organiser-equipe/moteur', () => {
  it('pose verdict, auteur, résumé et constats fichier:ligne + sévérité', () => {
    const text = renderDeliveredVerdicts({
      review_verdicts: [
        {
          author: { agent_slug: 'reviewer-a', job_id: 'd4a02d0a' },
          verdict: 'request_changes',
          summary: REQUEST_CHANGES.summary,
          findings: REQUEST_CHANGES.findings as never,
          counts: REQUEST_CHANGES.counts,
        },
      ],
      unreadable_review_verdicts: [{ agent_slug: null, job_id: 'ffff0000' }],
    });

    expect(text).toBe(
      [
        '[review_verdict] verdict: request_changes · author: reviewer-a · job: d4a02d0a',
        `summary: ${REQUEST_CHANGES.summary}`,
        'findings:',
        '- major · packages/db/src/tests/postgres-logging.pg.test.ts:100 · L’assertion lit la longueur, pas le contenu tronqué.',
        '- minor · packages/db/src/logging.ts · Le commentaire décrit l’ancienne borne.',
        '',
        '[review_verdict_malformed] author: null · job: ffff0000',
      ].join('\n'),
    );
  });

  it('sans verdict, le texte revient tel quel, octet pour octet', () => {
    const texte = '  Longueur de Planck :\n1.616255e-35 m.  ';
    expect(
      appendDeliveredVerdicts(texte, { review_verdicts: [], unreadable_review_verdicts: [] }),
    ).toBe(texte);
    expect(appendDeliveredVerdicts(texte, null)).toBe(texte);
  });
});

/** Le `tool_result` que le parent vient de recevoir, brut. */
async function parentToolResult(parentJobId: string): Promise<{ type: string; value: string }> {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId));
  const msgs = row?.messages as Array<{ role: string; content: unknown }>;
  const content = msgs.at(-1)?.content as Array<{
    type: string;
    output: { type: string; value: string };
  }>;
  return content.find((b) => b.type === 'tool-result')!.output;
}

async function awaitingRoot(w: World, agentId: string, toolName: string): Promise<string> {
  clock += 1000;
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: w.entityId,
      agentId,
      channel: 'api',
      task: 'fais relire la PR #679',
      status: 'awaiting_delegation',
      createdAt: new Date(clock),
      messages: [
        { role: 'user', content: 'fais relire la PR #679' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'tu-1', toolName, input: {} }],
        },
      ],
      pendingDelegation: { type: 'single', toolUseId: 'tu-1', toolName, subJobId: 'x' },
    })
    .returning();
  return row!.id;
}

describe('resumeDelegated porte les verdicts du sous-arbre @cap:verifier-un-livrable/moteur', () => {
  it('root → Lead → Reviewer A : le root reçoit le verdict de Reviewer A, attribué à Reviewer A', async () => {
    const w = await world();
    const [alfred, lead, reviewer] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Changements demandés.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, REQUEST_CHANGES);

    await resumeDelegated(root as JobId, leadJob as JobId, 'Changements demandés.', db);

    const out = await parentToolResult(root);
    expect(out.type).toBe('text');
    const payload = JSON.parse(out.value) as Record<string, unknown>;
    expect(payload['summary']).toBe('Changements demandés.');
    expect(payload['review_verdicts']).toEqual([
      {
        author: { agent_slug: await slugOf(reviewer), job_id: reviewerJob },
        verdict: 'request_changes',
        summary: REQUEST_CHANGES.summary,
        findings: REQUEST_CHANGES.findings,
        counts: REQUEST_CHANGES.counts,
      },
    ]);
    expect(payload['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
  });

  it('deux verdicts contradictoires sous un relais : les deux portés, livraison bloquée', async () => {
    const w = await world();
    const [alfred, lead, ra, rb] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
      w.agent('reviewer-b'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Deux avis.' });
    const first = await job(w, ra, { parentJobId: leadJob });
    const second = await job(w, rb, { parentJobId: leadJob });
    await verdict(w, first, APPROVE);
    await verdict(w, second, REQUEST_CHANGES);

    await resumeDelegated(root as JobId, leadJob as JobId, 'Deux avis.', db);

    const payload = JSON.parse((await parentToolResult(root)).value) as Record<string, unknown>;
    const verdicts = payload['review_verdicts'] as Array<{
      author: { job_id: string };
      verdict: string;
    }>;
    expect(verdicts.map((v) => [v.author.job_id, v.verdict])).toEqual([
      [first, 'approve'],
      [second, 'request_changes'],
    ]);
    expect(payload['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
  });

  it('deux approbations sous un relais : rien n’est interdit', async () => {
    const w = await world();
    const [alfred, lead, ra, rb] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
      w.agent('reviewer-b'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'OK.' });
    await verdict(w, await job(w, ra, { parentJobId: leadJob }), APPROVE);
    await verdict(w, await job(w, rb, { parentJobId: leadJob }), APPROVE);

    await resumeDelegated(root as JobId, leadJob as JobId, 'OK.', db);

    const payload = JSON.parse((await parentToolResult(root)).value) as Record<string, unknown>;
    expect((payload['review_verdicts'] as unknown[]).length).toBe(2);
    expect(payload['delivery_blocked']).toBeNull();
  });

  it('une ligne illisible sous un relais fait une délégation échouée nommée, jamais un parent suspendu', async () => {
    const w = await world();
    const [alfred, lead, reviewer] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Relayé.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, { ok: true, verdict: 'request_changes' });

    await resumeDelegated(root as JobId, leadJob as JobId, 'Relayé.', db);

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, root));
    expect(row?.status).toBe('pending');
    const out = await parentToolResult(root);
    expect(out.type).toBe('error-text');
    expect(out.value.startsWith(DELEGATION_FAILED_MARKER)).toBe(true);
    expect(out.value).toContain('"error": "review_verdict_malformed"');
  });
});
