// server.ts — Nodal exposé comme serveur MCP, en stdio.
//
// Prouvé avant d'être écrit (23/08) : un vrai `claude -p --strict-mcp-config
// --mcp-config <fichier>` voit l'outil, l'appelle, et sa réponse remonte. Le
// point qui décidait de tout : `--strict-mcp-config` veut dire « UNIQUEMENT les
// serveurs que je te donne », pas « aucun ». Le confinement de la PR #6 reste
// donc entier — la config personnelle de l'utilisateur n'entre pas — et Nodal
// peut quand même exposer les siens.
//
// UN SEUL OUTIL : `run_task`. Le contrat de la surface chat, appliqué ici pour
// la même raison — un appel MCP n'est pas un job, donc il ne reçoit pas les
// outils d'un job. Il crée un job, et le job exécute avec toutes ses gardes
// (approbations, audit, compteurs, hiérarchie). Voir tools.ts pour l'autopsie
// de la version qui exposait les outils internes directement.
//
// STDIO UNIQUEMENT. Aucune écoute réseau ici, et ce n'est pas une omission :
// un point d'entrée qui crée des jobs exige une authentification que ce lot ne
// livre pas. En stdio, le serveur est un sous-processus du client — sa
// confiance est exactement celle de ce shell.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { agents, agentJobs, entities, and, eq, isNotNull } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { runTaskInputSchema, RUN_TASK_DESCRIPTION } from './tools';

export interface McpServerOptions {
  db: AnyDrizzleDb;
  /**
   * AU NOM DE QUI le client appelle. C'est le SEUL paramètre d'identité :
   * l'entité est lue depuis la ligne agent, jamais fournie par l'appelant.
   * La review a montré pourquoi — `agentId` de l'entité A plus `entityId` de
   * l'entité B fabriquait une écriture inter-workspace signée par A.
   *
   * OPTIONNEL, et c'est un invariant (#6, pas de réglage par utilisateur codé
   * en dur) : « quel agent orchestre » varie d'une installation à l'autre, donc
   * aucun nom d'agent ne doit vivre dans une config d'exemple. Absent, le
   * serveur résout l'AGENT RACINE du workspace — `entities.root_agent_id`, une
   * donnée par installation. Ambigu (plusieurs workspaces) ⇒ échec fort qui
   * liste les choix, jamais un tirage silencieux.
   */
  agentId?: string;
  name?: string;
  version?: string;
  /**
   * Plafond de jobs créés par ce processus serveur. Les compteurs anti-boucle
   * de Nodal vivent DANS un job (tours, outils, profondeur) — ils ne bornent
   * pas le nombre de jobs racines qu'une surface externe injecte. Un client en
   * boucle créerait sinon des racines payantes sans limite (constat review).
   * Le processus est jetable : relancer le serveur remet le compteur à zéro,
   * ce qui est un geste HUMAIN — c'est exactement la friction voulue.
   */
  maxJobsPerProcess?: number;
}

const DEFAULT_MAX_JOBS_PER_PROCESS = 20;

/**
 * L'interrupteur maitre. Defaut FERME (migration 0081) : un point d'entree
 * externe qui cree des jobs s'ouvre par un geste explicite du proprietaire,
 * il n'existe pas parce qu'un paquet est installe. Meme motif que le
 * master-switch LAN de run_command.
 */
async function assertMcpEnabled(db: AnyDrizzleDb, entityId: string): Promise<void> {
  const [row] = await db
    .select({ enabled: entities.mcpServerEnabled })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!row?.enabled) {
    throw new Error(
      'mcp_disabled: the MCP server is switched off for this workspace. ' +
        'Enable it in the dashboard (Settings) before connecting clients.',
    );
  }
}

/**
 * L'identité par défaut : l'agent racine du workspace, lu en base.
 *
 * Une installation n'a en général qu'un workspace ; s'il y en a plusieurs, on
 * refuse de choisir — un serveur qui tirerait le premier au hasard signerait
 * des jobs au nom d'un agent que personne n'a désigné.
 */
async function resolveRootAgentId(db: AnyDrizzleDb): Promise<string> {
  const rows = await db
    .select({ entityName: entities.name, rootAgentId: entities.rootAgentId })
    .from(entities)
    .where(isNotNull(entities.rootAgentId));

  if (rows.length === 1 && rows[0]!.rootAgentId) return rows[0]!.rootAgentId;

  if (rows.length === 0) {
    throw new Error(
      'mcp_no_root_agent: no workspace has a root agent configured. Pass agentId ' +
        'explicitly, or set a root agent in the dashboard.',
    );
  }
  throw new Error(
    `mcp_ambiguous_root_agent: ${rows.length} workspaces have a root agent ` +
      `(${rows.map((r) => r.entityName).join(', ')}). Pass agentId explicitly to ` +
      `choose which one this server speaks for.`,
  );
}

/**
 * Construit le serveur sans le connecter — pour que les tests puissent
 * l'inspecter sans ouvrir de transport.
 *
 * Échoue FORT si l'agent n'existe pas ou est inactif : la review a montré
 * qu'un `agentId` inventé recevait quand même les outils de création. Un
 * serveur au nom de personne n'a rien à servir.
 */
export async function buildNodalMcpServer(opts: McpServerOptions): Promise<McpServer> {
  const agentId = opts.agentId ?? (await resolveRootAgentId(opts.db));

  const [agentRow] = await opts.db
    .select({ id: agents.id, entityId: agents.entityId, active: agents.active })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agentRow || !agentRow.active) {
    throw new Error(
      `mcp_agent_not_found: no active agent with id "${agentId}". ` +
        `This server speaks FOR one agent; without it there is nothing to expose.`,
    );
  }
  // Un agent SANS entité était accepté, et comme l'interrupteur est par
  // entité, il n'était alors jamais vérifié : le serveur créait des jobs alors
  // qu'aucun workspace n'avait rien activé (constat review). L'absence
  // d'entité est un refus fort, pas une raison de sauter la garde.
  if (!agentRow.entityId) {
    throw new Error(
      `mcp_agent_without_entity: agent "${agentId}" belongs to no workspace, so the ` +
        `per-workspace MCP switch cannot apply. Refusing rather than running unguarded.`,
    );
  }
  const entityId = agentRow.entityId;
  await assertMcpEnabled(opts.db, entityId);

  const server = new McpServer({
    name: opts.name ?? 'nodal',
    version: opts.version ?? '0.1.0',
  });

  // Valide FORT plutot que de tolerer : `jobsCreated >= NaN` est toujours
  // faux, donc un NaN — le resultat typique d un Number(process.env.X) mal
  // ecrit — desactivait le plafond EN SILENCE. Infinity pareil, et 2.5
  // autorisait trois jobs au lieu des deux annonces. Une protection anti-boucle
  // qui disparait sans un mot est pire qu absente : on croit couverte une
  // surface qui ne l est pas (invariant #4).
  const maxJobs = opts.maxJobsPerProcess ?? DEFAULT_MAX_JOBS_PER_PROCESS;
  if (!Number.isInteger(maxJobs) || maxJobs < 1) {
    throw new Error(
      `mcp_invalid_job_cap: maxJobsPerProcess must be a positive integer, got ` +
        `${String(maxJobs)}. Refusing to start with a cap that cannot enforce anything.`,
    );
  }
  let jobsCreated = 0;

  server.registerTool(
    'run_task',
    {
      description: RUN_TASK_DESCRIPTION,
      inputSchema: runTaskInputSchema.shape,
    },
    async (args: unknown) => {
      // Le siege est RESERVE avant l attente, pas verifie puis incremente
      // apres : la premiere version faisait contrele -> insert (await) ->
      // increment, et dix appels concurrents observaient tous la meme valeur
      // avant qu aucun ne l incremente — dix jobs payants sous un plafond de
      // deux (constat passe 2). L increment synchrone AVANT le premier await
      // ferme la fenetre : Node n intercale rien entre ces deux lignes.
      // Un insert qui echoue rend son siege dans le catch.
      let seated = false;
      try {
        if (jobsCreated >= maxJobs) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `mcp_job_cap_reached: this server process already created ${maxJobs} jobs. ` +
                  `The cap exists because MCP calls live outside Nodal's per-job loop ` +
                  `guards. Restart the server to reset it — deliberately a human gesture.`,
              },
            ],
          };
        }
        jobsCreated += 1;
        seated = true;

        const { instruction, caller, agent: targetSlug } = runTaskInputSchema.parse(args);

        // La CIBLE se choisit, l'ENTITÉ jamais — c'est la ligne exacte que la
        // v1 avait franchie. Choisir un agent DANS le workspace équivaut à
        // choisir dans quel chat on tape sa demande : le job tourne sous les
        // outils, approbations et budgets de CET agent, et les gardes du canal
        // (jamais les meta-tools, interrupteur, plafond) ne dépendent pas de
        // la cible. La résolution est bornée à l'entité du serveur — un slug
        // d'un autre workspace est simplement introuvable ici.
        // Le défaut est LA RACINE DE L'ENTITÉ, pas l'agent du lancement. La
        // review a montré l'écart : le contrat public dit « omets le champ
        // pour adresser la racine », mais un serveur lancé pour un worker
        // adressait silencieusement ce worker. Résolu à CHAQUE appel — la
        // racine peut changer pendant que le serveur tourne — et vérifié
        // actif ; sans racine configurée, repli documenté sur l'agent du
        // lancement.
        let targetAgent: { id: string } = { id: agentRow.id };
        if (!targetSlug) {
          const [ent] = await opts.db
            .select({ rootAgentId: entities.rootAgentId })
            .from(entities)
            .where(eq(entities.id, entityId))
            .limit(1);
          if (ent?.rootAgentId) {
            const [root] = await opts.db
              .select({ id: agents.id })
              .from(agents)
              .where(
                and(
                  eq(agents.id, ent.rootAgentId),
                  eq(agents.entityId, entityId),
                  eq(agents.active, true),
                ),
              )
              .limit(1);
            // Racine CONFIGURÉE mais introuvable/inactive/hors entité : erreur
            // explicite, jamais un repli. Le repli sur le lanceur n'est prévu
            // que pour « aucune racine configurée » — l'étendre à « racine
            // cassée » masquerait une configuration incohérente et casserait
            // le contrat « champ omis = racine » en silence (constat passe 2,
            // invariant #4).
            if (!root) {
              throw new Error(
                'mcp_root_agent_invalid: this workspace designates a root agent that is ' +
                  'inactive or missing. Fix the root agent in Settings, or pass `agent` ' +
                  'explicitly.',
              );
            }
            targetAgent = root;
          }
        }
        if (targetSlug) {
          const [resolved] = await opts.db
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.entityId, entityId),
                eq(agents.slug, targetSlug),
                eq(agents.active, true),
              ),
            )
            .limit(1);
          if (!resolved) {
            throw new Error(
              `mcp_target_agent_not_found: no active agent with slug "${targetSlug}" in this ` +
                `workspace. Omit the field to address the root agent.`,
            );
          }
          targetAgent = resolved;
        }

        // Vérification de l'interrupteur ET insert dans UNE transaction, avec
        // un verrou sur la ligne entité. Lire-puis-insérer laissait une course
        // (constat review) : l'appel lisait `enabled = true`, le propriétaire
        // coupait, l'insert passait quand même. Avec le FOR UPDATE, soit la
        // coupure a commité d'abord et on lit `false` — refus — soit notre
        // transaction tient le verrou et la coupure attend un job créé AVANT
        // elle, ce qui est la sémantique honnête de « couper coupe ».
        //
        // Le même insert que run_task côté chat : un job pending, ramassé par
        // le worker, exécuté par la boucle NORMALE — approbations, audit,
        // compteurs, hiérarchie. Rien n'est exécuté ici.
        const [job] = await opts.db.transaction(async (tx) => {
          const [gate] = await tx
            .select({ enabled: entities.mcpServerEnabled })
            .from(entities)
            .where(eq(entities.id, entityId))
            .for('update');
          if (!gate?.enabled) {
            throw new Error(
              'mcp_disabled: the MCP server is switched off for this workspace. ' +
                'Enable it in the dashboard (Settings) before connecting clients.',
            );
          }
          return tx
            .insert(agentJobs)
            .values({
              entityId,
              agentId: targetAgent.id,
              status: 'pending',
              channel: 'mcp',
              task: instruction,
              // Provenance, pas identite : `caller` est declaratif (voir le type
              // JobTriggerContext) et n accorde rien — il rend « qui a demande
              // ca ? » lisible dans les Runs. triggeredAt vient du serveur, pas
              // du client.
              triggerContext: {
                type: 'mcp',
                ...(caller ? { caller } : {}),
                triggeredAt: new Date().toISOString(),
              },
              messages: [{ role: 'user', content: instruction }],
            })
            .returning({ id: agentJobs.id });
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                jobId: job?.id,
                status: 'pending',
                note: 'The job runs asynchronously under the agent’s own rules; results land on the Runs page.',
              }),
            },
          ],
        };
      } catch (err) {
        // Un appel qui n a pas abouti rend son siege — sinon des erreurs de
        // validation epuiseraient le plafond sans creer un seul job.
        if (seated) jobsCreated -= 1;
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    },
  );

  return server;
}

/** Construit puis branche sur stdio — le point d'entrée d'un vrai lancement. */
export async function startNodalMcpServer(opts: McpServerOptions): Promise<void> {
  const server = await buildNodalMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
