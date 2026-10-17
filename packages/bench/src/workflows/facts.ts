// workflows/facts.ts — ce qu'un essai a RÉELLEMENT fait, lu dans la base.
//
// Le juge d'un scénario ne lit jamais ce que le modèle dit de lui-même : il lit
// les lignes que le runner a écrites (agent_jobs, tool_calls, llm_calls,
// cli_runs, approval_requests, job_deliveries) et, quand le scénario produit un fichier, le fichier sur
// le disque. Ce module fait la première moitié : une photo de l'arbre d'un job,
// sous une forme simple et sérialisable. C'est aussi la forme des fixtures des
// tests — une photo prise sur un vrai essai, jamais une ligne inventée.

import { z } from 'zod';
import type { AnyDrizzleDb } from '@nodal-agents/db';

type SqlQuery = Parameters<AnyDrizzleDb['execute']>[0];

export const JobFactSchema = z.object({
  id: z.string(),
  parentJobId: z.string().nullable(),
  agentSlug: z.string().nullable(),
  status: z.string().nullable(),
  channel: z.string(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdMs: z.number(),
  updatedMs: z.number().nullable(),
});
export type JobFact = z.infer<typeof JobFactSchema>;

export const ToolCallFactSchema = z.object({
  jobId: z.string().nullable(),
  toolName: z.string(),
  /** L'entrée, sérialisée telle que la base la rend (JSON). */
  input: z.string().nullable(),
  output: z.string().nullable(),
  createdMs: z.number(),
});
export type ToolCallFact = z.infer<typeof ToolCallFactSchema>;

export const LlmCallFactSchema = z.object({
  jobId: z.string().nullable(),
  /** Le modèle qui a RÉPONDU (`model_effective`). */
  model: z.string(),
  /**
   * Ce que l'agent DEMANDAIT, le fournisseur, l'effort de raisonnement, le
   * maillon de secours et les jetons de cache : absents des fixtures capturées
   * avant que le banc ne les lise (null, jamais une valeur inventée).
   */
  modelRequested: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  reasoningEffort: z.string().nullable().default(null),
  failover: z.boolean().nullable().default(null),
  /** Lectures de cache, comprises dans `inputTokens` (sémantique du SDK IA). */
  cachedTokens: z.number().nullable().default(null),
  /** Écritures de cache, comprises dans `inputTokens`. */
  cacheCreationTokens: z.number().nullable().default(null),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  createdMs: z.number(),
});
export type LlmCallFact = z.infer<typeof LlmCallFactSchema>;

/**
 * Un tour d'une CLI de code (Claude Code, Codex) qui a servi un job de l'arbre :
 * un agent sous abonnement n'écrit AUCUN `llm_calls`, sa consommation est ici.
 * Les jetons suivent la sémantique de `cli_runs` : `inputTokens` HORS cache,
 * `cachedTokens` les lectures de cache, `cacheCreationTokens` les écritures
 * (null = absent du flux). `costUsd` est le coût NOTIONNEL que la CLI rapporte
 * (Claude le rapporte même sous abonnement, Codex jamais) ; `source` dit qui a
 * payé : `subscription` (l'abonnement de la CLI) ou `api` (une clé injectée).
 */
export const CliRunFactSchema = z.object({
  jobId: z.string().nullable(),
  provider: z.string(),
  source: z.string(),
  /** Les modèles que la CLI dit avoir utilisés, sinon celui demandé ; vide = non rapporté. */
  models: z.array(z.string()),
  /** Le modèle demandé à la CLI (`cli_runs.model`). Absent des anciennes fixtures. */
  modelRequested: z.string().nullable().default(null),
  costUsd: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
  cacheCreationTokens: z.number().nullable(),
  createdMs: z.number(),
});
export type CliRunFact = z.infer<typeof CliRunFactSchema>;

export const ApprovalFactSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  kind: z.string(),
  status: z.string().nullable(),
  toolName: z.string(),
  /**
   * Ce que la carte montre : l'entrée de l'appel retenu (pour `ask_user`, la
   * question et ses options), sérialisée. Absent des fixtures capturées avant
   * que le banc ne la lise : null, jamais une entrée inventée.
   */
  input: z.string().nullable().default(null),
  resolvedBy: z.string().nullable(),
  requestedMs: z.number(),
});
export type ApprovalFact = z.infer<typeof ApprovalFactSchema>;

/**
 * Une réponse de job partie vers un canal (`job_deliveries`, l'outbox de la
 * livraison) : Telegram, Discord, Slack ou WhatsApp. `channel` est le canal de
 * TRANSPORT résolu, jamais l'origine du job.
 */
export const DeliveryFactSchema = z.object({
  jobId: z.string(),
  channel: z.string(),
  outcome: z.string(),
  createdMs: z.number(),
});
export type DeliveryFact = z.infer<typeof DeliveryFactSchema>;

/** Un appel de `return_result`, tel que le modèle l'a fait (son entrée, sérialisée). */
export const ReturnResultFactSchema = z.object({
  jobId: z.string(),
  input: z.string().nullable(),
});
export type ReturnResultFact = z.infer<typeof ReturnResultFactSchema>;

/**
 * Ce qu'un appel d'outil a fait à un fichier qu'il visait (`tool_call_writes`,
 * #779) : le chemin réel, l'état et l'empreinte avant, l'état et l'empreinte
 * après, et D'OÙ vient l'empreinte après : `written`, les octets que l'outil a
 * écrits (une preuve) ; `read`, une relecture du disque (jamais une preuve).
 * `seq` est celui de la ligne `tool_calls` de l'appel, la seule colonne
 * d'ordre fiable : deux appels parallèles ont le même instant, jamais le même
 * `seq`.
 */
const FileStateKind = z.enum(['absent', 'file', 'unreadable']);
export const FileWriteFactSchema = z.object({
  seq: z.number(),
  jobId: z.string(),
  toolName: z.string(),
  path: z.string(),
  beforeKind: FileStateKind,
  beforeSha256: z.string().nullable(),
  afterKind: FileStateKind,
  afterSha256: z.string().nullable(),
  afterSource: z.enum(['written', 'read']),
});
export type FileWriteFact = z.infer<typeof FileWriteFactSchema>;

/** L'arbre d'un essai : le job de tête, tout ce qu'il a délégué, et ce qui s'y est passé. */
export const TreeFactsSchema = z.object({
  rootId: z.string(),
  entityId: z.string().nullable(),
  jobs: z.array(JobFactSchema),
  toolCalls: z.array(ToolCallFactSchema),
  llmCalls: z.array(LlmCallFactSchema),
  /**
   * Absent des fixtures capturées avant que le banc ne lise `cli_runs` (toutes
   * sur des agents en API, sans run de CLI). `readTreeFacts` le remplit toujours.
   */
  cliRuns: z.array(CliRunFactSchema).default([]),
  approvals: z.array(ApprovalFactSchema),
  /**
   * Absent des fixtures capturées avant que le banc ne lise `job_deliveries`.
   * `readTreeFacts` le remplit toujours.
   */
  deliveries: z.array(DeliveryFactSchema).default([]),
  /**
   * Les appels de `return_result` de chaque job, dans l'ordre, lus dans son
   * transcript (`agent_jobs.messages`) : ce signal de fin ne laisse aucune
   * ligne `tool_calls`. Absent des fixtures capturées avant que le banc ne le
   * lise.
   */
  returnResults: z.array(ReturnResultFactSchema).default([]),
  /**
   * Ce que chaque appel a fait à chaque fichier qu'il visait (`tool_call_writes`),
   * dans l'ordre `seq`. Absent des fixtures capturées avant que la plateforme
   * ne l'enregistre (#779) : rien n'y est enregistré, jamais « rien écrit ».
   */
  writes: z.array(FileWriteFactSchema).default([]),
});
export type TreeFacts = z.infer<typeof TreeFactsSchema>;

/**
 * Les lignes d'une requête brute. `AnyDrizzleDb.execute` est typé `unknown` :
 * postgres-js rend un tableau, d'autres pilotes un objet `{ rows }`. Les deux
 * formes sont acceptées, toute autre est une erreur (jamais une liste vide).
 */
export async function executeRows(db: AnyDrizzleDb, query: SqlQuery): Promise<unknown[]> {
  const res: unknown = await db.execute(query);
  if (Array.isArray(res)) return [...(res as unknown[])];
  if (res && typeof res === 'object' && Array.isArray((res as { rows?: unknown }).rows)) {
    return (res as { rows: unknown[] }).rows;
  }
  throw new Error('workflow_db_shape: the database driver returned rows in an unknown shape');
}

/** Statuts qui ne bougeront plus. Le même ensemble que `TERMINAL_STATUSES` (@nodal-agents/shared). */
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Un job vit tant que son statut n'est pas terminal — un statut NULL n'a pas fini non plus. */
export function isLive(status: string | null): boolean {
  return status === null || !TERMINAL.has(status);
}

export function liveJobs(facts: TreeFacts): JobFact[] {
  return facts.jobs.filter((j) => isLive(j.status));
}

/** Les demandes (approbation ou question) encore en attente d'un humain. */
export function pendingApprovals(facts: TreeFacts): ApprovalFact[] {
  return facts.approvals.filter((a) => a.status === 'pending');
}

// Les lignes brutes : `postgres` rend des nombres en texte pour bigint/numeric,
// d'où les `::float8` du SQL et la coercition Zod ci-dessous.
const num = z.coerce.number();
const numOrNull = z.union([z.null(), z.coerce.number()]);

const RawJob = z.object({
  id: z.string(),
  parent_job_id: z.string().nullable(),
  entity_id: z.string().nullable(),
  slug: z.string().nullable(),
  status: z.string().nullable(),
  channel: z.string(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  created_ms: num,
  updated_ms: numOrNull,
});
const RawTool = z.object({
  job_id: z.string().nullable(),
  tool_name: z.string(),
  tool_input: z.string().nullable(),
  tool_output: z.string().nullable(),
  created_ms: num,
});
const RawLlm = z.object({
  job_id: z.string().nullable(),
  model_effective: z.string(),
  model_requested: z.string().nullable(),
  provider: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
  failover: z.boolean().nullable(),
  cached_tokens: numOrNull,
  cache_creation_tokens: numOrNull,
  input_tokens: numOrNull,
  output_tokens: numOrNull,
  cost_usd: numOrNull,
  duration_ms: numOrNull,
  error: z.string().nullable(),
  created_ms: num,
});
const RawCli = z.object({
  job_id: z.string().nullable(),
  provider: z.string(),
  source: z.string(),
  model: z.string().nullable(),
  model_usage: z.array(z.object({ model: z.string() })).nullable(),
  cost_usd: numOrNull,
  input_tokens: numOrNull,
  output_tokens: numOrNull,
  cached_tokens: numOrNull,
  cache_creation_tokens: numOrNull,
  created_ms: num,
});
const RawApproval = z.object({
  id: z.string(),
  job_id: z.string(),
  kind: z.string(),
  status: z.string().nullable(),
  tool_name: z.string(),
  tool_input: z.string().nullable(),
  resolved_by: z.string().nullable(),
  requested_ms: num,
});
const RawDelivery = z.object({
  job_id: z.string(),
  channel: z.string(),
  outcome: z.string(),
  created_ms: num,
});

/**
 * Photographie l'arbre d'un job : la tête et ses descendants (`parent_job_id`),
 * leurs appels d'outils, leurs appels de modèle (API et tours de CLI) et leurs
 * demandes à un humain.
 * Lecture seule.
 */
export async function readTreeFacts(db: AnyDrizzleDb, rootId: string): Promise<TreeFacts> {
  const { sql } = await import('@nodal-agents/db');
  const tree = sql`with recursive t as (
      select id from agent_jobs where id = ${rootId}::uuid
      union all
      select j.id from agent_jobs j join t on j.parent_job_id = t.id
    ) select id from t`;
  const jobs = z.array(RawJob).parse(
    await executeRows(
      db,
      sql`
      select j.id::text, j.parent_job_id::text, j.entity_id::text, a.slug, j.status, j.channel,
             j.result, j.error,
             (extract(epoch from j.created_at) * 1000)::float8 as created_ms,
             (extract(epoch from j.updated_at) * 1000)::float8 as updated_ms
        from agent_jobs j left join agents a on a.id = j.agent_id
       where j.id in (${tree})
       order by j.created_at`,
    ),
  );
  const root = jobs.find((j) => j.id === rootId);
  if (!root) throw new Error(`workflow_root_missing: job ${rootId} is not in agent_jobs`);
  const tools = z.array(RawTool).parse(
    await executeRows(
      db,
      sql`
      select job_id::text, tool_name, tool_input::text as tool_input, tool_output,
             (extract(epoch from created_at) * 1000)::float8 as created_ms
        from tool_calls where job_id in (${tree}) order by created_at`,
    ),
  );
  const llm = z.array(RawLlm).parse(
    await executeRows(
      db,
      sql`
      select job_id::text, model_effective, model_requested, provider, reasoning_effort, failover,
             cached_tokens, cache_creation_tokens,
             input_tokens, output_tokens, cost_usd::float8 as cost_usd,
             duration_ms, error,
             (extract(epoch from created_at) * 1000)::float8 as created_ms
        from llm_calls where job_id in (${tree}) order by created_at`,
    ),
  );
  const cli = z.array(RawCli).parse(
    await executeRows(
      db,
      sql`
      select job_id::text, provider, source, model, model_usage, cost_usd::float8 as cost_usd,
             input_tokens, output_tokens, cached_tokens, cache_creation_tokens,
             (extract(epoch from created_at) * 1000)::float8 as created_ms
        from cli_runs where job_id in (${tree}) order by created_at`,
    ),
  );
  const approvals = z.array(RawApproval).parse(
    await executeRows(
      db,
      sql`
      select id::text, job_id::text, kind, status, tool_name, tool_input::text as tool_input,
             resolved_by,
             (extract(epoch from requested_at) * 1000)::float8 as requested_ms
        from approval_requests where job_id in (${tree}) order by requested_at`,
    ),
  );
  const deliveries = z.array(RawDelivery).parse(
    await executeRows(
      db,
      sql`
      select job_id::text, channel, outcome,
             (extract(epoch from created_at) * 1000)::float8 as created_ms
        from job_deliveries where job_id in (${tree}) order by created_at`,
    ),
  );
  // Les parties `tool-call` du transcript — seuls les messages assistant en
  // portent (forme des messages du SDK IA : `input`, `args` dans les
  // transcripts plus anciens).
  const returnResults = z
    .array(z.object({ job_id: z.string(), input: z.string().nullable() }))
    .parse(
      await executeRows(
        db,
        sql`
      select j.id::text as job_id, coalesce(p.part->'input', p.part->'args')::text as input
        from agent_jobs j
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(j.messages) = 'array' then j.messages else '[]'::jsonb end
        ) with ordinality as m(msg, i)
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(m.msg->'content') = 'array' then m.msg->'content' else '[]'::jsonb end
        ) with ordinality as p(part, k)
       where j.id in (${tree})
         and p.part->>'type' = 'tool-call'
         and p.part->>'toolName' = 'return_result'
       order by j.created_at, j.id, m.i, p.k`,
      ),
    );
  const writes = z
    .array(
      z.object({
        seq: num,
        job_id: z.string(),
        tool_name: z.string(),
        path: z.string(),
        before_kind: FileStateKind,
        before_sha256: z.string().nullable(),
        after_kind: FileStateKind,
        after_sha256: z.string().nullable(),
        after_source: z.enum(['written', 'read']),
      }),
    )
    .parse(
      await executeRows(
        db,
        sql`
      select tc.seq::float8 as seq, w.job_id::text, tc.tool_name, w.path,
             w.before_kind, w.before_sha256, w.after_kind, w.after_sha256, w.after_source
        from tool_call_writes w join tool_calls tc on tc.id = w.tool_call_id
       where w.job_id in (${tree})
       order by tc.seq`,
      ),
    );
  return {
    rootId,
    entityId: root.entity_id,
    jobs: jobs.map((j) => ({
      id: j.id,
      parentJobId: j.parent_job_id,
      agentSlug: j.slug,
      status: j.status,
      channel: j.channel,
      result: j.result,
      error: j.error,
      createdMs: j.created_ms,
      updatedMs: j.updated_ms,
    })),
    toolCalls: tools.map((t) => ({
      jobId: t.job_id,
      toolName: t.tool_name,
      input: t.tool_input,
      output: t.tool_output,
      createdMs: t.created_ms,
    })),
    llmCalls: llm.map((l) => ({
      jobId: l.job_id,
      model: l.model_effective,
      modelRequested: l.model_requested,
      provider: l.provider,
      reasoningEffort: l.reasoning_effort,
      failover: l.failover,
      cachedTokens: l.cached_tokens,
      cacheCreationTokens: l.cache_creation_tokens,
      inputTokens: l.input_tokens,
      outputTokens: l.output_tokens,
      costUsd: l.cost_usd,
      durationMs: l.duration_ms,
      error: l.error,
      createdMs: l.created_ms,
    })),
    cliRuns: cli.map((c) => ({
      jobId: c.job_id,
      provider: c.provider,
      source: c.source,
      models: c.model_usage
        ? [...new Set(c.model_usage.map((m) => m.model))]
        : c.model
          ? [c.model]
          : [],
      modelRequested: c.model,
      costUsd: c.cost_usd,
      inputTokens: c.input_tokens,
      outputTokens: c.output_tokens,
      cachedTokens: c.cached_tokens,
      cacheCreationTokens: c.cache_creation_tokens,
      createdMs: c.created_ms,
    })),
    approvals: approvals.map((a) => ({
      id: a.id,
      jobId: a.job_id,
      kind: a.kind,
      status: a.status,
      toolName: a.tool_name,
      input: a.tool_input,
      resolvedBy: a.resolved_by,
      requestedMs: a.requested_ms,
    })),
    deliveries: deliveries.map((d) => ({
      jobId: d.job_id,
      channel: d.channel,
      outcome: d.outcome,
      createdMs: d.created_ms,
    })),
    returnResults: returnResults.map((r) => ({ jobId: r.job_id, input: r.input })),
    writes: writes.map((w) => ({
      seq: w.seq,
      jobId: w.job_id,
      toolName: w.tool_name,
      path: w.path,
      beforeKind: w.before_kind,
      beforeSha256: w.before_sha256,
      afterKind: w.after_kind,
      afterSha256: w.after_sha256,
      afterSource: w.after_source,
    })),
  };
}
