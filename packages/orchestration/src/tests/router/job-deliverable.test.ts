// router/job-deliverable.test.ts — ce qu'un job a livré, lu en un seul endroit
// (issue #646), sur une vraie base.
//
// Le cas de l'issue : root → Lead → Reviewer A (job 87c37ae8, 12/10/2026). Lead
// relaie sans appeler `review_verdict` ; le verdict de Reviewer A doit quand même
// arriver au root, avec son auteur. Ces cas prouvent la règle générale sur
// davantage que ce scénario : relais à un et deux étages, intermédiaire qui
// juge à son tour (son verdict s'AJOUTE, il ne remplace rien — revue Codex de
// la PR #712, passe 1), deux verdicts qui se contredisent, ligne illisible,
// délégation ordinaire.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, entities, toolCalls, users } from '@nodal-agents/db';
import { REVIEW_CHANGES_REQUESTED, TOOL_RESULT_MODEL_CHARS } from '@nodal-agents/shared';
import {
  appendDeliveredVerdicts,
  deliveredSomething,
  readChildDeliverables,
  readJobDeliverable,
  readJobDeliverables,
  renderDeliveredVerdicts,
  verdictsBlockDelivery,
} from '../../router/job-deliverable';
import {
  resumeDelegated,
  DELEGATION_FAILED_MARKER,
  DELEGATION_TEXT_AFTER_OBJECT,
  parseDelegationOutcomePayload,
} from '../../router/resume';
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

  it('un intermédiaire qui juge à son tour ne remplace pas le verdict d’en dessous : les deux voyagent', async () => {
    const w = await world();
    const [lead, reviewer] = await Promise.all([w.agent('lead'), w.agent('reviewer-a')]);
    const leadJob = await job(w, lead, { result: 'J’ai relu aussi.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, REQUEST_CHANGES);
    await verdict(w, leadJob, APPROVE);

    const d = await readJobDeliverable(db, leadJob);
    expect(
      d?.review_verdicts.map((v) => [v.author.agent_slug, v.author.job_id, v.verdict]),
    ).toEqual([
      [await slugOf(lead), leadJob, 'approve'],
      [await slugOf(reviewer), reviewerJob, 'request_changes'],
    ]);
    expect(verdictsBlockDelivery(d!.review_verdicts)).toBe(true);
  });

  it('une ligne illisible sous un intermédiaire qui a jugé est nommée quand même', async () => {
    const w = await world();
    const [lead, reviewer] = await Promise.all([w.agent('lead'), w.agent('reviewer-a')]);
    const leadJob = await job(w, lead, { result: 'Approuvé.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, {
      ok: true,
      verdict: 'request_changes',
      findings: 'pas un tableau',
    });
    await verdict(w, leadJob, APPROVE);

    const d = await readJobDeliverable(db, leadJob);
    expect(d?.review_verdicts.map((v) => [v.author.job_id, v.verdict])).toEqual([
      [leadJob, 'approve'],
    ]);
    expect(d?.unreadable_review_verdicts).toEqual([
      { agent_slug: await slugOf(reviewer), job_id: reviewerJob },
    ]);
  });

  it('un job qui appelle review_verdict deux fois (refusé, puis accepté) : seul son dernier appel compte', async () => {
    const w = await world();
    const [lead, reviewer] = await Promise.all([w.agent('lead'), w.agent('reviewer-a')]);
    const leadJob = await job(w, lead, { result: 'Relayé.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, { ok: false, error: 'findings[0].severity: invalid enum value' });
    await verdict(w, reviewerJob, REQUEST_CHANGES);

    const d = await readJobDeliverable(db, leadJob);
    expect(d?.review_verdicts.map((v) => [v.author.job_id, v.verdict])).toEqual([
      [reviewerJob, 'request_changes'],
    ]);
    expect(d?.unreadable_review_verdicts).toEqual([]);

    // La même règle, par job : un relecteur qui se corrige (deux appels
    // acceptés) ne livre que le second.
    await verdict(w, reviewerJob, APPROVE);
    const again = await readJobDeliverable(db, leadJob);
    expect(again?.review_verdicts.map((v) => [v.author.job_id, v.verdict])).toEqual([
      [reviewerJob, 'approve'],
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

  it('Reviewer A demande des corrections, Lead approuve : le root reçoit les deux, avec leurs auteurs, et la livraison reste bloquée', async () => {
    const w = await world();
    const [alfred, lead, reviewer] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Approuvé.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, REQUEST_CHANGES);
    await verdict(w, leadJob, APPROVE);

    await resumeDelegated(root as JobId, leadJob as JobId, 'Approuvé.', db);

    const payload = JSON.parse((await parentToolResult(root)).value) as Record<string, unknown>;
    expect(payload['status']).toBe('completed');
    expect(payload['review_verdicts']).toEqual([
      {
        author: { agent_slug: await slugOf(lead), job_id: leadJob },
        verdict: 'approve',
        summary: APPROVE.summary,
        findings: [],
        counts: APPROVE.counts,
      },
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

  it('Reviewer A approuve, Lead demande des corrections : les deux portés, livraison bloquée', async () => {
    const w = await world();
    const [alfred, lead, reviewer] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'À corriger.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, APPROVE);
    await verdict(w, leadJob, REQUEST_CHANGES);

    await resumeDelegated(root as JobId, leadJob as JobId, 'À corriger.', db);

    const payload = JSON.parse((await parentToolResult(root)).value) as Record<string, unknown>;
    const verdicts = payload['review_verdicts'] as Array<{
      author: { agent_slug: string; job_id: string };
      verdict: string;
    }>;
    expect(verdicts.map((v) => [v.author.agent_slug, v.author.job_id, v.verdict])).toEqual([
      [await slugOf(lead), leadJob, 'request_changes'],
      [await slugOf(reviewer), reviewerJob, 'approve'],
    ]);
    expect(payload['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
  });

  it('deux relecteurs en désaccord dans deux branches, chacune sous un intermédiaire qui approuve : les quatre portés, livraison bloquée', async () => {
    const w = await world();
    const [alfred, lead, subA, subB, ra, rb] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('sub-a'),
      w.agent('sub-b'),
      w.agent('reviewer-a'),
      w.agent('reviewer-b'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Deux branches.' });
    const branchA = await job(w, subA, { parentJobId: leadJob, result: 'Branche A.' });
    const branchB = await job(w, subB, { parentJobId: leadJob, result: 'Branche B.' });
    const leafA = await job(w, ra, { parentJobId: branchA });
    const leafB = await job(w, rb, { parentJobId: branchB });
    await verdict(w, leafA, APPROVE);
    await verdict(w, leafB, REQUEST_CHANGES);
    await verdict(w, branchA, APPROVE);
    await verdict(w, branchB, APPROVE);

    await resumeDelegated(root as JobId, leadJob as JobId, 'Deux branches.', db);

    const payload = JSON.parse((await parentToolResult(root)).value) as Record<string, unknown>;
    const verdicts = payload['review_verdicts'] as Array<{
      author: { job_id: string };
      verdict: string;
    }>;
    expect(verdicts.map((v) => [v.author.job_id, v.verdict])).toEqual([
      [branchA, 'approve'],
      [leafA, 'approve'],
      [branchB, 'approve'],
      [leafB, 'request_changes'],
    ]);
    expect(payload['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
  });

  it('une ligne illisible sous un intermédiaire qui a approuvé : délégation échouée nommée, l’approbation ne la cache pas', async () => {
    const w = await world();
    const [alfred, lead, reviewer] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Approuvé.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, { ok: true, verdict: 'request_changes' });
    await verdict(w, leadJob, APPROVE);

    await resumeDelegated(root as JobId, leadJob as JobId, 'Approuvé.', db);

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

  it('un relecteur délégué directement : son verdict seul, comme avant', async () => {
    const w = await world();
    const [alfred, reviewer] = await Promise.all([w.agent('alfred'), w.agent('reviewer-a')]);
    const root = await awaitingRoot(w, alfred, 'assign_reviewer_a');
    const reviewerJob = await job(w, reviewer, { parentJobId: root, result: 'Verdict émis.' });
    await verdict(w, reviewerJob, REQUEST_CHANGES);

    await resumeDelegated(root as JobId, reviewerJob as JobId, 'Verdict émis.', db);

    const payload = JSON.parse((await parentToolResult(root)).value) as Record<string, unknown>;
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

  it('une délégation qui n’est pas une revue, même sous un relais : aucun verdict, rien d’interdit, texte inchangé octet pour octet', async () => {
    const w = await world();
    const [alfred, lead, researcher] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('researcher'),
    ]);
    const texte = '  Longueur de Planck :\n1.616255e-35 m.  ';
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: texte });
    await job(w, researcher, { parentJobId: leadJob, result: 'Source : CODATA 2018.' });

    const d = await readJobDeliverable(db, leadJob);
    expect(appendDeliveredVerdicts(d!.text, d)).toBe(texte);

    await resumeDelegated(root as JobId, leadJob as JobId, texte, db);

    const payload = JSON.parse((await parentToolResult(root)).value) as Record<string, unknown>;
    expect(payload['review_verdicts']).toEqual([]);
    expect(payload['delivery_blocked']).toBeNull();
  });
});

/** Un verdict de relecteur aux bornes de l'outil : 50 constats de ~900 caractères. */
function wideVerdict(verdict: 'approve' | 'request_changes', reviewer: number): unknown {
  const findings = Array.from({ length: 50 }, (_, i) => ({
    file: `packages/p${reviewer}/src/f${i}.ts`,
    line: i + 1,
    issue: `R${reviewer}F${i} ` + 'constat détaillé '.repeat(52),
    severity: 'major',
  }));
  return {
    ok: true,
    verdict,
    summary: `Relecteur ${reviewer} : ` + 'résumé long '.repeat(80),
    findings,
    counts: { blocker: 0, major: 50, minor: 0 },
  };
}

/** L'objet JSON qui ouvre le `tool_result` (après le marqueur d'échec s'il y en a un). */
function decisionObject(value: string): Record<string, unknown> {
  const debut = value.indexOf('{\n');
  const fin = value.indexOf('\n}', debut);
  return JSON.parse(value.slice(debut, fin + 2)) as Record<string, unknown>;
}

const TRUNCATION_MARKER = /\n\n\[\.\.\. truncated: \d+ chars dropped \(total \d+\) \.\.\.\]$/;

describe('resumeDelegated : un résultat de délégation tient dans le budget d’un résultat d’outil @cap:verifier-un-livrable/moteur', () => {
  /** root → Lead → 12 relecteurs aux bornes de l'outil ; le 7e demande des corrections. */
  async function wideTree(w: World, leadResult: string) {
    const [alfred, lead] = await Promise.all([w.agent('alfred'), w.agent('lead')]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: leadResult });
    const authors: Array<[string, string, string]> = [];
    for (let i = 0; i < 12; i++) {
      const reviewer = await w.agent(`reviewer-${i}`);
      const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
      const v = i === 6 ? 'request_changes' : 'approve';
      await verdict(w, reviewerJob, wideVerdict(v, i));
      authors.push([await slugOf(reviewer), reviewerJob, v]);
    }
    // Le rendu borné met en tête les verdicts qui demandent des corrections,
    // l'ordre d'origine gardé dans chaque groupe (revue Codex de #712, passe 3).
    const enOrdreDeGarde = [
      ...authors.filter(([, , v]) => v === 'request_changes'),
      ...authors.filter(([, , v]) => v !== 'request_changes'),
    ];
    return { root, leadJob, authors: enOrdreDeGarde };
  }

  it('12 relecteurs × 50 constats : le tool_result tient dans le budget, chaque verdict et son auteur sont lus en entier, la coupe est dite', async () => {
    const w = await world();
    const { root, leadJob, authors } = await wideTree(w, 'Douze relectures.');

    await resumeDelegated(root as JobId, leadJob as JobId, 'Douze relectures.', db);

    const out = await parentToolResult(root);
    expect(out.type).toBe('text');
    expect(out.value.length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);
    expect(out.value).toMatch(TRUNCATION_MARKER);

    const head = decisionObject(out.value);
    expect(head['status']).toBe('completed');
    expect(head['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
    const verdicts = head['review_verdicts'] as Array<{
      author: { agent_slug: string; job_id: string };
      verdict: string;
      counts: unknown;
    }>;
    expect(verdicts.map((v) => [v.author.agent_slug, v.author.job_id, v.verdict])).toEqual(authors);
    expect(verdicts.map((v) => v.counts)).toEqual(
      authors.map(() => ({ blocker: 0, major: 50, minor: 0 })),
    );
    expect(head['review_verdicts_omitted']).toBe(0);
    expect(head['summary']).toBe(DELEGATION_TEXT_AFTER_OBJECT);

    // Le texte long suit, dans l'ordre : le résumé de l'enfant, puis les verdicts
    // mis en page dans le même ordre, jusqu'à la coupe.
    const apres = out.value.slice(out.value.indexOf('\n}') + 2);
    expect(
      apres.startsWith(
        '\n\n[summary]\nDouze relectures.\n\n[review_verdict] verdict: request_changes · author: ',
      ),
    ).toBe(true);
    expect(apres).toContain('R6F0 constat détaillé');

    // Le lecteur du runner relit toujours l'enregistrement typé.
    expect(parseDelegationOutcomePayload(out.value)?.status).toBe('completed');
  });

  it('le même arbre sous une délégation ÉCHOUÉE : marqueur, verdicts et consignes du parent tiennent ensemble dans le budget', async () => {
    const w = await world();
    const { root, leadJob, authors } = await wideTree(w, 'Interrompu.');

    await resumeDelegated(root as JobId, leadJob as JobId, { error: 'max_tool_calls' }, db);

    const out = await parentToolResult(root);
    expect(out.type).toBe('error-text');
    expect(out.value.length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);
    expect(out.value.startsWith(`${DELEGATION_FAILED_MARKER}\n{`)).toBe(true);
    const head = decisionObject(out.value);
    expect(head['status']).toBe('failed');
    expect(head['error']).toBe('max_tool_calls');
    expect(head['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
    const verdicts = head['review_verdicts'] as Array<{
      author: { agent_slug: string; job_id: string };
      verdict: string;
    }>;
    expect(verdicts.map((v) => [v.author.agent_slug, v.author.job_id, v.verdict])).toEqual(authors);
    // La coupe tombe dans le texte long ; les consignes qui suivent sont entières.
    expect(out.value).toMatch(/\[\.\.\. truncated: \d+ chars dropped \(total \d+\) \.\.\.\]\n\n/);
    expect(out.value).toContain('DO NOT tell the user the work is in progress');
  });

  it('une délégation ordinaire au résumé démesuré : bornée de même, statut lisible, début du résumé gardé', async () => {
    const w = await world();
    const [alfred, researcher] = await Promise.all([w.agent('alfred'), w.agent('researcher')]);
    const root = await awaitingRoot(w, alfred, 'assign_researcher');
    const resume = 'DÉBUT ' + 'page web recopiée '.repeat(5_000);
    const child = await job(w, researcher, { parentJobId: root, result: resume });

    await resumeDelegated(root as JobId, child as JobId, resume, db);

    const out = await parentToolResult(root);
    expect(out.value.length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);
    expect(out.value).toMatch(TRUNCATION_MARKER);
    const head = decisionObject(out.value);
    expect(head['status']).toBe('completed');
    expect(head['review_verdicts']).toEqual([]);
    expect(head['delivery_blocked']).toBeNull();
    expect(out.value).toContain('\n\n[summary]\nDÉBUT page web recopiée');
  });

  it('un petit résultat : rendu tel qu’avant, octet pour octet', async () => {
    const w = await world();
    const [alfred, lead, reviewer] = await Promise.all([
      w.agent('alfred'),
      w.agent('lead'),
      w.agent('reviewer-a'),
    ]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Relayé.' });
    const reviewerJob = await job(w, reviewer, { parentJobId: leadJob });
    await verdict(w, reviewerJob, REQUEST_CHANGES);

    await resumeDelegated(root as JobId, leadJob as JobId, 'Relayé.', db);

    const { ok: _ok, ...record } = REQUEST_CHANGES;
    expect((await parentToolResult(root)).value).toBe(
      JSON.stringify(
        {
          status: 'completed',
          summary: 'Relayé.',
          error: null,
          exit_reason: null,
          tools_used: [],
          review_verdicts: [
            { author: { agent_slug: await slugOf(reviewer), job_id: reviewerJob }, ...record },
          ],
          delivery_blocked: REVIEW_CHANGES_REQUESTED,
          hint: null,
          sub_delegations: [],
          files_written: [],
        },
        null,
        2,
      ),
    );
  });

  it('500 relecteurs aux constats longs, 300 sous-délégations : l’objet se relit, l’interdit et les échecs sont comptés sur tout (revue Codex de #712, passe 3)', async () => {
    const w = await world();
    const [alfred, lead] = await Promise.all([w.agent('alfred'), w.agent('lead')]);
    const root = await awaitingRoot(w, alfred, 'assign_lead');
    const leadJob = await job(w, lead, { parentJobId: root, result: 'Cinq cents relectures.' });
    const suffixe = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const verdictDe = (i: number): 'approve' | 'request_changes' =>
      i % 9 === 4 ? 'request_changes' : 'approve';
    const relecteurs = await db
      .insert(agents)
      .values(
        Array.from({ length: 500 }, (_, i) => ({
          entityId: w.entityId,
          name: `R${i}`,
          slug: `rv-${i}-${suffixe}`,
          personality: 'p',
          role: 'agent' as const,
          active: true,
        })),
      )
      .returning({ id: agents.id });
    clock += 1000;
    const jobs = await db
      .insert(agentJobs)
      .values(
        relecteurs.map((r, i) => ({
          entityId: w.entityId,
          agentId: r.id,
          channel: 'internal',
          task: 'relis la PR #679',
          status: 'completed',
          parentJobId: leadJob,
          createdAt: new Date(clock + i),
        })),
      )
      .returning({ id: agentJobs.id });
    clock += 1000;
    await db.insert(toolCalls).values(
      jobs.map((j, i) => {
        const { findings, ...reste } = wideVerdict(verdictDe(i), i) as {
          findings: unknown[];
        };
        return {
          entityId: w.entityId,
          jobId: j.id,
          toolName: 'review_verdict',
          toolInput: {},
          // Cinq constats de ~900 caractères chacun : longs, sans peser 22 Mo.
          toolOutput: JSON.stringify({
            ...reste,
            findings: findings.slice(0, 5),
            counts: { blocker: 0, major: 5, minor: 0 },
          }),
          turn: 1,
        };
      }),
    );
    const demandes = Array.from({ length: 500 }, (_, i) => verdictDe(i)).filter(
      (v) => v === 'request_changes',
    ).length;

    await resumeDelegated(
      root as JobId,
      leadJob as JobId,
      {
        status: 'completed',
        summary: 'Cinq cents relectures.',
        sub_delegations: Array.from({ length: 300 }, (_, i) => ({
          tool: `assign_specialiste_${String(i).padStart(3, '0')}`,
          status: i % 4 === 1 ? ('failed' as const) : ('delivered' as const),
        })),
      },
      db,
    );

    const out = await parentToolResult(root);
    expect(out.type).toBe('text');
    expect(out.value.length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);

    // Le lecteur du runner relit l'enregistrement : jamais `null`, et une
    // liste qui ne nomme plus tous les échecs le dit.
    const relu = parseDelegationOutcomePayload(out.value);
    expect(relu).not.toBeNull();
    expect(relu?.status).toBe('completed');
    const gardees = relu?.sub_delegations ?? [];
    const nommes = gardees.filter((s) => s.status === 'failed').length;
    expect(gardees.slice(0, nommes).every((s) => s.status === 'failed')).toBe(true);
    // Le scénario retire bien des échecs de la liste : c'est ce cas que le drapeau couvre.
    expect(nommes).toBeLessThan(75);
    expect(relu?.sub_delegations_incomplete).toBe(true);

    const head = decisionObject(out.value);
    expect(gardees.length + (head['sub_delegations_omitted'] as number)).toBe(300);
    // L'interdit, calculé sur les 500 verdicts.
    expect(head['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
    const verdicts = head['review_verdicts'] as Array<{ verdict: string }>;
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.length + (head['review_verdicts_omitted'] as number)).toBe(500);
    expect(
      verdicts
        .slice(0, Math.min(demandes, verdicts.length))
        .every((v) => v.verdict === 'request_changes'),
    ).toBe(true);
  });
});
