// approval-creation-order.test.ts — #801. Les demandes d'approbation ont UN
// ordre, l'ordre de création (`approval_requests.seq`), et tout lecteur qui les
// range passe par `approvalsOldestFirst` / `approvalsNewestFirst`.
//
// Le défaut : `requested_at` a la précision de la milliseconde et `id` est un
// uuid aléatoire. Deux demandes créées coup sur coup portaient la même heure, et
// leur ordre changeait d'un rafraîchissement à l'autre. Ici l'égalité est FORCÉE
// (même `requested_at` pour toutes) : seul `seq` peut départager.

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, eq, inArray } from '../index';
import { approvalsNewestFirst, approvalsOldestFirst } from '../schema/approvals';
import { listConversationRuns } from '../repos/conversation-runs';

let db: TestDb;
let entityId: string;
let agentId: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
  agentId = seed.agentId;
});

const SAME_INSTANT = new Date('2026-10-18T10:00:00.000Z');

async function insertTied(jobId: string, count: number, kind: 'approval' | 'question') {
  const created: string[] = [];
  for (let i = 0; i < count; i++) {
    const [row] = await db
      .insert(approvalRequests)
      .values({
        entityId,
        jobId,
        agentId,
        toolName: kind === 'question' ? 'ask_user' : 'run_command',
        toolInput: { n: i },
        kind,
        requestedAt: SAME_INSTANT,
      })
      .returning({ id: approvalRequests.id });
    created.push(row!.id);
  }
  return created;
}

async function newJob(conversationId?: string) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: 'telegram',
      task: 'work',
      status: 'awaiting_approval',
      conversationId,
    })
    .returning({ id: agentJobs.id });
  return job!.id;
}

describe('approval_requests creation order @cap:approuver-une-action/moteur', () => {
  it('rows sharing one requested_at come back in creation order, oldest first and newest first', async () => {
    const jobId = await newJob();
    const created = await insertTied(jobId, 24, 'approval');
    // 24 uuids aléatoires : l'ordre par id n'est celui de la création qu'avec une
    // probabilité 1/24! — le test ne passe pas par hasard.
    const oldest = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, jobId))
      .orderBy(approvalsOldestFirst);
    expect(oldest.map((r) => r.id)).toEqual(created);
    const newest = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, jobId))
      .orderBy(approvalsNewestFirst);
    expect(newest.map((r) => r.id)).toEqual([...created].reverse());
  });

  it('seq grows with every insertion, whatever the kind', async () => {
    const jobId = await newJob();
    const a = await insertTied(jobId, 2, 'approval');
    const q = await insertTied(jobId, 2, 'question');
    const rows = await db
      .select({ id: approvalRequests.id, seq: approvalRequests.seq })
      .from(approvalRequests)
      .where(inArray(approvalRequests.id, [...a, ...q]));
    const bySeq = [...rows].sort((x, y) => x.seq - y.seq).map((r) => r.id);
    expect(bySeq).toEqual([...a, ...q]);
  });

  it('listConversationRuns lists the pending requests of a run in creation order', async () => {
    const conversationId = randomUUID();
    const jobId = await newJob(conversationId);
    const created = await insertTied(jobId, 12, 'approval');
    const runs = await listConversationRuns(db as never, { entityId, conversationId });
    const listed = runs.flatMap((r) => r.pendingRequests.map((p) => p.id));
    expect(listed).toEqual(created);
  });
});

// Les lecteurs vivent dans trois paquets et deux apps : on ne peut pas tous les
// lancer ici. Cette garde lit leurs sources — plus aucun `orderBy` d'une
// requête sur `approval_requests` ne s'appuie sur l'heure seule.
describe('no reader orders approval_requests by requested_at @cap:approuver-une-action/moteur', () => {
  const root = join(__dirname, '..', '..', '..', '..');
  const skip = new Set([
    'node_modules',
    'dist',
    '.next',
    '.turbo',
    '.claude',
    'tests',
    '__tests__',
  ]);

  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) sources(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  /** Le texte entre les parenthèses de chaque `.orderBy(…)`, parenthèses imbriquées comprises. */
  function orderByArguments(text: string): string[] {
    const found: string[] = [];
    let at = text.indexOf('.orderBy(');
    while (at !== -1) {
      let depth = 0;
      let i = at + '.orderBy'.length;
      const start = i + 1;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) break;
      }
      found.push(text.slice(start, i));
      at = text.indexOf('.orderBy(', i);
    }
    return found;
  }

  it('finds none in apps/ and packages/', () => {
    const offenders: string[] = [];
    for (const top of ['apps', 'packages']) {
      for (const file of sources(join(root, top))) {
        const text = readFileSync(file, 'utf8');
        if (orderByArguments(text).some((a) => a.includes('approvalRequests.requestedAt'))) {
          offenders.push(relative(root, file).split(sep).join('/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
