// communication/send-image.ts — server-side image/file delivery tool
//
// Registered per-agent when agents.telegramBotToken IS NOT NULL (same condition
// as telegram_send_message). The agent passes a source path or URL; the runner
// fetches the bytes server-side and uploads them to the user's chat.
// ZERO image bytes ever enter the LLM context — the return value is tiny.
//
// S3 (multichannel plan): uploads through the channel-neutral ChannelAdapter
// (getAdapter) rather than calling the Telegram photo helper directly — see
// telegram-send-message.ts's file header for the rationale.

import { z } from 'zod';
import { getAdapter } from '@nodal-agents/delivery';
import { readFile } from 'node:fs/promises';
import {
  resolveBotToken,
  resolveRecipientChatId,
  resolveChannelForJob,
  assertLocalSourceAllowed,
  fetchBoundedUrl,
} from './delivery-guard';
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
  channel: z
    .enum(['telegram', 'discord', 'slack', 'whatsapp'])
    .optional()
    .describe(
      'Target another connected platform; omit to reply on the current conversation’s channel.',
    ),
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

- **source**: file path or http(s) URL. A local path must be inside one of your
  workspaces, the skill store, or the temp directory — for anything else, use the
  service's http URL instead (e.g. ComfyUI's \`/view\` endpoint). localhost URLs
  are allowed — the runner runs on the user's machine, so ComfyUI and similar
  local services are reachable.
- **caption**: optional, ≤1024 chars (Telegram's caption limit).
- **chatId**: optional. Omit to reply to the chat that triggered this job. An
  explicit chatId must already be an approved chat for this agent.
- **channel**: optional. Target another connected platform (telegram, discord,
  slack, whatsapp) instead of the current conversation's — the agent must have
  an ENABLED binding for it. Omit to reply on the current conversation's channel.

Size cap: 10 MB (Telegram photo limit). Larger files throw \`image_too_large\`.

Fail conditions:
- No chatId provided and the job has no origin chat → throws \`no_recipient\`.
- Agent has no configured Telegram bot token → throws \`no_bot_token\`.
- Explicit chatId is not an approved chat → throws \`telegram_chat_not_allowed\`.
- Local source path is outside your workspaces/skill store/temp dir → throws
  \`source_path_not_allowed\`.
- Source URL returns non-2xx or resolves to a link-local address → throws
  \`fetch_failed\`.
- Bytes exceed 10 MB → throws \`image_too_large\`.
- \`channel\` names a platform this agent has no ENABLED binding for → throws
  \`channel_not_connected\`.`,

    inputSchema: SendImageInput,

    riskLevel: 'write',
    card: 'sent',

    async execute(input: SendImageInput, ctx: ToolContext): Promise<SendImageOutput> {
      // 1. Resolve + authorize chatId — explicit arg wins (must be approved
      // unless it's the job's own origin chat), then job origin chat (F1).
      // `input.channel` targets another connected platform when given — see
      // resolveRecipientChatId's doc comment for the cross-channel rules.
      const chatId = await resolveRecipientChatId(input.chatId, ctx, 'no_recipient', input.channel);

      // 2. Bot token — the runner's resolved token wins (B3: a delegated worker
      // inheriting its entity's root agent's token); otherwise fall back to this
      // agent's own token from DB (credential isolation per agent, historical path).
      const botToken = await resolveBotToken(ctx, input.channel);
      if (!botToken) {
        const err = new Error('no_bot_token');
        err.name = 'no_bot_token';
        throw err;
      }

      // 3. Obtain bytes server-side — NEVER return them to the model
      let bytes: Uint8Array;
      let filename: string;

      const src = input.source;

      if (src.startsWith('http://') || src.startsWith('https://')) {
        // Remote URL (ComfyUI, external CDN, etc.) — streamed, capped, and
        // link-local addresses blocked (F3).
        bytes = await fetchBoundedUrl(src, {
          maxBytes: MAX_PHOTO_BYTES,
          tooLargeErrorName: 'image_too_large',
        });

        // Derive filename from URL path (last segment before query string)
        const urlPath = new URL(src).pathname;
        filename = urlPath.split('/').pop() ?? 'image.png';
        if (!filename.includes('.')) filename = 'image.png';
      } else {
        // Local file path — confined to workspaces/skill store/temp dir (F2).
        const realPath = await assertLocalSourceAllowed(src, ctx);
        bytes = await readFile(realPath);

        // Derive filename from the path
        filename = src.split(/[\\/]/).pop() ?? 'image.png';
      }

      // 4. Enforce 10 MB cap (Telegram photo limit). URL sources are already
      // capped while streaming (F3); this is the backstop for local reads.
      if (bytes.byteLength > MAX_PHOTO_BYTES) {
        const err = new Error(
          `image_too_large: ${bytes.byteLength} bytes exceeds the 10 MB Telegram photo limit`,
        );
        err.name = 'image_too_large';
        throw err;
      }

      // 5. Upload via the channel-neutral adapter (server-side, zero bytes in LLM context)
      const adapter = getAdapter(await resolveChannelForJob(ctx, input.channel));
      await adapter.sendMedia({ botToken }, chatId, {
        kind: 'photo',
        bytes,
        filename,
        caption: input.caption,
      });

      // 6. Return a tiny result — no image data
      return { ok: true, bytes: bytes.byteLength };
    },
  };
}
