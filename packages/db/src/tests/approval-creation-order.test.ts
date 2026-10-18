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

/**
 * Les ordonnancements d'`approval_requests` par l'heure seule que `source` contient.
 *
 * Deux formes, les deux lues : le builder Drizzle (`.orderBy(...)` dont
 * l'argument nomme `approvalRequests.requestedAt`, parenthèses imbriquées
 * comprises) et le SQL brut (un littéral — gabarit ou chaîne — qui nomme la table
 * `approval_requests` ET porte un `order by` sur `requested_at`).
 *
 * CE QU'ELLE NE VOIT PAS : une colonne passée par un alias (`const col =
 * approvalRequests.requestedAt; … .orderBy(col)`), un `order by` construit en
 * plusieurs morceaux de chaîne concaténés, et une requête sur la table dont le
 * nom est dans une variable. Ces formes-là restent à la relecture.
 */
export function requestedAtOrderings(source: string): string[] {
  const found: string[] = [];
  let at = source.indexOf('.orderBy(');
  while (at !== -1) {
    let depth = 0;
    let i = at + '.orderBy'.length;
    const start = i + 1;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')' && --depth === 0) break;
    }
    const args = source.slice(start, i);
    if (args.includes('approvalRequests.requestedAt')) found.push(`.orderBy(${args})`);
    at = source.indexOf('.orderBy(', i);
  }
  for (const literal of source.match(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g) ?? []) {
    if (!/\bapproval_requests\b/i.test(literal)) continue;
    const m = /\border\s+by\b[^;]*\brequested_at\b/i.exec(literal);
    if (m) found.push(m[0]);
  }
  return found;
}

describe('the guard that no reader orders approval_requests by requested_at @cap:approuver-une-action/moteur', () => {
  it('flags the Drizzle builder form, nested parentheses included', () => {
    expect(
      requestedAtOrderings('db.select().from(t).orderBy(desc(approvalRequests.requestedAt))'),
    ).toHaveLength(1);
    expect(requestedAtOrderings('x.orderBy(approvalRequests.requestedAt)')).toHaveLength(1);
  });

  it('flags raw SQL on approval_requests, in a template and in a string', () => {
    expect(
      requestedAtOrderings(
        'sql`select id from approval_requests where job_id in (${tree}) order by requested_at`',
      ),
    ).toHaveLength(1);
    expect(
      requestedAtOrderings("run('SELECT * FROM approval_requests ORDER BY job_id, requested_at')"),
    ).toHaveLength(1);
  });

  it('lets the creation order and other tables through', () => {
    expect(requestedAtOrderings('x.orderBy(approvalsOldestFirst)')).toEqual([]);
    expect(
      requestedAtOrderings('sql`select id from approval_requests where j = 1 order by seq`'),
    ).toEqual([]);
    expect(requestedAtOrderings('sql`select id from tool_calls order by requested_at`')).toEqual(
      [],
    );
    // Two statements side by side: the order by of one is not the other's.
    expect(
      requestedAtOrderings(
        'a(sql`select 1 from approval_requests`); b(sql`select 1 from x order by requested_at`)',
      ),
    ).toEqual([]);
  });
});

// Les lecteurs vivent dans trois paquets et deux apps : on ne peut pas tous les
// lancer ici. Cette garde lit leurs sources.
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
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) out.push(p);
    }
    return out;
  }

  it('finds none in apps/, packages/ and scripts/', () => {
    const offenders: string[] = [];
    for (const top of ['apps', 'packages', 'scripts']) {
      let dir: string;
      try {
        dir = join(root, top);
        statSync(dir);
      } catch {
        continue;
      }
      for (const file of sources(dir)) {
        if (requestedAtOrderings(readFileSync(file, 'utf8')).length > 0) {
          offenders.push(relative(root, file).split(sep).join('/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
