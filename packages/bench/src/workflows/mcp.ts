// workflows/mcp.ts — la demande part par le chemin de l'UTILISATEUR.
//
// Un essai du banc est une demande ordinaire faite au root, par la même porte
// qu'un client MCP de l'utilisateur : `nodal-agents mcp serve`, l'outil
// `run_task`. Ce chemin-là réveille le runner dès l'insertion du job ; le
// lanceur brut du monorepo, lui, attend le ramassage périodique (~2 min), ce
// qui fausserait toutes les durées.
//
// La cible n'est JAMAIS laissée au serveur (#769) : la session l'a résolue une
// fois (`resolveBenchTarget`, l'agent racine de l'espace banc), et chaque
// `run_task` la reçoit deux fois, sans ambiguïté possible :
//   - le `mcp serve` est épinglé sur cet agent (`NODAL_MCP_AGENT_ID`), donc sur
//     son espace : une variable héritée du shell est retirée, quelle que soit sa
//     casse (sous Windows, `process.env` ne la distingue pas) ;
//   - l'agent est nommé dans l'appel (`agent: <slug>`), donc le serveur ne
//     re-résout pas la racine de l'espace à chaque appel ;
//   - l'espace attendu est déclaré (`expectedWorkspaceId`) : si l'épinglage
//     cassait, le serveur refuserait AVANT de créer le job
//     (`mcp_workspace_mismatch`), au lieu d'un job créé ailleurs et rattrapé
//     après coup. La vérification de la session après chaque appel reste, en
//     seconde ligne.
//
// Le client est le SDK officiel (@modelcontextprotocol/sdk, invariant #7). Il
// reste ouvert pendant tout l'essai : le réveil du runner est envoyé par le
// serveur MCP en tâche de fond, et fermer le processus tout de suite pourrait
// le couper.
//
// La réponse se relit par le MÊME client, avec `get_task` (#887) : la réponse
// que l'essai garde est celle qu'un client MCP obtient, pas une lecture de la
// base que seul quelqu'un sur la machine peut faire.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

/** Ce que `get_task` rend, et ce que le banc en garde. */
export const GetTaskReplySchema = z.object({
  jobId: z.string().uuid(),
  status: z.string(),
  result: z.string().nullable(),
});
export type GetTaskReply = z.infer<typeof GetTaskReplySchema>;

export interface RunTaskSession {
  readonly jobId: string;
  /** Relit le job par `get_task`, sans attendre : ce que l'appelant voit maintenant. */
  getTask(): Promise<GetTaskReply>;
  close(): Promise<void>;
}

/** La cible de `run_task` : l'agent (épinglage et appel) et l'espace où le job doit être créé. */
export interface RunTaskTarget {
  readonly entityId: string;
  readonly rootAgentId: string;
  readonly rootAgentSlug: string;
}

/** La variable par laquelle `nodal-agents mcp serve` épingle l'agent pour qui il parle. */
export const MCP_PINNED_AGENT_ENV = 'NODAL_MCP_AGENT_ID';

const RunTaskReply = z.object({ jobId: z.string().uuid(), status: z.string() });

/**
 * L'environnement du `mcp serve` d'un essai : celui du processus, sans les
 * valeurs indéfinies (le transport veut des chaînes), sans AUCUNE variante de
 * `NODAL_MCP_AGENT_ID` (comparée sans la casse : c'est ainsi que Windows la lit),
 * puis l'agent de la cible, et lui seul.
 */
export function runTaskEnv(
  base: Readonly<Record<string, string | undefined>>,
  agentId: string,
): Record<string, string> {
  const pinned = MCP_PINNED_AGENT_ENV.toUpperCase();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base))
    if (typeof v === 'string' && k.toUpperCase() !== pinned) env[k] = v;
  env[MCP_PINNED_AGENT_ENV] = agentId;
  return env;
}

/** Comment le serveur MCP est démarré : la commande du CLI, depuis le dossier de la stack. */
export interface McpServeCommand {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
}

export function mcpServeCommand(stackDir: string): McpServeCommand {
  return {
    command: 'pnpm',
    args: ['--filter', 'nodal-agents', '--silent', 'exec', 'tsx', 'src/index.ts', 'mcp', 'serve'],
    cwd: stackDir,
  };
}

/**
 * Lance `nodal-agents mcp serve` depuis le dossier de la stack (la commande du
 * CLI, exécutée par tsx comme le fait la stack de développement), épinglé sur
 * l'agent de la cible, et y appelle `run_task` en nommant cet agent. Rend l'id
 * du job créé, ou lève l'erreur du serveur telle quelle (`mcp_disabled`,
 * `mcp_jobs_in_flight`…) : jamais un essai sans job. `serve` ne sert qu'aux
 * tests, qui démarrent un serveur MCP de test par le même chemin.
 */
export async function startRunTask(
  stackDir: string,
  instruction: string,
  caller: string,
  target: RunTaskTarget,
  serve: McpServeCommand = mcpServeCommand(stackDir),
  /**
   * L'environnement de départ du `mcp serve` : celui du processus, ou celui
   * de l'instance d'une campagne (campaign/instance.ts, `campaignEnv`), qui
   * désigne son dossier et rien de l'environnement du propriétaire.
   */
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunTaskSession> {
  const transport = new StdioClientTransport({
    ...serve,
    env: runTaskEnv(baseEnv, target.rootAgentId),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-4000);
  });
  const client = new Client({ name: 'nodal-bench-workflows', version: '1' });
  const close = async (): Promise<void> => {
    await client.close().catch(() => undefined);
  };
  try {
    await client.connect(transport);
    const res = await client.callTool({
      name: 'run_task',
      arguments: {
        instruction,
        caller,
        agent: target.rootAgentSlug,
        expectedWorkspaceId: target.entityId,
      },
    });
    const content = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(res.content);
    const text = content.map((c) => c.text ?? '').join('\n');
    if (res.isError === true) throw new Error(`run_task refused: ${text}`);
    const reply = RunTaskReply.parse(JSON.parse(text));
    const getTask = async (): Promise<GetTaskReply> => {
      const got = await client.callTool({ name: 'get_task', arguments: { jobId: reply.jobId } });
      const body = z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .parse(got.content)
        .map((c) => c.text ?? '')
        .join('\n');
      if (got.isError === true) throw new Error(`get_task refused: ${body}`);
      return GetTaskReplySchema.parse(JSON.parse(body));
    };
    return { jobId: reply.jobId, getTask, close };
  } catch (err) {
    await close();
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `workflow_mcp_failed: ${why}${stderr ? ` | server stderr: ${stderr.trim()}` : ''}`,
    );
  }
}
