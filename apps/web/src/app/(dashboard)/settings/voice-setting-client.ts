'use client';

// voice-setting-client.ts — Réglages → Voice, du point de vue du navigateur (#969).
//
// Le client des routes du runner (`/api/voice/setting`, `/api/voice/sample`),
// par la porte web, exactement comme un module externe les appelle. Aucune
// décision ici : la réponse du runner est validée par les schémas de
// @nodal-agents/shared, et une réponse d'une autre forme est une erreur dite,
// jamais un écran à moitié rempli (invariant #4).

import { VoiceStateSchema, type VoiceSetting, type VoiceState } from '@nodal-agents/shared';
import { readSseMessages } from '@/lib/sse.ts';
import type { SpokenChunk } from '../chat/voice-playback.ts';

/** Un refus du runner, tel qu'il l'a codé. */
export type VoiceRefusal = { error: string; source?: string; detail?: string };

export type VoiceResult<T> = { ok: true; data: T } | { ok: false; refusal: VoiceRefusal };

async function refusalOf(res: Response): Promise<VoiceRefusal> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    error: typeof body?.['error'] === 'string' ? body['error'] : `http_${String(res.status)}`,
    ...(typeof body?.['source'] === 'string' ? { source: body['source'] } : {}),
    ...(typeof body?.['detail'] === 'string' ? { detail: body['detail'] } : {}),
  };
}

const unreachable: VoiceResult<never> = { ok: false, refusal: { error: 'runner_unreachable' } };

export async function readVoiceState(): Promise<VoiceResult<VoiceState>> {
  let res: Response;
  try {
    res = await fetch('/api/voice/setting', { cache: 'no-store' });
  } catch {
    return unreachable;
  }
  if (!res.ok) return { ok: false, refusal: await refusalOf(res) };
  const parsed = VoiceStateSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { ok: false, refusal: { error: 'runner_contract' } };
  return { ok: true, data: parsed.data };
}

export async function saveVoiceSetting(setting: VoiceSetting): Promise<VoiceResult<VoiceSetting>> {
  let res: Response;
  try {
    res = await fetch('/api/voice/setting', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setting }),
    });
  } catch {
    return unreachable;
  }
  if (!res.ok) return { ok: false, refusal: await refusalOf(res) };
  return { ok: true, data: setting };
}

/** Ce que l'essai a rendu : la voix qui a parlé, et son échec s'il y en a eu un. */
export type SampleDone = {
  speechError: { code: string; detail?: string } | null;
  source: string | null;
  model: string | null;
  voice: string | null;
};

/**
 * L'essai d'une voix : la phrase, dite par le chemin du tour. Chaque morceau
 * part à `onAudio` dans l'ordre de son rang ; `done` fait foi.
 */
export async function playVoiceSample(opts: {
  text: string;
  setting?: VoiceSetting;
  signal: AbortSignal;
  onAudio: (chunk: SpokenChunk) => void;
  /** Tout l'audio d'une phrase est arrivé (`audio_end`) : une voix compressée se décode alors. */
  onAudioEnd: () => void;
}): Promise<VoiceResult<SampleDone> | { ok: 'aborted' }> {
  let res: Response;
  try {
    res = await fetch('/api/voice/sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: opts.text, ...(opts.setting ? { setting: opts.setting } : {}) }),
      signal: opts.signal,
    });
  } catch {
    if (opts.signal.aborted) return { ok: 'aborted' };
    return unreachable;
  }
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return { ok: false, refusal: await refusalOf(res) };
  }
  try {
    for await (const msg of readSseMessages(res.body!)) {
      const data = JSON.parse(msg.data) as Record<string, unknown>;
      if (msg.event === 'audio') {
        opts.onAudio({
          seq: Number(data['seq']),
          mimeType: String(data['mimeType']),
          ...(typeof data['sampleRate'] === 'number' ? { sampleRate: data['sampleRate'] } : {}),
          bytes: Uint8Array.from(atob(String(data['base64'])), (c) => c.charCodeAt(0)),
        });
      } else if (msg.event === 'audio_end') {
        opts.onAudioEnd();
      } else if (msg.event === 'done') {
        return { ok: true, data: data as unknown as SampleDone };
      } else if (msg.event === 'error') {
        return { ok: false, refusal: { error: String(data['error'] ?? 'sample_failed') } };
      }
    }
  } catch {
    if (opts.signal.aborted) return { ok: 'aborted' };
    return { ok: false, refusal: { error: 'stream_interrupted' } };
  }
  if (opts.signal.aborted) return { ok: 'aborted' };
  return { ok: false, refusal: { error: 'stream_interrupted' } };
}
