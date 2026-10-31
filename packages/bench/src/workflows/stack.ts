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
import { benchPrinterServer } from '../printer/declaration';
import { benchPrinterState, type BenchPrinterState } from '../printer/identity';
import { executeRows } from './facts';
import type { ProcessStarter, TeamMcpServer } from './types';

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
  entity_id: z.string().nullable(),
  status: z.string().nullable(),
  channel: z.string(),
  slug: z.string().nullable(),
});

/** Ce que la base dit d'un statut vivant : ni terminé, ni NULL compris comme fini. */
const LIVE_SQL = `(j.status is null or j.status not in ('completed', 'failed', 'cancelled'))`;

/**
 * Pour chaque job, la tête de son run, et si cette tête est un essai du banc.
 *
 * La tête est celle de la PLATEFORME (`runHeadOf`, @nodal-agents/db) : on
 * remonte les délégations (`parent_job_id`) ET les relances de la file
 * (`relaunched_from_job_id`, #531), dans l'espace du job. Le banc remontait
 * `parent_job_id` seul : la tête qu'un essai relance à sa fin, qui ne porte
 * pas l'étiquette du banc, passait pour un job du propriétaire, et un essai
 * laissé vivant par une relance n'était jamais retrouvé (revue de #889,
 * passe 2). Un job d'aucun espace n'appartient à aucun run : il est sa propre
 * tête.
 */
async function runHeadsOf(
  db: AnyDrizzleDb,
  jobs: ReadonlyArray<{ id: string; entityId: string | null }>,
): Promise<Map<string, { headId: string; entityId: string | null; bench: boolean }>> {
  const { inArray, agentJobs, runHeadOf } = await import('@nodal-agents/db');
  const headOf = new Map<string, string>();
  for (const j of jobs)
    headOf.set(j.id, j.entityId === null ? j.id : await runHeadOf(db, j.entityId, j.id));
  const headIds = [...new Set(headOf.values())];
  const heads =
    headIds.length === 0
      ? []
      : await db
          .select({
            id: agentJobs.id,
            entityId: agentJobs.entityId,
            triggerContext: agentJobs.triggerContext,
          })
          .from(agentJobs)
          .where(inArray(agentJobs.id, headIds));
  const byId = new Map(heads.map((h) => [h.id, h]));
  const out = new Map<string, { headId: string; entityId: string | null; bench: boolean }>();
  for (const [jobId, headId] of headOf) {
    const head = byId.get(headId);
    const caller = (head?.triggerContext as { caller?: unknown } | null)?.caller;
    out.set(jobId, {
      headId,
      entityId: head?.entityId ?? null,
      bench: typeof caller === 'string' && caller.startsWith(BENCH_CALLER_PREFIX),
    });
  }
  return out;
}

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
      select j.id::text, j.entity_id::text, j.status, j.channel, a.slug
        from agent_jobs j
        left join agents a on a.id = j.agent_id
       where ${sql.raw(LIVE_SQL)}
       order by j.created_at, j.id`,
    ),
  );
  const heads = await runHeadsOf(
    db,
    rows.map((r) => ({ id: r.id, entityId: r.entity_id })),
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
      .filter((r) => !heads.get(r.id)!.bench)
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
  // Ce qui tient encore un run : un job vivant, ou une demande en attente.
  const holding = z.array(z.object({ id: z.string(), entity_id: z.string().nullable() })).parse(
    await executeRows(
      db,
      sql`
        select j.id::text, j.entity_id::text
          from agent_jobs j
         where ${sql.raw(LIVE_SQL)}
            or exists (select 1 from approval_requests ar where ar.job_id = j.id and ar.status = 'pending')
         order by j.created_at, j.id`,
    ),
  );
  const heads = await runHeadsOf(
    db,
    holding.map((r) => ({ id: r.id, entityId: r.entity_id })),
  );
  const roots = new Map<string, string>();
  for (const h of heads.values())
    if (h.bench && h.entityId !== null) roots.set(h.headId, h.entityId);
  return [...roots].map(([id, entityId]) => ({ id, entityId }));
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
 * Les agents actifs de l'espace qui peuvent lancer un processus pendant un
 * essai (besoin `no-real-printer`). La classification est celle du PRODUIT :
 * la déclaration `egress: 'process'` de chaque outil que Nodal sert
 * (`servedToolDefinitions`, où un test la rend obligatoire : la même liste que
 * le contrôle d'avant essai, space/guard.ts), croisée avec les outils qu'un job
 * de l'agent recevrait vraiment (`resolveAgentToolNames`, la liste du runner,
 * tâches et délégation comprises). Un tel outil ne compte pas
 * quand la règle d'accord qui gagne pour lui est `block` (`matchApprovalRule`,
 * la règle de l'exécution) : l'agent le tient mais ne le lancera jamais. Ce
 * n'est pas une exception par outil : `declare_verification`, toujours donné à
 * tout agent, se ferme ainsi comme `run_command`. Un agent en runtime de CLI
 * en lance de lui-même : ses outils ne passent pas par la liste de Nodal.
 */
export async function readProcessStarters(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<ProcessStarter[]> {
  const { sql } = await import('@nodal-agents/db');
  const { resolveAgentToolNames, servedToolDefinitions } =
    await import('@nodal-agents/orchestration');
  const { matchApprovalRule } = await import('@nodal-agents/tools');
  const d = await import('@nodal-agents/db');
  const rules = await db
    .select({
      id: d.approvalRules.id,
      entityId: d.approvalRules.entityId,
      agentId: d.approvalRules.agentId,
      toolName: d.approvalRules.toolName,
      action: d.approvalRules.action,
      conditionJson: d.approvalRules.conditionJson,
    })
    .from(d.approvalRules)
    .where(d.eq(d.approvalRules.entityId, entityId));
  const processTools = new Set(
    servedToolDefinitions()
      .filter((t) => t.egress === 'process')
      .map((t) => t.name),
  );
  const agents = z
    .array(z.object({ id: z.string(), slug: z.string(), runtime: z.string().nullable() }))
    .parse(
      await executeRows(
        db,
        sql`
        select id::text, slug, runtime from agents
         where entity_id = ${entityId}::uuid and coalesce(active, true) = true
         order by slug`,
      ),
    );
  const out: ProcessStarter[] = [];
  for (const a of agents) {
    // Ce qu'un job de l'agent recevrait vraiment : la liste du runner (#863).
    const names = await resolveAgentToolNames(db, a.id);
    const tools = [...names]
      .filter((n) => processTools.has(n))
      .filter((n) => matchApprovalRule(rules as never, n, a.id, entityId)?.action !== 'block')
      .sort();
    const runtime = a.runtime !== null && a.runtime !== 'nodal' ? a.runtime : null;
    if (tools.length > 0 || runtime !== null) out.push({ agent: a.slug, tools, runtime });
  }
  return out;
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

/** Un serveur MCP actif attribué à un agent actif de l'espace, tel que la base le déclare. */
interface AttachedRow {
  readonly slug: string;
  readonly transport: string;
  readonly command: string | null;
  readonly args: string[] | null;
  readonly envVars: unknown;
  readonly tools: unknown;
}

async function readAttachedMcpServers(db: AnyDrizzleDb, entityId: string): Promise<AttachedRow[]> {
  const { sql } = await import('@nodal-agents/db');
  const rows = z
    .array(
      z.object({
        slug: z.string(),
        transport: z.string(),
        command: z.string().nullable(),
        args: z.array(z.string()).nullable(),
        env_vars: z.unknown(),
        tools: z.unknown(),
      }),
    )
    .parse(
      await executeRows(
        db,
        sql`
          select distinct s.slug, s.transport, s.command, s.args, s.env_vars, s.available_tools as tools
            from agent_mcp_servers ams
            join mcp_servers s on s.id = ams.mcp_server_id
            join agents a on a.id = ams.agent_id
           where ams.entity_id = ${entityId}::uuid
             and coalesce(a.active, true) = true
             and coalesce(s.active, true) = true`,
      ),
    );
  return rows.map((r) => ({
    slug: r.slug,
    transport: r.transport,
    command: r.command,
    args: r.args,
    envVars: r.env_vars,
    tools: r.tools,
  }));
}

/**
 * L'imprimante du banc (#794) telle que l'espace la déclare : les serveurs MCP
 * ACTIFS attribués à un agent actif de l'espace, jugés par `benchPrinterState`.
 * Son identité est sa déclaration entière, comparée à ce que
 * `benchPrinterServer` rend pour le dossier qu'elle porte ; `expectedDir`, le
 * dossier que le banc a donné à l'instance, quand il le sait.
 */
export async function readBenchPrinter(
  db: AnyDrizzleDb,
  entityId: string,
  expectedDir: string | null = null,
): Promise<BenchPrinterState> {
  // L'environnement est relu comme le runner le lit avant de lancer le
  // serveur : chaque valeur déchiffrée (`decryptMcpServerEnv`). Une valeur qui
  // ne se déchiffre pas est un serveur que le runner écarterait : il est dit.
  const { decryptMcpServerEnv } = await import('@nodal-agents/db');
  const rows = (await readAttachedMcpServers(db, entityId)).map((r) => {
    try {
      return { ...r, envVars: decryptMcpServerEnv(r.envVars) };
    } catch (e) {
      return { ...r, envError: String(e instanceof Error ? e.message : e) };
    }
  });
  return benchPrinterState(rows, benchPrinterServer, expectedDir);
}

/**
 * Les serveurs MCP de l'équipe autres que l'imprimante du banc, avec les noms
 * de leurs outils (`tools: null` : jamais listés, ils peuvent offrir n'importe
 * quoi). Lus pour le besoin `bench-printer` : fermé par défaut.
 */
export async function readTeamMcpServers(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<TeamMcpServer[]> {
  const { isUsableMcpToolCache } = await import('@nodal-agents/adapter-mcp');
  const out = new Map<string, TeamMcpServer>();
  for (const r of await readAttachedMcpServers(db, entityId)) {
    const tools = isUsableMcpToolCache(r.tools) ? r.tools.map((x) => x.name) : null;
    const known = out.get(r.slug);
    // Le même serveur attribué à deux agents : si l'une des lignes est inconnue, il l'est.
    out.set(r.slug, {
      slug: r.slug,
      tools:
        tools === null || known?.tools === null
          ? null
          : [...new Set([...(known?.tools ?? []), ...tools])],
    });
  }
  return [...out.values()].sort((x, y) => x.slug.localeCompare(y.slug));
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
