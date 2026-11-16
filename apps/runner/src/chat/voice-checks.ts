// chat/voice-checks.ts — the last trial of each voice part, kept by the runner (#1048).
//
// Settings → Voice shows, under each part, whether it answers: the model,
// its time on the sample, and when that was checked. The screen reads it
// whenever it opens; making the voice speak (and the ear transcribe) at each
// opening would pay a synthesis for nothing. So the trial of a part — the one
// a save runs, or a "Check again" — is kept here, for EXACTLY the setting it
// tried, with its time, and returned as such: an old answer is shown with its
// old time, never presented as fresh.
//
// Kept in memory only: a restarted runner has tried nothing yet, and says so
// by trying again. The key is a digest of the part's setting (and, for the
// ear, of the voice that spoke the sample to it), key at rest included: a
// changed server, model or key is a different setting, never an old answer.

import { createHash } from 'node:crypto';
import type { VoiceCheck, VoicePart, VoiceSetting } from '@nodal-agents/shared';

/** How many trials the runner keeps at most, across workspaces: the oldest go first. */
export const VOICE_CHECKS_KEPT = 200;

const kept = new Map<string, VoiceCheck>();

/**
 * What the trial of a part depends on. The voice's trial depends on the
 * voice; the ear's on the ear AND on the voice that said the sample to it.
 */
function keyOf(entityId: string, part: VoicePart, s: VoiceSetting): string {
  const voice = [s.source, s.model, s.voice, s.speechServer ?? null];
  const ear = [s.transcriptionSource, s.transcriptionModel, s.transcriptionServer ?? null];
  const digest = createHash('sha256')
    .update(JSON.stringify(part === 'speaking' ? voice : [voice, ear]))
    .digest('hex');
  return `${entityId}|${part}|${digest}`;
}

/** The last trial of this part for exactly this setting, or `undefined`. */
export function keptVoiceCheck(
  entityId: string,
  part: VoicePart,
  setting: VoiceSetting,
): VoiceCheck | undefined {
  return kept.get(keyOf(entityId, part, setting));
}

export function keepVoiceCheck(
  entityId: string,
  part: VoicePart,
  setting: VoiceSetting,
  check: VoiceCheck,
): void {
  const k = keyOf(entityId, part, setting);
  kept.delete(k);
  kept.set(k, check);
  while (kept.size > VOICE_CHECKS_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

/** Forget every trial — for tests. */
export function clearVoiceChecks(): void {
  kept.clear();
}
