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
import { agents, agentJobs, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { runTaskInputSchema, RUN_TASK_DESCRIPTION } from './tools';

export interface McpServerOptions {
  db: AnyDrizzleDb;
  /**
   * AU NOM DE QUI le client appelle. C'est le SEUL paramètre d'identité :
   * l'entité est lue depuis la ligne agent, jamais fournie par l'appelant.
   * La review a montré pourquoi — `agentId` de l'entité A plus `entityId` de
   * l'entité B fabriquait une écriture inter-workspace signée par A.
   */
  agentId: string;
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
 * Construit le serveur sans le connecter — pour que les tests puissent
 * l'inspecter sans ouvrir de transport.
 *
 * Échoue FORT si l'agent n'existe pas ou est inactif : la review a montré
 * qu'un `agentId` inventé recevait quand même les outils de création. Un
 * serveur au nom de personne n'a rien à servir.
 */
export async function buildNodalMcpServer(opts: McpServerOptions): Promise<McpServer> {
  const [agentRow] = await opts.db
    .select({ id: agents.id, entityId: agents.entityId, active: agents.active })
    .from(agents)
    .where(eq(agents.id, opts.agentId))
    .limit(1);

  if (!agentRow || !agentRow.active) {
    throw new Error(
      `mcp_agent_not_found: no active agent with id "${opts.agentId}". ` +
        `This server speaks FOR one agent; without it there is nothing to expose.`,
    );
  }

  const server = new McpServer({
    name: opts.name ?? 'nodal',
    version: opts.version ?? '0.1.0',
  });

  const maxJobs = opts.maxJobsPerProcess ?? DEFAULT_MAX_JOBS_PER_PROCESS;
  let jobsCreated = 0;

  server.registerTool(
    'run_task',
    {
      description: RUN_TASK_DESCRIPTION,
      inputSchema: runTaskInputSchema.shape,
    },
    async (args: unknown) => {
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

        const { instruction } = runTaskInputSchema.parse(args);

        // Le même insert que run_task côté chat : un job pending, ramassé par
        // le worker, exécuté par la boucle NORMALE — approbations, audit,
        // compteurs, hiérarchie. Rien n'est exécuté ici.
        const [job] = await opts.db
          .insert(agentJobs)
          .values({
            entityId: agentRow.entityId,
            agentId: agentRow.id,
            status: 'pending',
            channel: 'mcp',
            task: instruction,
            messages: [{ role: 'user', content: instruction }],
          })
          .returning({ id: agentJobs.id });

        jobsCreated += 1;

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
