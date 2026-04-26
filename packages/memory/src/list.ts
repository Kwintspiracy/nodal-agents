// @nodalai/memory — listMemories() with pagination + filter combinators

import { eq, and, sql, desc } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import { agentMemory } from '@nodalai/db';
import type { AgentMemory } from '@nodalai/shared';
import { MemoryError } from './errors.js';
import type { ListOptions, PagedResult } from './types.js';
import { rowToMemory } from './crud.js';
import type { MemoryRow } from './crud.js';

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

export async function listMemories(
  db: AnyDrizzleDb,
  opts: ListOptions,
): Promise<PagedResult<AgentMemory>> {
  const { entityId } = opts;

  if (!entityId) {
    throw new MemoryError('INVALID_ENTITY', 'memory.list.entity_id_required');
  }

  // Clamp / default page — values ≤ 0 default to 1
  const rawPage = opts.page ?? 1;
  const page = rawPage <= 0 ? 1 : rawPage;

  // Clamp pageSize to [1, 200]
  const rawSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, rawSize), MAX_PAGE_SIZE);

  const offset = (page - 1) * pageSize;

  // ── Build WHERE conditions ────────────────────────────────────────────────

  const conditions = buildConditions(opts);

  // ── Sort column ───────────────────────────────────────────────────────────
  const sortExpr = buildSort(opts.sort);

  // ── Total count ───────────────────────────────────────────────────────────
  const countRows = await db
    .select({ count: sql<string>`count(*)` })
    .from(agentMemory)
    .where(conditions);

  const totalCount = Number(countRows[0]?.count ?? 0);

  // ── Items ─────────────────────────────────────────────────────────────────
  const rows = await (db
    .select()
    .from(agentMemory)
    .where(conditions)
    .orderBy(sortExpr)
    .limit(pageSize)
    .offset(offset) as unknown as Promise<MemoryRow[]>);

  const items = rows.map((r) => rowToMemory(r));

  return {
    items,
    page,
    pageSize,
    totalCount,
    hasMore: offset + items.length < totalCount,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildConditions(opts: ListOptions) {
  const clauses = [
    eq(agentMemory.entityId, opts.entityId),
    eq(agentMemory.archived, opts.archived ?? false),
  ];

  if (opts.agentId) {
    clauses.push(eq(agentMemory.agentId, opts.agentId));
  }

  if (opts.category) {
    clauses.push(eq(agentMemory.category, opts.category));
  }

  // OR filter on tags: any memory whose skill_tags overlaps the set
  if (opts.tags && opts.tags.length > 0) {
    clauses.push(sql`${agentMemory.skillTags} && ${sql.raw(pgTextArray(opts.tags))}::text[]`);
  }

  return and(...clauses);
}

function buildSort(sort: ListOptions['sort'] = 'recent') {
  switch (sort) {
    case 'importance':
      return desc(agentMemory.importance);
    case 'last_accessed':
      return desc(agentMemory.lastAccessedAt);
    case 'recent':
    default:
      return desc(agentMemory.updatedAt);
  }
}

/** Build a Postgres text[] literal from a JS string array using single-quoted strings. */
function pgTextArray(values: string[]): string {
  const escaped = values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(',');
  return `ARRAY[${escaped}]`;
}
