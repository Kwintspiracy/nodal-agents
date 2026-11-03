// voice-copy.ts — les mots de Réglages → Voice (#969), en un seul endroit.
//
// Le runner rend des CODES (invariant #2) ; ce module en fait les phrases de
// l'écran. Un code inconnu est dit tel quel, jamais remplacé par une phrase
// plausible (invariant #4).

export const SOURCE_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  google: 'Google',
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'its source';
  return SOURCE_LABELS[source] ?? source;
}

/** The fixed sentence "Play a sample" speaks. */
export const SAMPLE_SENTENCE = 'Hello, this is how I sound when I answer you.';

/** Why a source cannot be chosen, from the runner's code. */
export function sourceUnavailableText(source: string, code: string, detail?: string): string {
  const name = sourceLabel(source);
  switch (code) {
    case 'voice_key_missing':
      return `No ${name} key in this workspace. Add one in LLM Providers to speak through ${name}.`;
    case 'voice_key_undecryptable':
      return `The ${name} key could not be read. Enter it again in LLM Providers.`;
    case 'voice_catalog_unreachable':
      return `${name} did not list its voices${detail ? `: ${detail}` : ''}.`;
    default:
      return `${name} cannot be used (${code}).`;
  }
}

/** Why the stored voice cannot be shown. */
export function settingProblemText(code: string): string {
  if (code === 'voice_setting_missing') return 'No voice is set for this workspace. Choose one.';
  if (code === 'voice_setting_unreadable') return 'The stored voice could not be read. Choose one.';
  return `The stored voice cannot be used (${code}). Choose one.`;
}

/** A save or a sample the runner refused. */
export function refusalText(r: { error: string; source?: string; detail?: string }): string {
  switch (r.error) {
    case 'voice_not_offered':
      return `This model does not offer that voice${r.detail ? ` (${r.detail})` : ''}.`;
    case 'voice_model_not_offered':
      return `${sourceLabel(r.source)} does not serve this model.`;
    case 'voice_key_missing':
    case 'voice_key_undecryptable':
    case 'voice_catalog_unreachable':
      return sourceUnavailableText(r.source ?? '', r.error, r.detail);
    case 'runner_unreachable':
      return 'The runner did not answer.';
    case 'runner_contract':
      return 'The runner answered in a form this page does not read.';
    default:
      return `The voice was refused (${r.error}${r.detail ? `: ${r.detail}` : ''}).`;
  }
}

/** A sample that could not be spoken. */
export function sampleErrorText(
  e: { code: string; detail?: string },
  source: string | null,
): string {
  switch (e.code) {
    case 'speech_no_credit':
      return `The ${sourceLabel(source)} key has no credit left.`;
    case 'voice_key_missing':
    case 'voice_key_undecryptable':
      return sourceUnavailableText(source ?? e.detail ?? '', e.code);
    default:
      return `The sample could not be spoken (${e.code}).`;
  }
}

/** The line under the pickers: where the lists come from, and for how long they are kept. */
export function listedText(source: string, cacheSeconds: number): string {
  const hours = cacheSeconds / 3600;
  const kept =
    hours === 1 ? 'an hour' : hours >= 1 ? `${hours} hours` : `${cacheSeconds / 60} minutes`;
  return `Models and voices listed by ${sourceLabel(source)}, kept for ${kept}.`;
}
