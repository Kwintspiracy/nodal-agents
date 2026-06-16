// communication/send-image.ts — server-side image/file delivery tool
//
// Registered per-agent when agents.telegramBotToken IS NOT NULL (same condition
// as telegram_send_message). The agent passes a source path or URL; the runner
// fetches the bytes server-side and uploads them to the user's Telegram chat.
// ZERO image bytes ever enter the LLM context — the return value is tiny.

import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { agents } from '@nodal-agents/db';
import { sendTelegramPhoto } from '@nodal-agents/delivery';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition, ToolContext } from '../types';

// Telegram photo size limit. Uploads above this cap silently fail or are
// rejected server-side; we enforce the cap locally so the error is clear.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Input / Output ───────────────────────────────────────────────────────────

const SendImageInput = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'Local file path OR an http(s) URL (e.g. a ComfyUI /view?filename=... URL). ' +
        'The runner fetches the bytes server-side — do NOT base64-encode the file.',
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

type SendImageInput = z.infer<typeof SendImageInput>;
type SendImageOutput = { ok: true; bytes: number };

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the send_image tool definition.
 *
 * Factory shape so the definition is stateless — all state (bot token,
 * chatId fallback, byte fetch) is resolved at execute-time from ctx.
 */
export function createSendImageTool(): ToolDefinition<typeof SendImageInput, SendImageOutput> {
  return {
    name: 'send_image',
    description: `Deliver an image or file to the user via their channel (Telegram).

Pass \`source\` as a **local file path** or a **local/remote URL** (e.g. ComfyUI's
\`http://127.0.0.1:8188/view?filename=...\` URL). The runtime fetches the bytes
server-side and uploads them — do NOT read the file or base64-encode it into
your reply. Inline bytes waste thousands of tokens and are re-sent every turn
($2+ burns observed in live jobs). This tool keeps the LLM context tiny:
the return value is just \`{ ok: true, bytes: <size> }\`.

Typical usage right after an image-gen tool produces an output:
  1. The image-gen tool returns a path or URL (e.g. \`/tmp/output.png\`).
  2. Call \`send_image\` with that path as \`source\`.
  3. Call \`return_result\` to finish the job.

- **source**: file path or http(s) URL. localhost URLs are allowed — the runner
  runs on the user's machine, so ComfyUI and similar local services are reachable.
- **caption**: optional, ≤1024 chars (Telegram's caption limit).
- **chatId**: optional. Omit to reply to the chat that triggered this job.

Size cap: 10 MB (Telegram photo limit). Larger files throw \`image_too_large\`.

Fail conditions:
- No chatId provided and the job has no origin chat → throws \`no_recipient\`.
- Agent has no configured Telegram bot token → throws \`no_bot_token\`.
- Source URL returns non-2xx → throws \`fetch_failed\`.
- Bytes exceed 10 MB → throws \`image_too_large\`.`,

    inputSchema: SendImageInput,

    riskLevel: 'write',

    async execute(input: SendImageInput, ctx: ToolContext): Promise<SendImageOutput> {
      // 1. Resolve chatId — explicit arg wins, then job origin chat
      const chatId = input.chatId ?? ctx.jobChatId;
      if (!chatId) {
        const err = new Error('no_recipient');
        err.name = 'no_recipient';
        throw err;
      }

      // 2. Fetch bot token for this agent from DB (credential isolation per agent)
      const agentRows = await ctx.db
        .select({ telegramBotToken: agents.telegramBotToken })
        .from(agents)
        .where(eq(agents.id, ctx.agentId))
        .limit(1);

      const botToken = agentRows[0]?.telegramBotToken;
      if (!botToken) {
        const err = new Error('no_bot_token');
        err.name = 'no_bot_token';
        throw err;
      }

      // 3. Obtain bytes server-side — NEVER return them to the model
      let bytes: ArrayBuffer;
      let filename: string;

      const src = input.source;

      if (src.startsWith('http://') || src.startsWith('https://')) {
        // Remote URL (ComfyUI, external CDN, etc.) — fetch with 30s timeout
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

        // Derive filename from URL path (last segment before query string)
        const urlPath = new URL(src).pathname;
        filename = urlPath.split('/').pop() ?? 'image.png';
        if (!filename.includes('.')) filename = 'image.png';
      } else {
        // Local file path
        const nodeBuf = await readFile(src);
        bytes = nodeBuf.buffer.slice(
          nodeBuf.byteOffset,
          nodeBuf.byteOffset + nodeBuf.byteLength,
        ) as ArrayBuffer;

        // Derive filename from the path
        filename = src.split(/[\\/]/).pop() ?? 'image.png';
      }

      // 4. Enforce 10 MB cap (Telegram photo limit)
      if (bytes.byteLength > MAX_PHOTO_BYTES) {
        const err = new Error(
          `image_too_large: ${bytes.byteLength} bytes exceeds the 10 MB Telegram photo limit`,
        );
        err.name = 'image_too_large';
        throw err;
      }

      // 5. Upload via delivery helper (server-side, zero bytes in LLM context)
      await sendTelegramPhoto({
        chatId,
        botToken,
        photo: new Uint8Array(bytes),
        filename,
        caption: input.caption,
      });

      // 6. Return a tiny result — no image data
      return { ok: true, bytes: bytes.byteLength };
    },
  };
}
