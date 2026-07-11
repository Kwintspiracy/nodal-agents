// communication/send-file.ts — server-side document/file delivery tool
//
// Registered per-agent when agents.telegramBotToken IS NOT NULL (same condition
// as telegram_send_message / send_image). The agent passes a source path or URL;
// the runner fetches the bytes server-side and uploads them to the user's chat
// as a downloadable attachment (Telegram: sendDocument) — which delivers ANY
// file type (PDF, .md, .txt, .csv, .zip, …), not just images.
// ZERO file bytes ever enter the LLM context — the return value is tiny.
//
// S3 (multichannel plan): uploads through the channel-neutral ChannelAdapter
// (getAdapter) rather than calling the Telegram document helper directly —
// see telegram-send-message.ts's file header for the rationale.

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
  channel: z
    .enum(['telegram', 'discord', 'slack', 'whatsapp'])
    .optional()
    .describe(
      'Target another connected platform; omit to reply on the current conversation’s channel.',
    ),
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

- **source**: file path or http(s) URL. A local path must be inside one of your
  workspaces, the skill store, or the temp directory — for anything else, use the
  service's http URL instead. localhost URLs are allowed.
- **filename**: optional name the recipient sees (keep the extension, e.g. "notes.md").
  Defaults to the name derived from the source.
- **caption**: optional, ≤1024 chars.
- **chatId**: optional. Omit to reply to the chat that triggered this job. An
  explicit chatId must already be an approved chat for this agent.
- **channel**: optional. Target another connected platform (telegram, discord,
  slack, whatsapp) instead of the current conversation's — the agent must have
  an ENABLED binding for it. Omit to reply on the current conversation's channel.

Size cap: 50 MB (Telegram document limit). Larger files throw \`file_too_large\`.

Fail conditions:
- No chatId provided and the job has no origin chat → throws \`no_recipient\`.
- Agent has no configured Telegram bot token → throws \`no_bot_token\`.
- Explicit chatId is not an approved chat → throws \`telegram_chat_not_allowed\`.
- Local source path is outside your workspaces/skill store/temp dir → throws
  \`source_path_not_allowed\`.
- Source URL returns non-2xx or resolves to a link-local address → throws
  \`fetch_failed\`.
- Bytes exceed 50 MB → throws \`file_too_large\`.
- \`channel\` names a platform this agent has no ENABLED binding for → throws
  \`channel_not_connected\`.`,

    inputSchema: SendFileInput,

    riskLevel: 'write',

    async execute(input: SendFileInput, ctx: ToolContext): Promise<SendFileOutput> {
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
      let derivedName: string;

      const src = input.source;

      if (src.startsWith('http://') || src.startsWith('https://')) {
        // Remote URL — streamed, capped, and link-local addresses blocked (F3).
        bytes = await fetchBoundedUrl(src, {
          maxBytes: MAX_DOCUMENT_BYTES,
          tooLargeErrorName: 'file_too_large',
        });

        const urlPath = new URL(src).pathname;
        derivedName = urlPath.split('/').pop() || 'file';
      } else {
        // Local file path — confined to workspaces/skill store/temp dir (F2).
        const realPath = await assertLocalSourceAllowed(src, ctx);
        bytes = await readFile(realPath);

        derivedName = src.split(/[\\/]/).pop() || 'file';
      }

      // 4. Enforce 50 MB cap (Telegram document limit). URL sources are
      // already capped while streaming (F3); this is the backstop for local reads.
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        const err = new Error(
          `file_too_large: ${bytes.byteLength} bytes exceeds the 50 MB Telegram document limit`,
        );
        err.name = 'file_too_large';
        throw err;
      }

      // 5. Upload via the channel-neutral adapter (server-side, zero bytes in LLM context)
      const filename = input.filename ?? derivedName;
      const adapter = getAdapter(await resolveChannelForJob(ctx, input.channel));
      await adapter.sendMedia({ botToken }, chatId, {
        kind: 'document',
        bytes,
        filename,
        caption: input.caption,
      });

      // 6. Return a tiny result — no file data
      return { ok: true, bytes: bytes.byteLength, filename };
    },
  };
}
