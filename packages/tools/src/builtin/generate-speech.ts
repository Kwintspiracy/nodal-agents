// Built-in: generate_speech — text in, a WAV audio file written in the
// agent's folders (#487). WAV, not mp3: Gemini TTS through OpenRouter only
// answers raw PCM (it refused mp3 in run 16052ae6), which packages/speech wraps
// in a WAV header; there is no encoder to make an mp3 of it.
//
// The owner, 2026-09-25: "ce que je veux, c'est être capable de générer des
// fichiers audio à partir de texte". Not a talking agent: a file, like any
// other the agent writes.
//
// The audio comes from `ctx.speech`: the workspace's voice (#969), its source's
// SpeechAdapter of packages/speech, the one speech path of the platform
// (#940), which the runner binds to the workspace's key for that source
// (packages/tools never sees a key, same rule as web_search's premium
// backend). `model` and `voice` left out are the workspace's voice setting
// (Settings, Voice); given, they win, on the setting's source. Neither has a
// default written here any more. The file is written like `file_write` writes:
// the same folder resolution (never outside the agent's folders), the same
// atomic tempfile-then-rename, the same gate before overwriting a file in the
// shared workspace.
//
// Offered through the "Speech generation" tool group (Tools tab), never on by
// default (invariant #9).

import { mkdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { writeFileAtomically } from './file-ops/atomic-write';
import { z } from 'zod';
import type { ToolDefinition, ToolSpeech } from '../types';
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
      'Where to write the audio, relative to one of your folders, ending in .wav ' +
        '(e.g. "audio/intro.wav"). Missing folders are created.',
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "OPTIONAL. The speech model, as the workspace's voice source names it. Leave it out to " +
        "speak with the workspace's voice (the one set in Settings, Voice).",
    ),
  voice: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. The voice name, as the model names it. Leave it out to speak with the ' +
        "workspace's voice.",
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

/** `intro` → `intro.wav`, `intro.WAV` → `intro.wav`; any other extension is refused. */
function wavPath(path: string): string | null {
  const ext = extname(path);
  if (ext === '') return `${path}.wav`;
  return ext.toLowerCase() === '.wav' ? `${path.slice(0, -ext.length)}.wav` : null;
}

/**
 * Does this start like a WAV file (RIFF … WAVE)? Anything else would be
 * written as a broken file with no failure said (review of PR #488).
 */
export function looksLikeWav(bytes: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

export const generateSpeechTool: ToolDefinition<
  typeof GenerateSpeechInputSchema,
  GenerateSpeechOutput
> = {
  name: 'generate_speech',
  label: 'Generate speech',
  summary: 'Turn text into a WAV audio file in one of the agent folders.',
  description:
    'Turn text into speech and write it as a WAV audio file in your folders. Give the exact words ' +
    'to speak in `text` (no stage directions: they would be read aloud), the file `path`, and ' +
    'optionally the `model`, the `voice` and a delivery `style`. Returns the path of the file.',
  inputSchema: GenerateSpeechInputSchema,
  riskLevel: 'write',
  egress: 'model-provider',
  card: 'files',
  present: ({ output }) =>
    output.ok
      ? writtenFile(output.path, 'written', { bytes: output.bytes })
      : failureText(output.reason),
  mutatesWorkspace: true,
  resolveMutationTargets: async (input, ctx) => {
    const target = wavPath(input.path);
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
  replacesSharedFile: async (input, ctx) => {
    const target = wavPath(input.path);
    if (target === null) return false;
    return (await computeSharedOverwriteApproval(ctx, target)) === 'require_approval';
  },
  execute: async (input, ctx) => {
    const target = wavPath(input.path);
    if (target === null) {
      return {
        ok: false,
        reason: `The file is WAV: "${input.path}" must end in .wav (or have no extension).`,
      };
    }
    if (!ctx.speech) {
      return {
        ok: false,
        reason: 'Speech is not available in this run: no voice was given to it.',
      };
    }
    if (!ctx.speech.ok) return { ok: false, reason: unavailableReason(ctx.speech) };
    const workspace = ctx.speech.voice;
    // Explicit parameters win; left out, the workspace's voice setting speaks.
    const model = input.model ?? workspace.model;
    const voice = input.voice ?? workspace.voice;
    try {
      const path = await resolveAndCheckPath(ctx, target);
      const spoken = await workspace.speech.synthesize({
        model,
        text: input.text,
        voiceId: voice,
        ...(input.style !== undefined ? { style: input.style } : {}),
      });
      const audio = spoken.audio;
      if (audio.byteLength === 0) {
        return { ok: false, reason: `${model} returned no audio for this text.` };
      }
      if (!looksLikeWav(audio)) {
        return {
          ok: false,
          reason: `${model} answered, but not with audio. Nothing was written.`,
        };
      }
      if (audio.byteLength > MAX_SPEECH_BYTES) {
        return {
          ok: false,
          reason: `The audio is ${audio.byteLength} bytes (max ${MAX_SPEECH_BYTES}). Split the text.`,
        };
      }
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      // Atomic write, last ownership check and written-content fingerprint (#505).
      await writeFileAtomically(ctx, path, audio);
      return {
        ok: true,
        written: true,
        path,
        bytes: audio.byteLength,
        model,
        voice,
      };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Speech generation failed: ${message.slice(0, 400)}` };
    }
  },
};

const SOURCE_NAMES: Record<string, string> = { openrouter: 'OpenRouter', google: 'Google' };

/** Why the workspace cannot speak, for the agent to tell the owner. */
function unavailableReason(failure: Extract<ToolSpeech, { ok: false }>): string {
  const source = failure.source ? (SOURCE_NAMES[failure.source] ?? failure.source) : 'its source';
  switch (failure.code) {
    case 'voice_key_missing':
      return (
        `No active ${source} key in this workspace, and its voice (Settings, Voice) speaks ` +
        `through ${source}. Tell the owner to add one in Settings, LLM keys, or to choose ` +
        'another voice.'
      );
    case 'voice_key_undecryptable':
      return `The workspace ${source} key could not be decrypted${failure.detail ? ` (${failure.detail})` : ''}. Tell the owner to enter it again in Settings, LLM keys.`;
    default:
      return (
        `The workspace's voice cannot be used (${failure.code}` +
        `${failure.detail ? `: ${failure.detail}` : ''}). Tell the owner to check Settings, Voice.`
      );
  }
}
