// server.ts — Nodal exposé comme serveur MCP, en stdio.
//
// Prouvé avant d'être écrit (23/08) : un vrai `claude -p --strict-mcp-config
// --mcp-config <fichier>` voit l'outil, l'appelle, et sa réponse remonte. Le
// point qui décidait de tout : `--strict-mcp-config` veut dire « UNIQUEMENT les
// serveurs que je te donne », pas « aucun ». Le confinement de la PR #6 reste
// donc entier — la config personnelle de l'utilisateur n'entre pas — et Nodal
// peut quand même exposer les siens.
//
// STDIO UNIQUEMENT. Aucune écoute réseau ici, et ce n'est pas une omission :
// un point d'entrée qui crée des jobs et fait tourner des outils exige une
// authentification que ce lot ne livre pas. En stdio, le serveur est un
// sous-processus du client — sa confiance est exactement celle de ce shell.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { ToolContext } from '@nodal-agents/tools';
import { listExposableTools, isDeferredToC2 } from './tools';

export interface McpServerOptions {
  db: AnyDrizzleDb;
  /**
   * AU NOM DE QUI le client appelle.
   *
   * Il n'y a ni job ni conversation derrière un appel MCP, donc aucune identité
   * implicite : elle doit être choisie explicitement. C'est aussi le périmètre
   * d'autorisation — les outils exposés sont ceux de CET agent, jamais un
   * catalogue global.
   */
  agentId: string;
  entityId: string | null;
  /** Nom annoncé au client. */
  name?: string;
  version?: string;
}

/**
 * Construit le serveur sans le connecter — pour que les tests puissent
 * l'inspecter sans ouvrir de transport.
 */
export async function buildNodalMcpServer(opts: McpServerOptions): Promise<McpServer> {
  const server = new McpServer({
    name: opts.name ?? 'nodal',
    version: opts.version ?? '0.1.0',
  });

  const tools = await listExposableTools(opts.agentId, opts.db);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // Le schéma Zod de l'outil Nodal EST le schéma MCP — pas une copie
        // rédigée à la main qui divergerait au premier champ ajouté.
        inputSchema: (tool.inputSchema as { shape?: Record<string, never> }).shape ?? {},
      },
      async (args: unknown) => {
        if (isDeferredToC2(tool.name)) {
          // Refus EXPLICITE plutôt qu'absence silencieuse : l'outil existe dans
          // la base de cet agent, le client a le droit de savoir pourquoi il ne
          // peut pas s'en servir aujourd'hui.
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `${tool.name} n'est pas encore disponible par MCP. Cet outil rend la main ` +
                  `APRÈS que l'agent délégué a fini, ce qu'un appel MCP synchrone ne peut pas ` +
                  `attendre sans bloquer le client. Utilise create_task, qui confie le travail ` +
                  `au tableau de tâches et rend la main immédiatement.`,
              },
            ],
          };
        }

        const ctx = {
          db: opts.db,
          entityId: opts.entityId,
          agentId: opts.agentId,
          // Pas de job derrière un appel MCP. Les outils qui en exigent un
          // échoueront fort, ce qui est le comportement voulu : mieux vaut une
          // erreur nette qu'un job orphelin rattaché à un identifiant inventé.
          jobId: null,
        } as unknown as ToolContext;

        try {
          const parsed = tool.inputSchema.parse(args);
          const result = await tool.execute(parsed, ctx);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
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
  }

  return server;
}

/** Construit puis branche sur stdio — le point d'entrée d'un vrai lancement. */
export async function startNodalMcpServer(opts: McpServerOptions): Promise<void> {
  const server = await buildNodalMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
