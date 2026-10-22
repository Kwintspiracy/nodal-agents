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
import { RECORD_ID, markReplaced, readRecord, writeRecord, type PrintRecord } from './record';

/** Au-delà, un fichier n'est pas une demande d'impression raisonnable : refusé, dit. */
const MAX_BYTES = 50 * 1024 * 1024;

const SERVER_INSTRUCTIONS =
  'Print requests wait here for the owner to approve them; this server has no printer and never prints. ' +
  'A request holds either a file (filePath, an absolute path) or composed content (content, HTML by default).';

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
    .regex(RECORD_ID, 'not a print request id (pr-<ms>-<8 hex digits>)')
    .optional()
    .describe('The id of a pending request this one replaces; the replaced request is withdrawn.'),
});

const getPrintRequestInput = z.strictObject({
  id: z
    .string()
    .regex(RECORD_ID, 'not a print request id (pr-<ms>-<8 hex digits>)')
    .describe('The id request_print returned.'),
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
function view(record: PrintRecord, warnings: readonly string[]): ToolResult {
  const structured: Record<string, unknown> = {
    id: record.id,
    status: record.status,
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
    record.status === 'pending'
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
  });
  if (args.replaces !== undefined) markReplaced(dir, args.replaces, record.id);
  return view(record, count.problem === null ? [] : [count.problem]);
}

function lookup(dir: string, id: string): ToolResult {
  const found = readRecord(dir, id);
  if (found.kind === 'missing') return failure(`No print request "${id}".`);
  if (found.kind === 'invalid')
    return failure(`Print request "${id}" cannot be read: ${found.reason}`);
  return view(found.read.record, []);
}

/** Le serveur d'un dossier d'enregistrements ; le dossier est créé s'il manque. */
export function createBenchPrinterServer(recordsDir: string): McpServer {
  if (!isAbsolute(recordsDir))
    throw new Error(`bench_printer_records_dir_not_absolute: "${recordsDir}"`);
  mkdirSync(recordsDir, { recursive: true });
  const server = new McpServer(
    { name: BENCH_PRINTER_SLUG, version: '0.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  server.registerTool(
    'request_print',
    {
      description:
        'Create a print request for a file or for a document you composed. The request waits for the owner to approve it; it is not printed by this call. Returns the request id, its status and a preview (pages, pictures).',
      inputSchema: requestPrintInput,
    },
    (args) => receive(recordsDir, args),
  );
  server.registerTool(
    'get_print_request',
    {
      description: 'Read a print request back: its status and its preview.',
      inputSchema: getPrintRequestInput,
    },
    (args) => lookup(recordsDir, args.id),
  );
  return server;
}
