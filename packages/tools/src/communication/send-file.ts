// communication/send-file.ts — server-side document/file delivery tool
//
// Registered per-agent when agents.telegramBotToken IS NOT NULL (same condition
// as telegram_send_message / send_image). The agent passes a source path or URL;
// the runner fetches the bytes server-side and uploads them to the user's chat
// via Telegram's sendDocument — which delivers ANY file type (PDF, .md, .txt,
// .csv, .zip, …) as a downloadable attachment, not just images.
// ZERO file bytes ever enter the LLM context — the return value is tiny.

import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { agents } from '@nodal-agents/db';
import { sendTelegramDocument } from '@nodal-agents/delivery';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition, ToolContext } from '../types';

// Telegram sendDocument size limit for bots. Uploads above this are rejected
// server-side; we enforce the cap locally so the error is clear.
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024; // 50 MB

// ─── Input / Output ───────────────────────────────────────────────────────────

const SendFileInput = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'Local file path OR an http(s) URL. The runner fetches the bytes ' +
        'server-side — do NOT read the file or base64-encode it.',
    ),
  filename: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'Optional filename the recipient sees (with extension, e.g. "report.md"). ' +
        'Defaults to the name derived from the source path/URL.',
    ),
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe('Optional caption (≤1024 chars, Telegram limit).'),
  chatId: z
    .string()
    .regex(/^-?\d+$/, 'must be a numeric Telegram chat ID')
    .max(20)
    .optional()
    .describe('Telegram chat ID. Omit to reply to the chat that triggered this job.'),
});

type SendFileInput = z.infer<typeof SendFileInput>;
type SendFileOutput = { ok: true; bytes: number; filename: string };

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the send_file tool definition.
 *
 * Factory shape so the definition is stateless — all state (bot token,
 * chatId fallback, byte fetch) is resolved at execute-time from ctx.
 */
export function createSendFileTool(): ToolDefinition<typeof SendFileInput, SendFileOutput> {
  return {
    name: 'send_file',
    description: `Deliver ANY file to the user as a document attachment via their channel (Telegram).

Use this for non-image files — PDF, Markdown (.md), .txt, .csv, .json, .zip,
Office docs, etc. (For an inline image preview, use \`send_image\` instead;
\`send_file\` sends a downloadable attachment and preserves the filename + extension.)

Pass \`source\` as a **local file path** or an **http(s) URL**. The runtime fetches
the bytes server-side and uploads them — do NOT read the file or base64-encode it
into your reply. Inline bytes waste thousands of tokens and re-send every turn.
This tool keeps the LLM context tiny: the return value is just
\`{ ok: true, bytes: <size>, filename: <name> }\`.

- **source**: file path or http(s) URL. localhost URLs are allowed.
- **filename**: optional name the recipient sees (keep the extension, e.g. "notes.md").
  Defaults to the name derived from the source.
- **caption**: optional, ≤1024 chars.
- **chatId**: optional. Omit to reply to the chat that triggered this job.

Size cap: 50 MB (Telegram document limit). Larger files throw \`file_too_large\`.

Fail conditions:
- No chatId provided and the job has no origin chat → throws \`no_recipient\`.
- Agent has no configured Telegram bot token → throws \`no_bot_token\`.
- Source URL returns non-2xx → throws \`fetch_failed\`.
- Bytes exceed 50 MB → throws \`file_too_large\`.`,

    inputSchema: SendFileInput,

    riskLevel: 'write',

    async execute(input: SendFileInput, ctx: ToolContext): Promise<SendFileOutput> {
      // 1. Resolve chatId — explicit arg wins, then job origin chat
      const chatId = input.chatId ?? ctx.jobChatId;
      if (!chatId) {
        const err = new Error('no_recipient');
        err.name = 'no_recipient';
        throw err;
      }

      // 2. Bot token — the runner's resolved token wins (B3: a delegated worker
      // inheriting its entity's root agent's token); otherwise fall back to this
      // agent's own token from DB (credential isolation per agent, historical path).
      let botToken = ctx.resolvedTelegramBotToken;
      if (botToken === undefined) {
        const agentRows = await ctx.db
          .select({ telegramBotToken: agents.telegramBotToken })
          .from(agents)
          .where(eq(agents.id, ctx.agentId))
          .limit(1);
        botToken = agentRows[0]?.telegramBotToken ?? undefined;
      }
      if (!botToken) {
        const err = new Error('no_bot_token');
        err.name = 'no_bot_token';
        throw err;
      }

      // 3. Obtain bytes server-side — NEVER return them to the model
      let bytes: ArrayBuffer;
      let derivedName: string;

      const src = input.source;

      if (src.startsWith('http://') || src.startsWith('https://')) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        let urlResponse: Response;
        try {
          urlResponse = await fetch(src, { signal: controller.signal });
        } catch (fetchErr) {
          const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          const err = new Error(`fetch_failed: ${errMsg}`);
          err.name = 'fetch_failed';
          throw err;
        } finally {
          clearTimeout(timeoutId);
        }

        if (!urlResponse.ok) {
          const err = new Error(`fetch_failed: HTTP ${urlResponse.status} from ${src}`);
          err.name = 'fetch_failed';
          throw err;
        }

        bytes = await urlResponse.arrayBuffer();

        const urlPath = new URL(src).pathname;
        derivedName = urlPath.split('/').pop() || 'file';
      } else {
        // Local file path
        const nodeBuf = await readFile(src);
        bytes = nodeBuf.buffer.slice(
          nodeBuf.byteOffset,
          nodeBuf.byteOffset + nodeBuf.byteLength,
        ) as ArrayBuffer;

        derivedName = src.split(/[\\/]/).pop() || 'file';
      }

      // 4. Enforce 50 MB cap (Telegram document limit)
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        const err = new Error(
          `file_too_large: ${bytes.byteLength} bytes exceeds the 50 MB Telegram document limit`,
        );
        err.name = 'file_too_large';
        throw err;
      }

      // 5. Upload via delivery helper (server-side, zero bytes in LLM context)
      const filename = input.filename ?? derivedName;
      await sendTelegramDocument({
        chatId,
        botToken,
        document: new Uint8Array(bytes),
        filename,
        caption: input.caption,
      });

      // 6. Return a tiny result — no file data
      return { ok: true, bytes: bytes.byteLength, filename };
    },
  };
}
