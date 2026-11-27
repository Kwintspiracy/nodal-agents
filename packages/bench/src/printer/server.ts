// printer/server.ts — le serveur MCP d'impression du banc (#794).
//
// Une imprimante qui n'imprime rien et qui note ce qu'on lui envoie. Le banc
// rejoue des scénarios d'impression des centaines de fois : aucune de ces
// demandes ne doit exister chez le propriétaire (décision du 18/10). Ce
// serveur est ce qu'un agent trouve à la place, et ce que le juge relit :
// `record.ts` garde, pour chaque demande, les octets REÇUS et leur sha-256.
//
// Surface minimale, celle que les scénarios et leurs juges emploient :
//   request_print      crée une demande (un fichier, ou un contenu composé) ; elle ATTEND.
//   get_print_request  relit une demande.
// Il n'existe AUCUN outil de confirmation : une demande reste en attente, par
// construction. Il n'y a pas d'imprimante derrière.
//
// Une imprimante qui IMPRIME (#1071), sur option (`printMs`, que la
// déclaration porte) : chaque demande devient un travail soumis, comme une
// impression directe, qui passe seul d'accepté à en impression puis à terminé
// en `printMs`. Rien ne sort, rien n'est piloté : l'état se calcule du temps
// (`jobState`). `get_print_request` accepte alors une attente (`waitSeconds`) :
// il suit le travail jusqu'à sa fin ou la fin de l'attente, en envoyant des
// notifications de progression MCP, et rend l'état. C'est la capacité qu'un
// connecteur réel peut offrir, décrite par ses outils, sans en imiter aucun.
//
// Le SDK officiel (@modelcontextprotocol/sdk, invariant #7). Ce fichier vit
// avec le banc : il n'est importé que par le banc, jamais par le produit
// (prouvé par printer.test.ts et par le contrôle du pack, build-pack.mjs).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { BENCH_PRINTER_SLUG } from './identity';
import {
  countFilePages,
  estimateHtmlPages,
  estimateTextPages,
  htmlImages,
  type PageCount,
} from './pages';
import {
  RECORD_ID,
  jobState,
  markReplaced,
  readRecord,
  writeRecord,
  type PrintRecord,
} from './record';

/** Au-delà, un fichier n'est pas une demande d'impression raisonnable : refusé, dit. */
const MAX_BYTES = 50 * 1024 * 1024;

const HOLDS =
  'A request holds either a file (filePath, an absolute path) or composed content (content, HTML by default).';
const instructionsFor = (printing: boolean): string =>
  printing
    ? `Print requests are sent to the printer as jobs, printed in a few seconds. ${HOLDS}`
    : `Print requests wait here for the owner to approve them; this server has no printer and never prints. ${HOLDS}`;

/** L'attente la plus longue qu'un appel accepte. */
export const MAX_WAIT_SECONDS = 120;

const requestPrintInput = z.strictObject({
  filePath: z
    .string()
    .optional()
    .describe('Absolute path of a file to print as is. Give this or content, not both.'),
  content: z
    .string()
    .optional()
    .describe('A document you composed, to print. Give this or filePath, not both.'),
  format: z
    .enum(['html', 'text'])
    .optional()
    .describe('How content is written: html (default) or plain text.'),
  title: z.string().optional().describe('A short title for the request.'),
  replaces: z
    .string()
    .regex(RECORD_ID, 'the id must be a print request id: pr-<ms>-<8 hex digits>')
    .optional()
    .describe('The id of a pending request this one replaces; the replaced request is withdrawn.'),
});

const getPrintRequestInput = z.strictObject({
  id: z
    .string()
    .regex(RECORD_ID, 'the id must be a print request id: pr-<ms>-<8 hex digits>')
    .describe('The id request_print returned.'),
  waitSeconds: z
    .number()
    .positive()
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `Follow a submitted print job: wait up to this many seconds (at most ${MAX_WAIT_SECONDS}) for it to finish, then return its state. Without it, the state now. A request waiting for the owner has no job to follow: returned at once.`,
    ),
});

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const failure = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Ce que la demande rend à l'agent : l'identifiant, l'attente, l'aperçu, ce qui n'a pas pu être compté. */
function view(record: PrintRecord, warnings: readonly string[], nowMs: number): ToolResult {
  const job = jobState(record, nowMs);
  const structured: Record<string, unknown> = {
    id: record.id,
    // Un travail soumis : son état à cet instant, et les pages sorties.
    status: job === null ? record.status : job.state,
    ...(job === null ? {} : { pagesOut: job.pagesOut }),
    ...(record.replacedBy ? { replacedBy: record.replacedBy } : {}),
    preview: { pages: record.pages, pagesBasis: record.pagesBasis },
    received: { bytes: record.bytes.size },
    // Un contenu composé : les images que le document désigne. Le serveur ne va
    // pas les chercher. Un fichier imprimé tel quel : il n'en dit rien.
    ...(record.images ? { images: { embedded: record.images } } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  const pages =
    record.pages === null
      ? 'page count unknown'
      : `${record.pages} page${record.pages === 1 ? '' : 's'}${record.pagesBasis.endsWith('estimate') ? ' (estimated)' : ''}`;
  const text =
    job !== null
      ? job.state === 'completed'
        ? `Print job ${record.id} is completed: ${job.pagesOut === null ? 'every page' : `${job.pagesOut} page${job.pagesOut === 1 ? '' : 's'}`} printed.`
        : `Print job ${record.id} is ${job.state === 'accepted' ? 'accepted by the printer' : 'printing'}: ${pages}, none out yet. Not printed yet.`
      : record.status === 'pending'
        ? `Print request ${record.id} is pending, waiting for the owner to approve it: ${pages}. Nothing was printed.`
        : `Print request ${record.id} was replaced by ${record.replacedBy ?? 'a newer request'}. Nothing was printed.`;
  return {
    content: [
      { type: 'text', text: [text, ...warnings].join('\n') },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

async function receive(
  dir: string,
  printMs: number | null,
  args: {
    filePath?: string | undefined;
    content?: string | undefined;
    format?: 'html' | 'text' | undefined;
    title?: string | undefined;
    replaces?: string | undefined;
  },
): Promise<ToolResult> {
  const hasFile = args.filePath !== undefined && args.filePath !== '';
  const hasContent = args.content !== undefined && args.content !== '';
  if (hasFile === hasContent)
    return failure(
      'Give exactly one of filePath (a file to print) or content (a document to print).',
    );

  let bytes: Buffer;
  let source: PrintRecord['source'];
  let count: PageCount;
  let images: PrintRecord['images'] = null;
  if (hasFile) {
    const path = args.filePath!;
    if (!isAbsolute(path)) return failure(`filePath must be an absolute path, got "${path}".`);
    if (!existsSync(path) || !statSync(path).isFile())
      return failure(`filePath "${path}" is not a file this server can read.`);
    if (statSync(path).size > MAX_BYTES)
      return failure(`filePath "${path}" is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    bytes = readFileSync(path);
    source = { kind: 'file', path };
    count = await countFilePages(path, bytes);
  } else {
    const contentFormat = args.format ?? 'html';
    bytes = Buffer.from(args.content!, 'utf8');
    source = { kind: 'content', contentFormat };
    count =
      contentFormat === 'html'
        ? estimateHtmlPages(args.content!)
        : estimateTextPages(args.content!);
    if (contentFormat === 'html') images = htmlImages(args.content!);
  }

  if (args.replaces !== undefined) {
    if (printMs !== null)
      return failure(
        `replaces: this printer prints each request as a job at once; "${args.replaces}" was already sent to the printer and cannot be replaced.`,
      );
    const target = readRecord(dir, args.replaces);
    if (target.kind !== 'found' || target.read.record.status !== 'pending')
      return failure(`replaces: "${args.replaces}" is not a pending print request.`);
  }

  const record = writeRecord(dir, {
    source,
    bytes,
    pages: count.pages,
    pagesBasis: count.basis,
    images,
    arguments: { ...args },
    printMs,
  });
  if (args.replaces !== undefined) markReplaced(dir, args.replaces, record.id);
  return view(record, count.problem === null ? [] : [count.problem], Date.now());
}

/** Ce qu'un appel d'outil reçoit du SDK, et dont l'attente se sert. */
interface CallExtra {
  readonly signal: AbortSignal;
  readonly _meta?: { readonly progressToken?: string | number } | undefined;
  readonly sendNotification: (n: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; total: number; message: string };
  }) => Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Relit la demande ; avec `waitSeconds`, suit un travail soumis jusqu'à sa fin
 * ou la fin de l'attente. Tous les `tickMs`, une notification de progression
 * part vers le client qui en a demandé (un `progressToken`) : elle dit l'état,
 * et le client sait que l'appel vit. Une demande qui n'est pas un travail (elle
 * attend le propriétaire, ou a été remplacée) n'a rien à suivre : elle est
 * rendue tout de suite.
 */
async function lookup(
  dir: string,
  id: string,
  waitSeconds: number | undefined,
  tickMs: number,
  extra: CallExtra,
): Promise<ToolResult> {
  let found = readRecord(dir, id);
  if (found.kind === 'found' && waitSeconds !== undefined) {
    const startMs = Date.now();
    const deadline = startMs + waitSeconds * 1000;
    const token = extra._meta?.progressToken;
    for (;;) {
      const job = jobState(found.read.record, Date.now());
      const left = deadline - Date.now();
      if (job === null || job.state === 'completed' || left <= 0 || extra.signal.aborted) break;
      await sleep(Math.min(tickMs, left), extra.signal);
      const next = readRecord(dir, id);
      if (next.kind !== 'found') {
        found = next;
        break;
      }
      found = next;
      const now = jobState(found.read.record, Date.now());
      if (token !== undefined && now !== null && now.state !== 'completed' && !extra.signal.aborted)
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress: (Date.now() - startMs) / 1000,
            total: waitSeconds,
            message: `Print job ${id} is ${now.state}.`,
          },
        });
    }
  }
  if (found.kind === 'missing') return failure(`No print request "${id}".`);
  if (found.kind === 'invalid')
    return failure(`Print request "${id}" cannot be read: ${found.reason}`);
  return view(found.read.record, [], Date.now());
}

export interface BenchPrinterOptions {
  /**
   * Une imprimante qui imprime (#1071) : chaque demande devient un travail
   * soumis, terminé en ce nombre de millisecondes. Absent ou null : les
   * demandes attendent le propriétaire, et rien n'imprime jamais.
   */
  readonly printMs?: number | null;
  /** L'intervalle des notifications de progression pendant une attente (1 s par défaut). */
  readonly tickMs?: number;
}

/** Le serveur d'un dossier d'enregistrements ; le dossier est créé s'il manque. */
export function createBenchPrinterServer(
  recordsDir: string,
  options: BenchPrinterOptions = {},
): McpServer {
  if (!isAbsolute(recordsDir))
    throw new Error(`bench_printer_records_dir_not_absolute: "${recordsDir}"`);
  const printMs = options.printMs ?? null;
  if (printMs !== null && !(Number.isFinite(printMs) && printMs > 0))
    throw new Error(`bench_printer_bad_print_time: ${printMs} ms is not a positive duration`);
  const tickMs = options.tickMs ?? 1000;
  mkdirSync(recordsDir, { recursive: true });
  const printing = printMs !== null;
  const server = new McpServer(
    { name: BENCH_PRINTER_SLUG, version: '0.0.0' },
    { instructions: instructionsFor(printing) },
  );
  server.registerTool(
    'request_print',
    {
      description: printing
        ? 'Print a file or a document you composed: this call sends it to the printer as a job and returns at once, the job accepted, not printed yet. Returns the job id, its status and a preview (pages, pictures).'
        : 'Create a print request for a file or for a document you composed. The request waits for the owner to approve it; it is not printed by this call. Returns the request id, its status and a preview (pages, pictures).',
      inputSchema: requestPrintInput,
    },
    (args) => receive(recordsDir, printMs, args),
  );
  server.registerTool(
    'get_print_request',
    {
      description: printing
        ? 'Read a print job back: its status (accepted, printing, completed) and the pages out. Give waitSeconds to follow it to its end: the call waits until the job is completed or the wait ends, reports progress meanwhile, and returns the state.'
        : 'Read a print request back: its status and its preview.',
      inputSchema: getPrintRequestInput,
    },
    (args, extra) => lookup(recordsDir, args.id, args.waitSeconds, tickMs, extra),
  );
  return server;
}
