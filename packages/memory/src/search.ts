// @nodalai/memory — searchMemories() — hybrid embedding + keyword search

import { eq, and, sql, desc, ilike, or } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import { agentMemory } from '@nodalai/db';
import type { AgentMemory } from '@nodalai/shared';
import type { EmbeddingClient } from '@nodalai/llm';
import type { SearchOptions } from './types';
import { rowToMemory } from './crud';
import type { MemoryRow } from './crud';
import { touchMemories } from './access-tracking';

export async function searchMemories(
  db: AnyDrizzleDb,
  embeddingClient: EmbeddingClient,
  opts: SearchOptions,
): Promise<AgentMemory[]> {
  const {
    query,
    entityId,
    agentId,
    skillTags,
    category,
    limit = 10,
    similarityThreshold = 0.5,
  } = opts;

  // ── Attempt embedding ─────────────────────────────────────────────────────
  let embedding: number[] | null = null;
  try {
    embedding = await embeddingClient.embed(query);
  } catch {
    // Graceful degradation to keyword search
    embedding = null;
  }

  let results: MemoryRow[];

  if (embedding !== null) {
    results = await vectorSearch(db, embedding, {
      entityId,
      agentId,
      skillTags,
      category,
      limit,
      similarityThreshold,
    });
  } else {
    results = await keywordSearch(db, query, {
      entityId,
      agentId,
      skillTags,
      category,
      limit,
    });
  }

  const memories = results.map((r) => rowToMemory(r));

  // Bump access tracking for returned memories
  if (memories.length > 0) {
    const ids = memories.map((m) => m.id);
    await touchMemories(db, ids, entityId);
  }

  return memories;
}

// ─── Vector search ─────────────────────────────────────────────────────────────

interface SearchFilters {
  entityId: string;
  agentId?: string;
  skillTags?: string[];
  category?: string;
  limit: number;
  similarityThreshold?: number;
}

async function vectorSearch(
  db: AnyDrizzleDb,
  embedding: number[],
  filters: SearchFilters,
): Promise<MemoryRow[]> {
  const { entityId, agentId, skillTags, category, limit, similarityThreshold = 0.5 } = filters;

  // Cosine similarity: 1 - cosine_distance = similarity
  // Cosine distance in pgvector: `embedding <=> query_vector`
  // We want similarity >= threshold, i.e., distance <= (1 - threshold)
  const maxDistance = 1 - similarityThreshold;

  const embeddingLiteral = `[${embedding.join(',')}]`;

  const conditions = buildWhereConditions({ entityId, agentId, skillTags, category });

  // pgvector cosine distance operator: <=>
  // Order by distance ASC (most similar first), filter by distance threshold
  const rows = await (db
    .select()
    .from(agentMemory)
    .where(
      and(
        ...conditions,
        sql`${agentMemory.embedding} IS NOT NULL`,
        sql`(${agentMemory.embedding} <=> ${sql.raw(`'${embeddingLiteral}'::vector`)}) <= ${maxDistance}`,
      ),
    )
    .orderBy(sql`(${agentMemory.embedding} <=> ${sql.raw(`'${embeddingLiteral}'::vector`)}) ASC`)
    .limit(limit) as unknown as Promise<MemoryRow[]>);

  return rows;
}

// ─── Keyword (ILIKE) search ────────────────────────────────────────────────────

async function keywordSearch(
  db: AnyDrizzleDb,
  query: string,
  filters: Omit<SearchFilters, 'similarityThreshold'>,
): Promise<MemoryRow[]> {
  const { entityId, agentId, skillTags, category, limit } = filters;

  // Split query into meaningful words (>2 chars) and search with ILIKE
  const words = query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  const conditions = buildWhereConditions({ entityId, agentId, skillTags, category });

  // If we have usable keywords, build OR ilike conditions on fact
  if (words.length > 0) {
    const ilikeConditions = words.map((w) => ilike(agentMemory.fact, `%${w}%`));

    const rows = await (db
      .select()
      .from(agentMemory)
      .where(and(...conditions, or(...ilikeConditions)))
      .orderBy(desc(agentMemory.importance), desc(agentMemory.updatedAt))
      .limit(limit) as unknown as Promise<MemoryRow[]>);

    return rows;
  }

  // Fallback: no usable keywords — return top memories by importance
  const rows = await (db
    .select()
    .from(agentMemory)
    .where(and(...conditions))
    .orderBy(desc(agentMemory.importance), desc(agentMemory.updatedAt))
    .limit(limit) as unknown as Promise<MemoryRow[]>);

  return rows;
}

// ─── Shared condition builder ──────────────────────────────────────────────────

function buildWhereConditions(filters: {
  entityId: string;
  agentId?: string;
  skillTags?: string[];
  category?: string;
}) {
  const { entityId, agentId, skillTags, category } = filters;

  const conditions = [eq(agentMemory.entityId, entityId), eq(agentMemory.archived, false)];

  if (agentId) {
    conditions.push(eq(agentMemory.agentId, agentId));
  }

  if (category) {
    conditions.push(eq(agentMemory.category, category));
  }

  // Skill-tag filter — only applied when skillTags is non-empty array.
  // Empty array OR undefined → no filter (bug fix vs legacy behavior).
  // Memories with empty own skill_tags are always returned (uncategorized).
  if (skillTags && skillTags.length > 0) {
    // Return memories where:
    //   a) memory has empty skill_tags (uncategorized — always visible), OR
    //   b) memory's skill_tags overlaps the given skillTags
    const tagLiteral = pgTextArray(skillTags);
    conditions.push(
      sql`(
        ${agentMemory.skillTags} = '{}'::text[]
        OR ${agentMemory.skillTags} IS NULL
        OR ${agentMemory.skillTags} && ${sql.raw(tagLiteral)}::text[]
      )`,
    );
  }

  return conditions;
}

/** Build a Postgres text[] literal from a JS string array using single-quoted strings. */
function pgTextArray(values: string[]): string {
  const escaped = values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(',');
  return `ARRAY[${escaped}]`;
}
