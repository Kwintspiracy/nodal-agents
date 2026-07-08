// communication/send-media.ts — server-side inline media delivery tools.
//
// Generic factory behind send_video / send_audio / send_voice: each delivers a
// file to the user's Telegram chat through the matching native method so it
// renders inline (video player, music player, voice bubble) — rather than a
// plain attachment (that's send_file). Same contract as send_image/send_file:
// pass a path or URL, the runner fetches bytes server-side, ZERO bytes enter the
// LLM context, the return value is tiny.

import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { agents } from '@nodal-agents/db';
import { sendTelegramVideo, sendTelegramAudio, sendTelegramVoice } from '@nodal-agents/delivery';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition, ToolContext } from '../types';

const MB = 1024 * 1024;

type MediaSendFn = (opts: {
  chatId: string;
  botToken: string;
  bytes: Uint8Array;
  filename: string;
  caption?: string;
}) => Promise<{ messageId: number }>;

const MediaInput = z.object({
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
      'Optional filename the recipient sees (keep the extension). Defaults to the source name.',
    ),
  caption: z.string().max(1024).optional().describe('Optional caption (≤1024 chars).'),
  chatId: z
    .string()
    .regex(/^-?\d+$/, 'must be a numeric Telegram chat ID')
    .max(20)
    .optional()
    .describe('Telegram chat ID. Omit to reply to the chat that triggered this job.'),
});

type MediaInput = z.infer<typeof MediaInput>;
type MediaOutput = { ok: true; bytes: number; filename: string };

type MediaSpec = {
  name: string;
  send: MediaSendFn;
  maxBytes: number;
  errorName: string;
  defaultFilename: string;
  description: string;
};

/** Build a send_* media tool from a spec — shared fetch/cap/upload logic. */
function makeSendMediaTool(spec: MediaSpec): ToolDefinition<typeof MediaInput, MediaOutput> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: MediaInput,
    riskLevel: 'write',
    async execute(input: MediaInput, ctx: ToolContext): Promise<MediaOutput> {
      // 1. Resolve chatId — explicit arg wins, then job origin chat.
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

      // 3. Obtain bytes server-side — NEVER return them to the model.
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
        derivedName = new URL(src).pathname.split('/').pop() || spec.defaultFilename;
      } else {
        const nodeBuf = await readFile(src);
        bytes = nodeBuf.buffer.slice(
          nodeBuf.byteOffset,
          nodeBuf.byteOffset + nodeBuf.byteLength,
        ) as ArrayBuffer;
        derivedName = src.split(/[\\/]/).pop() || spec.defaultFilename;
      }

      // 4. Enforce the per-method size cap.
      if (bytes.byteLength > spec.maxBytes) {
        const err = new Error(
          `${spec.errorName}: ${bytes.byteLength} bytes exceeds the ${Math.round(
            spec.maxBytes / MB,
          )} MB limit`,
        );
        err.name = spec.errorName;
        throw err;
      }

      // 5. Upload via the delivery helper (server-side, zero bytes in context).
      const filename = input.filename ?? derivedName;
      await spec.send({
        chatId,
        botToken,
        bytes: new Uint8Array(bytes),
        filename,
        caption: input.caption,
      });

      return { ok: true, bytes: bytes.byteLength, filename };
    },
  };
}

export function createSendVideoTool(): ToolDefinition<typeof MediaInput, MediaOutput> {
  return makeSendMediaTool({
    name: 'send_video',
    send: sendTelegramVideo,
    maxBytes: 50 * MB,
    errorName: 'video_too_large',
    defaultFilename: 'video.mp4',
    description: `Deliver a video to the user with an INLINE PLAYER via Telegram (sendVideo).

For a playable video. (Use \`send_file\` to send a video as a plain download, or
\`send_image\` for a still image.) Pass \`source\` as a local file path or http(s)
URL — the runner fetches the bytes server-side; do NOT base64-encode it. The
return value is tiny: \`{ ok: true, bytes, filename }\`.

- source: file path or http(s) URL (localhost allowed).
- filename / caption / chatId: optional (chatId omitted → the triggering chat).

Size cap: 50 MB → throws \`video_too_large\`. Other failures: \`no_recipient\`,
\`no_bot_token\`, \`fetch_failed\`.`,
  });
}

export function createSendAudioTool(): ToolDefinition<typeof MediaInput, MediaOutput> {
  return makeSendMediaTool({
    name: 'send_audio',
    send: sendTelegramAudio,
    maxBytes: 50 * MB,
    errorName: 'audio_too_large',
    defaultFilename: 'audio.mp3',
    description: `Deliver an audio track to the user with a MUSIC PLAYER via Telegram (sendAudio).

For music/podcasts (mp3, m4a…). For a short spoken voice note use \`send_voice\`;
for a plain download use \`send_file\`. Pass \`source\` as a local file path or
http(s) URL — the runner fetches bytes server-side; do NOT base64-encode it.
Return value: \`{ ok: true, bytes, filename }\`.

- source / filename / caption / chatId as for send_video.

Size cap: 50 MB → throws \`audio_too_large\`. Other failures: \`no_recipient\`,
\`no_bot_token\`, \`fetch_failed\`.`,
  });
}

export function createSendVoiceTool(): ToolDefinition<typeof MediaInput, MediaOutput> {
  return makeSendMediaTool({
    name: 'send_voice',
    send: sendTelegramVoice,
    maxBytes: 50 * MB,
    errorName: 'voice_too_large',
    defaultFilename: 'voice.ogg',
    description: `Deliver a VOICE NOTE to the user (voice bubble) via Telegram (sendVoice).

For a short spoken message. Telegram expects OGG/Opus — for music use
\`send_audio\`, for any other file use \`send_file\`. Pass \`source\` as a local file
path or http(s) URL — bytes fetched server-side; do NOT base64-encode it.
Return value: \`{ ok: true, bytes, filename }\`.

- source / filename / caption / chatId as for send_video.

Size cap: 50 MB → throws \`voice_too_large\`. Other failures: \`no_recipient\`,
\`no_bot_token\`, \`fetch_failed\`.`,
  });
}
