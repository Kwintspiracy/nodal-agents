// scoped-stdio.ts — le transport stdio d'un serveur MCP, lancé dans le
// PÉRIMÈTRE DE PROCESSUS de qui l'ouvre (#750).
//
// `StdioClientTransport` (le SDK officiel) lance le serveur par `cross-spawn`
// et ne tue, à la fermeture, que son processus DIRECT. Or un serveur MCP est
// presque toujours lancé par un intermédiaire : `npx` (un `.cmd` sous
// Windows, donc `cmd.exe` → `npx-cli` → `node` du serveur), `uvx`. Le kill du
// SDK tue l'intermédiaire, et le vrai serveur — avec ce qu'il lance — survit :
// sous Windows il n'est même jamais récupéré (constat de `createLazyMcpTools`).
//
// Ce transport fait EXACTEMENT ce que fait celui du SDK, sauf le lancement :
//   - la ligne de commande est celle que `cross-spawn` aurait produite (son
//     analyse, `_parse`, celle-là même que le SDK appelle : résolution PATHEXT
//     et échappement `cmd.exe` des `.cmd`), l'environnement celui du SDK
//     (`getDefaultEnvironment()` puis celui du connecteur) ;
//   - le tramage JSON-RPC est celui du SDK (`ReadBuffer`, `serializeMessage`) ;
//   - le processus est lancé par `scope.startOwned` : il appartient au job qui
//     l'a ouvert (Job Object sous Windows, groupe et étiquette sous Unix), sa
//     fermeture tue son ARBRE (taskkill /T), et ce qu'il a détaché meurt avec
//     le job. Ouvert hors job (la page des connecteurs qui teste un serveur),
//     il a son propre périmètre, fermé avec la connexion.
// La fermeture suit celle du SDK : l'entrée fermée, deux secondes pour sortir
// de lui-même, puis l'arbre tué.

import { randomUUID } from 'node:crypto';
import crossSpawn from 'cross-spawn';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { openProcessScope, type JobProcessScope } from '@nodal-agents/tools';

/**
 * L'analyse de `cross-spawn` (`lib/parse.js`, exportée sous `_parse` depuis sa
 * v6) : ce que le SDK lance réellement pour une commande. Ses types publiés ne
 * la décrivent pas ; sa forme est celle de cross-spawn 7.
 */
interface ParsedCommand {
  /** Le programme à lancer (`cmd.exe` quand un `.cmd` est emballé sous Windows). */
  command: string;
  /** Ses arguments, déjà échappés pour `cmd.exe` le cas échéant. */
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}
const parseCommand = (
  crossSpawn as unknown as {
    _parse(
      command: string,
      args: string[],
      options: { env: Record<string, string | undefined>; cwd: string },
    ): ParsedCommand;
  }
)._parse;

/** Le délai laissé au serveur pour sortir de lui-même, son entrée fermée (celui du SDK). */
const GRACEFUL_EXIT_MS = 2_000;

/**
 * Le plafond d'UN message JSON-RPC lu sur la sortie du serveur (le `ReadBuffer`
 * du SDK, borné depuis la 1.32).
 *
 * Le SDK le fixe à 10 Mo, pour tous. Ce n'est pas le bon plafond ici : le
 * résultat d'un outil MCP arrive en UN message, et la plateforme sait en
 * recevoir de gros (des pages rendues en images : dix images de 1 Mo font
 * 14 Mo en base64) avant de décider elle-même ce qu'elle passe au modèle
 * (`result.ts` : ce qui tient dans une requête, le reste dit et gardé hors
 * ligne). 10 Mo aurait fermé la connexion sur un résultat que Nodal traite. Le
 * plafond reste ce qu'il doit être, une borne contre un serveur emballé qui
 * n'envoie jamais de fin de ligne, mais à la taille de ce que le produit
 * accepte.
 */
export const MCP_STDIO_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;

type Started = Awaited<ReturnType<JobProcessScope['startOwned']>>;

export interface ScopedStdioParams {
  command: string;
  args: readonly string[];
  /** L'environnement du connecteur, posé sur celui que le SDK hérite par défaut. */
  env: Record<string, string>;
  /**
   * Le plafond d'un message lu (comme `StdioServerParameters.maxBufferSize` du
   * SDK). Par défaut `MCP_STDIO_MAX_MESSAGE_BYTES`.
   */
  maxBufferSize?: number;
}

export class ScopedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private proc: Started | null = null;
  private readonly readBuffer: ReadBuffer;
  private closed = false;
  /** Le périmètre que CE transport a ouvert, faute d'un job : il le ferme. */
  private readonly ownScope: JobProcessScope | null;
  private readonly scope: JobProcessScope;

  constructor(
    private readonly params: ScopedStdioParams,
    scope?: JobProcessScope,
  ) {
    this.ownScope = scope ? null : openProcessScope(`mcp-stdio:${randomUUID()}`);
    this.scope = scope ?? (this.ownScope as JobProcessScope);
    this.readBuffer = new ReadBuffer({
      maxBufferSize: params.maxBufferSize ?? MCP_STDIO_MAX_MESSAGE_BYTES,
    });
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error('ScopedStdioTransport already started');
    const env = { ...getDefaultEnvironment(), ...this.params.env };
    const cwd = process.cwd();
    // La ligne exacte du SDK : `cross-spawn` résout la commande et, sous
    // Windows, emballe un `.cmd` dans `cmd.exe` avec son échappement.
    const parsed = parseCommand(this.params.command, [...this.params.args], { env, cwd });
    const proc = await this.scope.startOwned({
      target: {
        file: parsed.command,
        args: parsed.args,
        windowsVerbatimArguments: parsed.options.windowsVerbatimArguments === true,
      },
      cwd,
      env,
      stdin: 'pipe',
    });
    // Comme le SDK : un lancement raté (`spawn npx ENOENT`) fait échouer
    // `start()` avec sa raison, avant tout échange.
    const failure = await proc.spawned;
    if (failure !== null) {
      await this.ownScope?.close();
      throw new Error(failure);
    }
    this.proc = proc;
    // Comme le SDK (>= 1.32, GHSA du tampon de lecture) : un message qui
    // dépasse le plafond du `ReadBuffer` (`MCP_STDIO_MAX_MESSAGE_BYTES`) fait LEVER
    // `append` ; l'erreur est remontée et la connexion fermée, jamais laissée
    // remonter hors du gestionnaire (exception non rattrapée du runner).
    proc.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      } catch (e) {
        this.onerror?.(e as Error);
        this.close().catch(() => {});
      }
    });
    proc.stdout?.on('error', (e: Error) => this.onerror?.(e));
    // Comme le SDK (`stderr: 'inherit'`) : le journal du serveur va à celui du runner.
    proc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    proc.stdin?.on('error', (e: Error) => this.onerror?.(e));
    void proc.done.then((end) => {
      if (end.kind === 'error') this.onerror?.(new Error(end.message));
      this.proc = null;
      this.onclose?.();
    });
  }

  private processReadBuffer(): void {
    for (;;) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (e) {
        this.onerror?.(e as Error);
      }
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin) {
        reject(new Error('Not connected'));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', () => resolve());
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {
        /* déjà fermée */
      }
      const exited = await Promise.race([
        proc.done.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), GRACEFUL_EXIT_MS).unref()),
      ]);
      // L'ARBRE, pas seulement l'intermédiaire (`npx`, `cmd.exe`) : le vrai
      // serveur meurt avec lui. Sorti de lui-même, ses descendants détachés
      // restent au périmètre, qui les tue à sa fermeture.
      if (!exited) proc.kill();
    }
    this.readBuffer.clear();
    await this.ownScope?.close();
  }
}
