// workflows/stack.ts — la stack que le banc mesure : qui elle est, et si elle est libre.
//
// Le banc des workflows parle à une VRAIE stack (celle du propriétaire, avec
// ses agents). Trois questions lui sont posées avant, pendant et après chaque
// essai :
//   - quelle version et quel commit tournent (sans cela, une mesure n'est
//     rattachée à rien et aucune régression ne se lit d'une version à l'autre) ;
//   - quelqu'un d'autre travaille-t-il en ce moment (le banc ne tourne JAMAIS
//     par-dessus un job du propriétaire) ;
//   - où sont les dossiers de travail (un scénario qui produit un fichier est
//     jugé sur le fichier, sur le disque).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { nodalHomeEntry, nodalHomePath } from '@nodal-agents/shared/nodal-home';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { AgentId, EntityId } from '@nodal-agents/orchestration';
import { executeRows } from './facts';

/** Le préfixe de l'étiquette `caller` que le banc pose sur chacun de ses jobs. */
export const BENCH_CALLER_PREFIX = 'nodal-bench/';

const LocalConfigSchema = z.object({
  ports: z
    .object({ postgres: z.number().int().optional(), web: z.number().int().optional() })
    .partial()
    .optional(),
  postgresPassword: z.string().optional(),
});

/** L'URL de la base de la stack locale, lue dans ~/.nodalai/config.json comme le fait le CLI. */
export function stackDatabaseUrl(): string {
  const path = nodalHomeEntry('config.json');
  if (!existsSync(path)) {
    throw new Error(
      `workflow_no_stack: ${path} is missing, the stack never started on this machine`,
    );
  }
  const cfg = LocalConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!cfg.postgresPassword)
    throw new Error(`workflow_no_stack: postgresPassword missing in ${path}`);
  const port = cfg.ports?.postgres ?? 25444;
  return `postgresql://nodalai:${encodeURIComponent(cfg.postgresPassword)}@localhost:${port}/nodalai`;
}

/**
 * L'adresse du dashboard de la stack (`ports.web` de ~/.nodalai/config.json,
 * 3000 par défaut, comme le CLI) : Bench Studio y renvoie pour ouvrir un run.
 */
export function stackWebUrl(): string {
  const path = nodalHomeEntry('config.json');
  const cfg = existsSync(path)
    ? LocalConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : { ports: undefined };
  return `http://localhost:${cfg.ports?.web ?? 3000}`;
}

/**
 * La configuration du banc, sur la machine qui l'héberge : ~/.nodalai/bench.json.
 * Elle déclare les services locaux que des scénarios demandent (ComfyUI) et
 * leur adresse : rien de tout cela n'est écrit dans le code (invariant #6).
 * Absente : aucun service n'est déclaré, et les scénarios qui en demandent un
 * sont sautés en le disant.
 */
export const BENCH_CONFIG_FILE = nodalHomePath('bench.json');

const BenchConfigSchema = z
  .object({
    services: z.record(z.string(), z.string().url()).default({}),
  })
  .strict();
export type BenchConfig = z.infer<typeof BenchConfigSchema>;

/** Lit la configuration du banc ; un fichier illisible ou mal formé est une erreur, jamais une config vide. */
export function readBenchConfig(path: string = BENCH_CONFIG_FILE): BenchConfig {
  if (!existsSync(path)) return { services: {} };
  try {
    return BenchConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(
      `workflow_bad_bench_config: ${path} cannot be read: ${String(e instanceof Error ? e.message : e)}`,
    );
  }
}

/**
 * Sonde un service local déclaré : une requête GET sur son adresse, trois
 * secondes au plus. Toute réponse HTTP 2xx compte ; le reste est dit tel quel.
 */
export async function probeService(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<string | null> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

export async function openStackDb(): Promise<{ db: AnyDrizzleDb; close: () => Promise<void> }> {
  const { createClient } = await import('@nodal-agents/db');
  const client = createClient(stackDatabaseUrl(), { max: 2 });
  return { db: client.db as unknown as AnyDrizzleDb, close: client.close };
}

// ─── Qui tourne ──────────────────────────────────────────────────────────────

/** La version que la stack sert : celle du paquet publié, `apps/cli/package.json`. */
export function readStackVersion(stackDir: string): string {
  const path = join(stackDir, 'apps', 'cli', 'package.json');
  const pkg = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8')));
  return pkg.version;
}

/**
 * Le commit extrait dans le dossier de la stack, lu dans `.git` sans lancer git.
 *
 * `.git` est un dossier (dépôt) ou un fichier `gitdir: …` (worktree) ; HEAD est
 * un sha (tête détachée) ou `ref: refs/heads/x`, résolu dans le dossier du
 * worktree, puis dans le dépôt commun, puis dans `packed-refs`. Rend null quand
 * rien de tout cela n'existe : la ligne dira « commit inconnu », jamais un faux.
 */
export function readStackCommit(stackDir: string): string | null {
  const dotGit = join(stackDir, '.git');
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m?.[1]) return null;
    gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(stackDir, m[1].trim());
  }
  const commonFile = join(gitDir, 'commondir');
  const commonDir = existsSync(commonFile)
    ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
    : gitDir;
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) return null;
  const head = readFileSync(headPath, 'utf8').trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (!ref) return null;
  for (const dir of [gitDir, commonDir]) {
    const p = join(dir, ref);
    if (existsSync(p)) {
      const sha = readFileSync(p, 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  }
  const packed = join(commonDir, 'packed-refs');
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  }
  return null;
}

// ─── Qui travaille ───────────────────────────────────────────────────────────

export interface ForeignActivity {
  /** Jobs vivants qui n'appartiennent à aucun essai du banc. */
  readonly jobs: ReadonlyArray<{
    id: string;
    status: string | null;
    channel: string;
    agentSlug: string | null;
  }>;
  /** Heure (ms) de la dernière trace d'un tour de chat récent, sinon null. */
  readonly lastChatMs: number | null;
}

const ActiveRow = z.object({
  id: z.string(),
  status: z.string().nullable(),
  channel: z.string(),
  slug: z.string().nullable(),
  bench: z.boolean(),
});

/**
 * Ce que le propriétaire fait en ce moment, vu de la base : ses jobs vivants
 * (tout job non terminal dont la tête n'est pas un essai du banc) et un tour de
 * chat récent. Un tour de chat n'est pas un job ; il laisse, selon le runtime
 * de l'agent :
 *   - en API : des `llm_calls` de source `chat` ;
 *   - sous Claude Code ou Codex (`runCliRuntimeChatTurn`) : AUCUN `llm_calls`,
 *     mais des `tool_calls` sans job écrits PENDANT le tour, puis une ligne
 *     `cli_runs` sans job à sa fin.
 * Les trois comptent. Un essai du banc passe toujours par un job : ses lignes
 * ont un `job_id`, elles ne sont jamais prises pour du chat.
 */
export async function readForeignActivity(
  db: AnyDrizzleDb,
  chatWindowMs: number,
): Promise<ForeignActivity> {
  const { sql } = await import('@nodal-agents/db');
  const rows = z.array(ActiveRow).parse(
    await executeRows(
      db,
      sql`
      with recursive up as (
        select j.id as job_id, j.id as cur, j.parent_job_id as parent
          from agent_jobs j
         where j.status is null or j.status not in ('completed', 'failed', 'cancelled')
        union all
        select up.job_id, p.id, p.parent_job_id
          from up join agent_jobs p on p.id = up.parent
      )
      select j.id::text, j.status, j.channel, a.slug,
             coalesce(r.trigger_context->>'caller', '') like ${BENCH_CALLER_PREFIX + '%'} as bench
        from up
        join agent_jobs j on j.id = up.job_id
        join agent_jobs r on r.id = up.cur
        left join agents a on a.id = j.agent_id
       where up.parent is null`,
    ),
  );
  const since = sql`now() - make_interval(secs => ${chatWindowMs / 1000})`;
  const chat = z.array(z.object({ last: numOrNull })).parse(
    await executeRows(
      db,
      sql`
        select (extract(epoch from max(t)) * 1000)::float8 as last from (
          select max(created_at) as t from llm_calls
           where source = 'chat' and created_at > ${since}
          union all
          select max(created_at) from cli_runs
           where job_id is null and created_at > ${since}
          union all
          select max(created_at) from tool_calls
           where job_id is null and created_at > ${since}
        ) chat_traces`,
    ),
  );
  return {
    jobs: rows
      .filter((r) => !r.bench)
      .map((r) => ({ id: r.id, status: r.status, channel: r.channel, agentSlug: r.slug })),
    lastChatMs: chat[0]?.last ?? null,
  };
}

const numOrNull = z.union([z.null(), z.coerce.number()]);

/** Les têtes d'essai du banc encore vivantes — laissées par un banc interrompu. */
export async function readLiveBenchRoots(
  db: AnyDrizzleDb,
): Promise<Array<{ id: string; entityId: string }>> {
  const { sql } = await import('@nodal-agents/db');
  return z
    .array(z.object({ id: z.string(), entity_id: z.string() }))
    .parse(
      await executeRows(
        db,
        sql`
        with recursive tree as (
          select id as root, id from agent_jobs
           where parent_job_id is null
             and trigger_context->>'caller' like ${BENCH_CALLER_PREFIX + '%'}
          union all
          select tree.root, j.id from agent_jobs j join tree on j.parent_job_id = tree.id
        )
        select distinct r.id::text, r.entity_id::text
          from tree
          join agent_jobs j on j.id = tree.id
          join agent_jobs r on r.id = tree.root
         where (j.status is null or j.status not in ('completed', 'failed', 'cancelled'))
            or exists (select 1 from approval_requests ar where ar.job_id = j.id and ar.status = 'pending')`,
      ),
    )
    .map((r) => ({ id: r.id, entityId: r.entity_id }));
}

/** Annule un arbre par le chemin officiel (`cancelJobTree`, le même que le bouton Stop). */
export async function cancelTree(
  db: AnyDrizzleDb,
  entityId: string,
  rootId: string,
): Promise<{ jobIds: string[]; requestIds: string[] }> {
  const { cancelJobTree } = await import('@nodal-agents/db');
  const r = await cancelJobTree(db, { entityId, jobId: rootId });
  return { jobIds: r.jobIds, requestIds: r.requestIds };
}

// ─── Ce que l'équipe sait faire ──────────────────────────────────────────────

/**
 * Les outils que les agents ACTIFS de l'espace peuvent appeler, sous le nom
 * que le produit leur donne (`<serveur>__outil` pour un serveur MCP, le nom de
 * l'opération pour un connecteur adaptateur). La règle est celle du produit,
 * `computeAgentToolNames` (@nodal-agents/orchestration) : connecteurs
 * adaptateurs ET serveurs MCP, listes blanches par agent comprises.
 *
 * Le banc lisait seulement `mcp_servers.available_tools` : Gmail, connecteur
 * adaptateur, lui était invisible, et le garde « aucun connecteur ne sait
 * envoyer un e-mail » a laissé partir sept e-mails (#711). Les outils de
 * livraison sont comptés (`hasDeliveryRecipient: true`) : un garde se trompe
 * du côté prudent.
 */
export async function readTeamTools(db: AnyDrizzleDb, entityId: string): Promise<string[]> {
  const { sql } = await import('@nodal-agents/db');
  const { computeAgentToolNames } = await import('@nodal-agents/orchestration');
  const agents = z.array(z.object({ id: z.string() })).parse(
    await executeRows(
      db,
      sql`
        select id::text from agents
         where entity_id = ${entityId}::uuid and coalesce(active, true) = true
         order by id`,
    ),
  );
  const names = new Set<string>();
  for (const a of agents) {
    const tools = await computeAgentToolNames(a.id as AgentId, entityId as EntityId, db, {
      hasDeliveryRecipient: true,
    });
    for (const n of tools) names.add(n);
  }
  return [...names].sort();
}

/**
 * Les serveurs MCP attribués à un agent actif de l'espace dont les outils ne
 * sont pas connus : la règle du runner (`isUsableMcpToolCache`,
 * @nodal-agents/adapter-mcp), qui s'y connecte alors au lancement du job et
 * peut offrir des outils qu'aucune liste ne montre encore. Triés par slug.
 */
export async function readUnlistedMcpServers(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<string[]> {
  const { sql } = await import('@nodal-agents/db');
  const { isUsableMcpToolCache } = await import('@nodal-agents/adapter-mcp');
  const rows = z.array(z.object({ slug: z.string(), tools: z.unknown() })).parse(
    await executeRows(
      db,
      sql`
        select distinct s.slug, s.available_tools as tools
          from agent_mcp_servers ams
          join mcp_servers s on s.id = ams.mcp_server_id
          join agents a on a.id = ams.agent_id
         where ams.entity_id = ${entityId}::uuid and coalesce(a.active, true) = true`,
    ),
  );
  return [...new Set(rows.filter((r) => !isUsableMcpToolCache(r.tools)).map((r) => r.slug))].sort();
}

/** Le modèle configuré de l'agent racine de l'espace (`agents.model`), ou null s'il n'en a pas. */
export async function readRootModel(db: AnyDrizzleDb, entityId: string): Promise<string | null> {
  const { sql } = await import('@nodal-agents/db');
  const rows = z.array(z.object({ model: z.string().nullable() })).parse(
    await executeRows(
      db,
      sql`
        select a.model from entities e join agents a on a.id = e.root_agent_id
         where e.id = ${entityId}::uuid`,
    ),
  );
  return rows[0]?.model ?? null;
}

/**
 * Les fournisseurs de modèles qu'un espace peut appeler : ceux de ses clés LLM
 * actives (`entity_llm_keys`). Une ligne compte quand elle porte une clé, ou
 * une adresse sans clé (un serveur local). Jamais une clé ni sa fin : le nom du
 * fournisseur seulement.
 */
export async function readKeyProviders(db: AnyDrizzleDb, entityId: string): Promise<string[]> {
  const { sql } = await import('@nodal-agents/db');
  const rows = z.array(z.object({ provider: z.string() })).parse(
    await executeRows(
      db,
      sql`
        select distinct provider from entity_llm_keys
         where entity_id = ${entityId}::uuid and is_active
           and (api_key <> '' or base_url is not null)
         order by provider`,
    ),
  );
  return rows.map((r) => r.provider);
}

// ─── Où sont les fichiers ────────────────────────────────────────────────────

/**
 * Les dossiers de travail d'un espace : le dossier partagé que le produit
 * résout lui-même (`workspacesRoot()/<entité>/shared`), puis chaque dossier
 * rattaché à un agent de l'espace. Sans doublon, dans cet ordre.
 */
export async function readWorkspaceRoots(db: AnyDrizzleDb, entityId: string): Promise<string[]> {
  const { sql } = await import('@nodal-agents/db');
  const { workspacesRoot, SHARED_WORKSPACE_LABEL } = await import('@nodal-agents/tools');
  const rows = z.array(z.object({ path: z.string() })).parse(
    await executeRows(
      db,
      sql`
        select distinct path from agent_workspaces where entity_id = ${entityId}::uuid order by path`,
    ),
  );
  const roots = [
    join(workspacesRoot(), entityId, SHARED_WORKSPACE_LABEL),
    ...rows.map((r) => r.path),
  ];
  return [...new Set(roots)];
}
