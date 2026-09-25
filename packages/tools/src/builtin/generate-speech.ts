// Built-in: generate_speech — text in, an mp3 file written in the agent's
// folders (#487).
//
// The owner, 2026-09-25: "ce que je veux, c'est être capable de générer des
// fichiers audio à partir de texte". Not a talking agent: a file, like any
// other the agent writes.
//
// The audio comes from `ctx.speechGenerator`, which the runner builds on the
// workspace's OpenRouter key (packages/tools never sees a key, same rule as
// web_search's premium backend). The file is written like `file_write` writes:
// the same folder resolution (never outside the agent's folders), the same
// atomic tempfile-then-rename, the same gate before overwriting a file in the
// shared workspace.
//
// Offered through the "Speech generation" tool group (Tools tab), never on by
// default (invariant #9).

import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_SPEECH_VOICE, SPEECH_MODELS, SPEECH_MODEL_IDS } from '@nodal-agents/shared';
import type { ToolDefinition } from '../types';
import { failureText, writtenFile } from '../presenters';
import { deliverableTypeForWrittenFile } from '../verification/written-file-type';
import {
  resolveAndCheckPath,
  computeSharedOverwriteApproval,
  MAX_WRITE_BYTES,
  WorkspaceError,
} from './file-ops/workspace';

/**
 * The models take 8,192 tokens of context; this keeps a request well inside
 * it. Longer text is split by the agent into several files.
 */
export const MAX_SPEECH_CHARS = 5_000;

/** An audio file can be larger than a text file; still bounded. */
export const MAX_SPEECH_BYTES = 20 * MAX_WRITE_BYTES;

export const GenerateSpeechInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_SPEECH_CHARS)
    .describe(
      `The exact words to speak (max ${MAX_SPEECH_CHARS} characters). Everything here is read ` +
        'aloud: put no stage directions in it, use `style` for the tone.',
    ),
  path: z
    .string()
    .min(1)
    .describe(
      'Where to write the audio, relative to one of your folders, ending in .mp3 ' +
        '(e.g. "audio/intro.mp3"). Missing folders are created.',
    ),
  model: z
    .enum(SPEECH_MODEL_IDS)
    .optional()
    .default(SPEECH_MODEL_IDS[0])
    .describe(SPEECH_MODELS.map((m) => `${m.id}: ${m.summary}`).join(' ')),
  voice: z
    .string()
    .min(1)
    .optional()
    .default(DEFAULT_SPEECH_VOICE)
    .describe(
      `The voice name, as the model's provider names it (default "${DEFAULT_SPEECH_VOICE}").`,
    ),
  style: z
    .string()
    .optional()
    .describe(
      'OPTIONAL. The sustained delivery style, in a few words ("warm and friendly", ' +
        '"calm and slow", "whispering"). Never read aloud.',
    ),
  purpose: z
    .string()
    .optional()
    .describe(
      'OPTIONAL. One short sentence on WHY this file is needed. Shown on the approval card ' +
        'when this call overwrites a file in the shared workspace.',
    ),
});

export type GenerateSpeechInput = z.infer<typeof GenerateSpeechInputSchema>;
export type GenerateSpeechOutput =
  | { ok: true; written: true; path: string; bytes: number; model: string; voice: string }
  | { ok: false; reason: string };

/** `intro` → `intro.mp3`; any other extension is refused (the file is mp3). */
function mp3Path(path: string): string | null {
  const ext = extname(path).toLowerCase();
  if (ext === '') return `${path}.mp3`;
  return ext === '.mp3' ? path : null;
}

export const generateSpeechTool: ToolDefinition<
  typeof GenerateSpeechInputSchema,
  GenerateSpeechOutput
> = {
  name: 'generate_speech',
  label: 'Generate speech',
  summary: 'Turn text into an mp3 file in one of the agent folders.',
  description:
    'Turn text into speech and write it as an mp3 file in your folders. Give the exact words ' +
    'to speak in `text` (no stage directions: they would be read aloud), the file `path`, and ' +
    'optionally the `model`, the `voice` and a delivery `style`. Returns the path of the file.',
  inputSchema: GenerateSpeechInputSchema,
  riskLevel: 'write',
  card: 'files',
  present: ({ output }) =>
    output.ok
      ? writtenFile(output.path, 'written', { bytes: output.bytes })
      : failureText(output.reason),
  mutatesWorkspace: true,
  resolveMutationTargets: async (input, ctx) => {
    const target = mp3Path(input.path);
    if (target === null) return [];
    let path: string;
    try {
      path = await resolveAndCheckPath(ctx, target);
    } catch {
      return [];
    }
    return [
      { kind: 'file', path, deliverableType: await deliverableTypeForWrittenFile(ctx, path) },
    ];
  },
  computeApproval: async (input, ctx) => {
    const target = mp3Path(input.path);
    if (target === null) return undefined;
    return computeSharedOverwriteApproval(ctx, target);
  },
  execute: async (input, ctx) => {
    const target = mp3Path(input.path);
    if (target === null) {
      return {
        ok: false,
        reason: `The file is mp3: "${input.path}" must end in .mp3 (or have no extension).`,
      };
    }
    if (!ctx.speechGenerator) {
      return {
        ok: false,
        reason:
          'No active OpenRouter key in this workspace: speech is generated through OpenRouter. ' +
          'Tell the owner to add one in Settings, LLM keys.',
      };
    }
    try {
      const path = await resolveAndCheckPath(ctx, target);
      const audio = await ctx.speechGenerator({
        model: input.model,
        text: input.text,
        voice: input.voice,
        ...(input.style !== undefined ? { style: input.style } : {}),
      });
      if (audio.bytes.byteLength === 0) {
        return { ok: false, reason: `${input.model} returned no audio for this text.` };
      }
      if (audio.bytes.byteLength > MAX_SPEECH_BYTES) {
        return {
          ok: false,
          reason: `The audio is ${audio.bytes.byteLength} bytes (max ${MAX_SPEECH_BYTES}). Split the text.`,
        };
      }
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const tmp = `${dir}/.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, audio.bytes);
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      return {
        ok: true,
        written: true,
        path,
        bytes: audio.bytes.byteLength,
        model: input.model,
        voice: input.voice,
      };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Speech generation failed: ${message.slice(0, 400)}` };
    }
  },
};
