// workflows/mcp.ts — la demande part par le chemin de l'UTILISATEUR.
//
// Un essai du banc est une demande ordinaire faite au root, par la même porte
// qu'un client MCP de l'utilisateur : `nodal-agents mcp serve`, l'outil
// `run_task`. Ce chemin-là réveille le runner dès l'insertion du job ; le
// lanceur brut du monorepo, lui, attend le ramassage périodique (~2 min), ce
// qui fausserait toutes les durées.
//
// Le client est le SDK officiel (@modelcontextprotocol/sdk, invariant #7). Il
// reste ouvert pendant tout l'essai : le réveil du runner est envoyé par le
// serveur MCP en tâche de fond, et fermer le processus tout de suite pourrait
// le couper.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

export interface RunTaskSession {
  readonly jobId: string;
  close(): Promise<void>;
}

const RunTaskReply = z.object({ jobId: z.string().uuid(), status: z.string() });

/** Environnement du processus, sans les valeurs indéfinies (le transport veut des chaînes). */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  return env;
}

/**
 * Lance `nodal-agents mcp serve` depuis le dossier de la stack (la commande du
 * CLI, exécutée par tsx comme le fait la stack de développement) et y appelle
 * `run_task`. Rend l'id du job créé, ou lève l'erreur du serveur telle quelle
 * (`mcp_disabled`, `mcp_jobs_in_flight`…) : jamais un essai sans job.
 */
export async function startRunTask(
  stackDir: string,
  instruction: string,
  caller: string,
): Promise<RunTaskSession> {
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--filter', 'nodal-agents', '--silent', 'exec', 'tsx', 'src/index.ts', 'mcp', 'serve'],
    cwd: stackDir,
    env: inheritedEnv(),
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
    const res = await client.callTool({ name: 'run_task', arguments: { instruction, caller } });
    const content = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(res.content);
    const text = content.map((c) => c.text ?? '').join('\n');
    if (res.isError === true) throw new Error(`run_task refused: ${text}`);
    const reply = RunTaskReply.parse(JSON.parse(text));
    return { jobId: reply.jobId, close };
  } catch (err) {
    await close();
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `workflow_mcp_failed: ${why}${stderr ? ` | server stderr: ${stderr.trim()}` : ''}`,
    );
  }
}
