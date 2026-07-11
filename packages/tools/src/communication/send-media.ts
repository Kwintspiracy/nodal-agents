// communication/send-media.ts — server-side inline media delivery tools.
//
// Generic factory behind send_video / send_audio / send_voice: each delivers a
// file to the user's chat through the matching native inline rendering (video
// player, music player, voice bubble) — rather than a plain attachment (that's
// send_file). Same contract as send_image/send_file: pass a path or URL, the
// runner fetches bytes server-side, ZERO bytes enter the LLM context, the
// return value is tiny.
//
// S3 (multichannel plan): uploads through the channel-neutral ChannelAdapter
// (getAdapter) rather than calling the Telegram media helpers directly — see
// telegram-send-message.ts's file header for the rationale.

import { z } from 'zod';
import { getAdapter, type OutboundMedia } from '@nodal-agents/delivery';
import { readFile } from 'node:fs/promises';
import {
  resolveBotToken,
  resolveRecipientChatId,
  resolveChannelForJob,
  assertLocalSourceAllowed,
  fetchBoundedUrl,
} from './delivery-guard';
import type { ToolDefinition, ToolContext } from '../types';

const MB = 1024 * 1024;

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
  channel: z
    .enum(['telegram', 'discord', 'slack', 'whatsapp'])
    .optional()
    .describe(
      'Target another connected platform; omit to reply on the current conversation’s channel.',
    ),
});

type MediaInput = z.infer<typeof MediaInput>;
type MediaOutput = { ok: true; bytes: number; filename: string };

type MediaSpec = {
  name: string;
  mediaKind: OutboundMedia['kind'];
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

      // 3. Obtain bytes server-side — NEVER return them to the model.
      let bytes: Uint8Array;
      let derivedName: string;
      const src = input.source;

      if (src.startsWith('http://') || src.startsWith('https://')) {
        // Remote URL — streamed, capped, and link-local addresses blocked (F3).
        bytes = await fetchBoundedUrl(src, {
          maxBytes: spec.maxBytes,
          tooLargeErrorName: spec.errorName,
        });
        derivedName = new URL(src).pathname.split('/').pop() || spec.defaultFilename;
      } else {
        // Local file path — confined to workspaces/skill store/temp dir (F2).
        const realPath = await assertLocalSourceAllowed(src, ctx);
        bytes = await readFile(realPath);
        derivedName = src.split(/[\\/]/).pop() || spec.defaultFilename;
      }

      // 4. Enforce the per-method size cap. URL sources are already capped
      // while streaming (F3); this is the backstop for local reads.
      if (bytes.byteLength > spec.maxBytes) {
        const err = new Error(
          `${spec.errorName}: ${bytes.byteLength} bytes exceeds the ${Math.round(
            spec.maxBytes / MB,
          )} MB limit`,
        );
        err.name = spec.errorName;
        throw err;
      }

      // 5. Upload via the channel-neutral adapter (server-side, zero bytes in context).
      const filename = input.filename ?? derivedName;
      const adapter = getAdapter(await resolveChannelForJob(ctx, input.channel));
      await adapter.sendMedia({ botToken }, chatId, {
        kind: spec.mediaKind,
        bytes,
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
    mediaKind: 'video',
    maxBytes: 50 * MB,
    errorName: 'video_too_large',
    defaultFilename: 'video.mp4',
    description: `Deliver a video to the user with an INLINE PLAYER via Telegram (sendVideo).

For a playable video. (Use \`send_file\` to send a video as a plain download, or
\`send_image\` for a still image.) Pass \`source\` as a local file path or http(s)
URL — the runner fetches the bytes server-side; do NOT base64-encode it. The
return value is tiny: \`{ ok: true, bytes, filename }\`.

- source: file path or http(s) URL (localhost allowed). A local path must be
  inside one of your workspaces, the skill store, or the temp directory.
- filename / caption: optional.
- chatId: optional (omitted → the triggering chat); an explicit chatId must
  already be an approved chat for this agent.
- channel: optional. Target another connected platform instead of the current
  conversation's — the agent must have an ENABLED binding for it.

Size cap: 50 MB → throws \`video_too_large\`. Other failures: \`no_recipient\`,
\`no_bot_token\`, \`telegram_chat_not_allowed\`, \`source_path_not_allowed\`,
\`fetch_failed\`, \`channel_not_connected\`.`,
  });
}

export function createSendAudioTool(): ToolDefinition<typeof MediaInput, MediaOutput> {
  return makeSendMediaTool({
    name: 'send_audio',
    mediaKind: 'audio',
    maxBytes: 50 * MB,
    errorName: 'audio_too_large',
    defaultFilename: 'audio.mp3',
    description: `Deliver an audio track to the user with a MUSIC PLAYER via Telegram (sendAudio).

For music/podcasts (mp3, m4a…). For a short spoken voice note use \`send_voice\`;
for a plain download use \`send_file\`. Pass \`source\` as a local file path or
http(s) URL — the runner fetches bytes server-side; do NOT base64-encode it.
Return value: \`{ ok: true, bytes, filename }\`.

- source / filename / caption / chatId / channel as for send_video.

Size cap: 50 MB → throws \`audio_too_large\`. Other failures: \`no_recipient\`,
\`no_bot_token\`, \`telegram_chat_not_allowed\`, \`source_path_not_allowed\`,
\`fetch_failed\`, \`channel_not_connected\`.`,
  });
}

export function createSendVoiceTool(): ToolDefinition<typeof MediaInput, MediaOutput> {
  return makeSendMediaTool({
    name: 'send_voice',
    mediaKind: 'voice',
    maxBytes: 50 * MB,
    errorName: 'voice_too_large',
    defaultFilename: 'voice.ogg',
    description: `Deliver a VOICE NOTE to the user (voice bubble) via Telegram (sendVoice).

For a short spoken message. Telegram expects OGG/Opus — for music use
\`send_audio\`, for any other file use \`send_file\`. Pass \`source\` as a local file
path or http(s) URL — bytes fetched server-side; do NOT base64-encode it.
Return value: \`{ ok: true, bytes, filename }\`.

- source / filename / caption / chatId / channel as for send_video.

Size cap: 50 MB → throws \`voice_too_large\`. Other failures: \`no_recipient\`,
\`no_bot_token\`, \`telegram_chat_not_allowed\`, \`source_path_not_allowed\`,
\`fetch_failed\`, \`channel_not_connected\`.`,
  });
}
