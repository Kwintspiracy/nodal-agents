// task-ledger.test.ts — delegated-task visibility (2026-07-12 incident).
//
// loadTaskLedger surfaces the REAL tool calls a task-board child job made,
// keyed by the creating job's id (agent_tasks.root_job_id) — the only signal
// that a delegated action (e.g. telegram_send_message) actually happened,
// since the creating job's own compiled result is just the child's prose.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import {
  loadTaskLedger,
  formatTaskLedgerEntry,
  formatTaskLedgerLines,
  MAX_TASKS_PER_EXCHANGE,
  loadInlineDelegationLedger,
  formatInlineDelegationLines,
} from '../../job/task-ledger.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(agentTasks);
  await db.delete(agentJobs);
});

/** Insert a task-board child job (the one that actually ran the delegated work). */
async function insertChildJob(opts: { toolsUsed?: string[] }): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'task-board',
      task: 'do the delegated work',
      status: 'completed',
      ...(opts.toolsUsed !== undefined ? { toolsUsed: opts.toolsUsed } : {}),
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

/** Insert an agent_tasks row linked to a root job and (optionally) its own child job. */
async function insertTask(opts: {
  rootJobId: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled' | 'blocked';
  result?: string | null;
  jobId?: string | null;
  updatedAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      title: opts.title,
      status: opts.status,
      result: opts.result ?? null,
      rootJobId: opts.rootJobId,
      jobId: opts.jobId ?? null,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    })
    .returning({ id: agentTasks.id });
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

describe('loadTaskLedger', () => {
  it('returns an empty map for an empty/null id list', async () => {
    expect(await loadTaskLedger(db, [])).toEqual(new Map());
    expect(await loadTaskLedger(db, [null, null])).toEqual(new Map());
  });

  it('returns nothing for a root job with no delegated tasks', async () => {
    const ledger = await loadTaskLedger(db, ['00000000-0000-0000-0000-000000000001']);
    expect(ledger.size).toBe(0);
  });

  it('surfaces the CHILD job tools_used, not the parent prose', async () => {
    const childJobId = await insertChildJob({
      toolsUsed: ['web_search', 'telegram_send_message'],
    });
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'Research Law & Order and send to Mathilde',
      status: 'done',
      result: 'Sent a summary to Mathilde via Telegram.',
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const entries = ledger.get(rootJobId) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      title: 'Research Law & Order and send to Mathilde',
      status: 'done',
      toolsUsed: ['web_search', 'telegram_send_message'],
      result: 'Sent a summary to Mathilde via Telegram.',
    });

    const line = formatTaskLedgerEntry(entries[0]!);
    expect(line).toBe(
      '[Task "Research Law & Order and send to Mathilde" completed: actions — web_search, ' +
        'telegram_send_message; result: Sent a summary to Mathilde via Telegram.]',
    );
  });

  it('collapses repeated tool calls to a ×N count', async () => {
    const childJobId = await insertChildJob({
      toolsUsed: ['telegram_send_message', 'telegram_send_message', 'web_search'],
    });
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'notify twice',
      status: 'done',
      result: 'done',
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const line = formatTaskLedgerEntry(ledger.get(rootJobId)![0]!);
    expect(line).toContain('telegram_send_message ×2');
    expect(line).toContain('web_search');
  });

  it('does NOT surface a still-running (todo/in_progress) task', async () => {
    const rootJobId = crypto.randomUUID();
    await insertTask({ rootJobId, title: 'still going', status: 'in_progress', result: null });
    await insertTask({ rootJobId, title: 'not started', status: 'todo', result: null });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    expect(ledger.size).toBe(0);
  });

  it('does NOT surface a voluntarily cancelled task', async () => {
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'aborted',
      status: 'cancelled',
      result: 'root cancelled',
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    expect(ledger.size).toBe(0);
  });

  it('renders a blocked task as a failure line with the error text', async () => {
    const childJobId = await insertChildJob({ toolsUsed: ['web_search'] });
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'failed lookup',
      status: 'blocked',
      result: 'API quota exceeded',
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const line = formatTaskLedgerEntry(ledger.get(rootJobId)![0]!);
    expect(line).toBe(
      '[Task "failed lookup" failed: actions — web_search; error: API quota exceeded]',
    );
  });

  it('truncates a long result to ~200 chars', async () => {
    const childJobId = await insertChildJob({ toolsUsed: ['web_search'] });
    const rootJobId = crypto.randomUUID();
    const huge = 'x'.repeat(500);
    await insertTask({
      rootJobId,
      title: 'long result',
      status: 'done',
      result: huge,
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const line = formatTaskLedgerEntry(ledger.get(rootJobId)![0]!);
    // 200 chars of 'x' plus the ellipsis marker, well short of the full 500.
    expect(line.length).toBeLessThan(300);
    expect(line).toContain('…');
  });

  it('bounds to MAX_TASKS_PER_EXCHANGE most recent, in chronological order', async () => {
    const rootJobId = crypto.randomUUID();
    const now = Date.now();
    // 5 done tasks, oldest to newest by updatedAt.
    for (let i = 0; i < 5; i++) {
      await insertTask({
        rootJobId,
        title: `task-${i}`,
        status: 'done',
        result: `result-${i}`,
        updatedAt: new Date(now - (5 - i) * 60_000), // task-0 oldest ... task-4 newest
      });
    }

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const entries = ledger.get(rootJobId) ?? [];
    expect(entries).toHaveLength(MAX_TASKS_PER_EXCHANGE);
    // Kept the 3 MOST RECENT (task-2, task-3, task-4), oldest-of-the-kept-window first.
    expect(entries.map((e) => e.title)).toEqual(['task-2', 'task-3', 'task-4']);
  });

  it('separates ledgers by root job id — no cross-exchange leakage', async () => {
    const rootA = crypto.randomUUID();
    const rootB = crypto.randomUUID();
    await insertTask({ rootJobId: rootA, title: 'in A', status: 'done', result: 'a' });
    await insertTask({ rootJobId: rootB, title: 'in B', status: 'done', result: 'b' });

    const ledger = await loadTaskLedger(db, [rootA, rootB]);
    expect(ledger.get(rootA)?.map((e) => e.title)).toEqual(['in A']);
    expect(ledger.get(rootB)?.map((e) => e.title)).toEqual(['in B']);
  });

  it('formatTaskLedgerLines maps a full entry list to formatted lines', () => {
    const lines = formatTaskLedgerLines([
      { title: 'a', status: 'done', toolsUsed: ['web_search'], result: 'ok' },
      { title: 'b', status: 'blocked', toolsUsed: [], result: null },
    ]);
    expect(lines).toEqual([
      '[Task "a" completed: actions — web_search; result: ok]',
      '[Task "b" failed: error: (no result)]',
    ]);
  });
});

// ─── Délégation EN LIGNE (`assign_*`) — incident du 26/08 ────────────────────
//
// Un orchestrateur a annoncé sur Telegram, quatre fois dans la journée :
// « app livrée et validée par Reviewer C (2 passes) », avec le nom du relecteur
// et le nombre de passes. Aucune délégation, aucune écriture, aucun fichier.
//
// Les deux registres au-dessus l'ont laissé passer : celui de thread-history ne
// se déclenche que sur STATE_CHANGING_TOOLS (où `assign_<slug>` ne peut pas
// figurer — ce serait un slug d'agent en dur, invariant #1), et celui-ci ne
// lisait que `agent_tasks`, la table que pose `create_task`. La délégation en
// ligne crée un `agent_jobs` enfant et ne touche jamais `agent_tasks`.
//
// Dans l'historique, un vrai compte rendu et un inventé arrivaient donc nus
// tous les deux.

describe('loadInlineDelegationLedger', () => {
  /** Un enfant de délégation EN LIGNE : lié par parent_job_id, pas par agent_tasks. */
  async function insertInlineChild(
    parentId: string,
    opts: { toolsUsed?: string[]; status?: string; channel?: string } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: opts.channel ?? 'internal',
        task: 'build the app',
        status: opts.status ?? 'completed',
        parentJobId: parentId,
        ...(opts.toolsUsed !== undefined ? { toolsUsed: opts.toolsUsed } : {}),
      })
      .returning({ id: agentJobs.id });
    return row!.id;
  }

  async function insertParent(): Promise<string> {
    const [row] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'fais-moi une app',
        status: 'completed',
      })
      .returning({ id: agentJobs.id });
    return row!.id;
  }

  it('rend les actions RÉELLES de l’enfant, pas la prose du parent', async () => {
    const parent = await insertParent();
    await insertInlineChild(parent, { toolsUsed: ['file_write', 'review_verdict'] });

    const ledger = await loadInlineDelegationLedger(db, [parent]);
    const entries = ledger.get(parent) ?? [];
    expect(entries, 'la délégation en ligne reste invisible').toHaveLength(1);
    expect(entries[0]!.toolsUsed).toEqual(['file_write', 'review_verdict']);
  });

  it('LE cas du 26/08 : un tour SANS délégation ne produit AUCUNE ligne', async () => {
    // C'est ce contraste qui manquait. Le tour inventé n'a aucun enfant ; il
    // n'aura donc aucune ligne, là où les vrais tours en portent une. Le motif
    // « demande d'app → compte rendu de livraison » cesse d'être uniforme.
    const parent = await insertParent();
    const ledger = await loadInlineDelegationLedger(db, [parent]);
    expect(ledger.get(parent) ?? []).toHaveLength(0);
  });

  it('un enfant qui n’a RIEN appelé le dit noir sur blanc', async () => {
    // Le cas le plus utile : la délégation a eu lieu et n'a rien produit. La
    // prose du parent peut affirmer le contraire ; cette ligne, non.
    const parent = await insertParent();
    await insertInlineChild(parent, { toolsUsed: [] });

    const ledger = await loadInlineDelegationLedger(db, [parent]);
    const line = formatInlineDelegationLines(ledger.get(parent) ?? [])[0]!;
    expect(line).toContain('no tool used');
  });

  it('ignore un enfant ENCORE EN COURS — il n’a pas fini d’agir', async () => {
    const parent = await insertParent();
    await insertInlineChild(parent, { toolsUsed: ['file_write'], status: 'processing' });
    const ledger = await loadInlineDelegationLedger(db, [parent]);
    expect(ledger.get(parent) ?? []).toHaveLength(0);
  });

  it('garde un enfant en ÉCHEC — un échec est un fait à rapporter', async () => {
    const parent = await insertParent();
    await insertInlineChild(parent, { toolsUsed: ['file_write'], status: 'failed' });
    const ledger = await loadInlineDelegationLedger(db, [parent]);
    const line = formatInlineDelegationLines(ledger.get(parent) ?? [])[0]!;
    expect(line).toContain('failed');
  });

  it('plafonne à MAX_TASKS_PER_EXCHANGE — un tour bavard ne mange pas le budget', async () => {
    const parent = await insertParent();
    for (let i = 0; i < MAX_TASKS_PER_EXCHANGE + 3; i++) {
      await insertInlineChild(parent, { toolsUsed: ['file_write'] });
    }
    const ledger = await loadInlineDelegationLedger(db, [parent]);
    expect(ledger.get(parent) ?? []).toHaveLength(MAX_TASKS_PER_EXCHANGE);
  });

  it('la ligne reste COURTE — elle porte les actions, pas le résultat', async () => {
    // Mesuré sur une install réelle : rendre aussi le résultat coûtait 531
    // caractères par tour concerné, soit 27 % du budget de thread-history sur
    // huit tours. Le résultat est déjà dans la prose du parent.
    const parent = await insertParent();
    await insertInlineChild(parent, { toolsUsed: ['file_write', 'file_edit', 'review_verdict'] });
    const ledger = await loadInlineDelegationLedger(db, [parent]);
    const line = formatInlineDelegationLines(ledger.get(parent) ?? [])[0]!;
    expect(line.length, `ligne trop longue : ${line}`).toBeLessThan(140);
    expect(line).not.toContain('result:');
  });

  it('ignore un enfant du TABLEAU DE TÂCHES — sinon il compterait double', async () => {
    // `create_task` pose son enfant avec le MÊME parent_job_id que la
    // délégation en ligne (execute-ready.ts:207). Sans le filtre de canal, le
    // même enfant serait rendu deux fois : une par loadTaskLedger, une ici.
    const parent = await insertParent();
    await insertInlineChild(parent, { toolsUsed: ['file_write'], channel: 'task-board' });

    const ledger = await loadInlineDelegationLedger(db, [parent]);
    expect(ledger.get(parent) ?? [], 'enfant du tableau de tâches compté deux fois').toHaveLength(
      0,
    );
  });

  it('ne mélange pas les enfants de deux tours différents', async () => {
    const a = await insertParent();
    const b = await insertParent();
    await insertInlineChild(a, { toolsUsed: ['file_write'] });
    await insertInlineChild(b, { toolsUsed: ['web_search'] });

    const ledger = await loadInlineDelegationLedger(db, [a, b]);
    expect(ledger.get(a)![0]!.toolsUsed).toEqual(['file_write']);
    expect(ledger.get(b)![0]!.toolsUsed).toEqual(['web_search']);
  });
});
