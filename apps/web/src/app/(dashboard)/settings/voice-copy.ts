// voice-copy.ts — les mots de Réglages → Voice (#969), en un seul endroit.
//
// Le runner rend des CODES (invariant #2) ; ce module en fait les phrases de
// l'écran. Un code inconnu est dit tel quel, jamais remplacé par une phrase
// plausible (invariant #4).

export const SOURCE_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  google: 'Google',
  // A server the person runs, at the address they give (#1048).
  'openai-compatible': 'Local server',
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
export function refusalText(r: {
  error: string;
  source?: string;
  detail?: string;
  /** What the ear wrote instead of the sample (#1048). */
  heard?: string;
  /** The model that was tried, when the screen knows it. */
  model?: string;
}): string {
  const server = r.source === 'openai-compatible';
  switch (r.error) {
    case 'voice_not_offered':
      return `This model does not offer that voice${r.detail ? ` (${r.detail})` : ''}.`;
    case 'voice_model_not_offered':
      return server
        ? 'Your server does not list this model.'
        : `${sourceLabel(r.source)} does not serve this model.`;
    case 'voice_server_key_not_kept':
      return 'The saved key belongs to another address. Type the key for this server, or leave it empty if it asks for none.';
    case 'speech_unreachable':
      return `Not saved. ${unreachableText(r.detail)}`;
    case 'voice_key_missing':
    case 'voice_key_undecryptable':
    case 'voice_catalog_unreachable':
      return sourceUnavailableText(r.source ?? '', r.error, r.detail);
    case 'runner_unreachable':
      return 'The runner did not answer.';
    case 'runner_contract':
      return 'The runner answered in a form this page does not read.';
    // The voice was tried before it was saved, and did not speak (#972, pass 1):
    // the vendor's words say why.
    case 'speech_no_credit':
      return `The ${sourceLabel(r.source)} key has no credit left. The voice was not saved.`;
    // The transcription model was tried before it was saved (#976): the voice
    // said "OK." and the model had to write it down.
    // What it wrote is quoted when the runner says it (#1048, the "Refused"
    // state of the approved mockup).
    case 'transcription_not_faithful':
      return r.heard !== undefined
        ? `Not saved. The sample “OK.”, spoken by your voice, came back${r.model ? ` from ${r.model}` : ''} as ${r.heard === '' ? 'nothing at all.' : `“${r.heard}”`}`
        : `This model did not write down what the voice said, so it was not saved: ${r.detail ?? r.error}`;
    case 'transcription_needs_voice':
      return `The transcription model is tried on what the voice says, and the voice did not speak: ${r.detail ?? r.error}`;
    case 'transcription_model_not_offered':
      return server
        ? 'Your server does not list this transcription model.'
        : 'OpenRouter does not serve this transcription model.';
    case 'transcription_failed':
      return `This model did not transcribe what the voice said, so it was not saved: ${r.detail ?? r.error}`;
    case 'speech_provider_error':
    case 'speech_bad_request':
      return `This voice did not speak, so it was not saved: ${r.detail ?? r.error}`;
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

/** The line under the transcription picker: where the list comes from (#976). */
export function earListedText(cacheSeconds: number): string {
  const hours = cacheSeconds / 3600;
  const kept =
    hours === 1 ? 'an hour' : hours >= 1 ? `${hours} hours` : `${cacheSeconds / 60} minutes`;
  return `Transcription models listed by OpenRouter, kept for ${kept}.`;
}

/** Why the transcription models cannot be chosen (#976). */
export function earUnavailableText(code: string, detail?: string): string {
  if (code === 'voice_key_missing') {
    return 'No OpenRouter key in this workspace. Add one in LLM Providers to transcribe what you say.';
  }
  return sourceUnavailableText('openrouter', code, detail);
}

// ─── A server the person runs (#1048) ────────────────────────────────────────

/** The host and port of an address, as the person typed it: `127.0.0.1:8786`. */
export function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** Under the source: what a local server is, and that Nodal never runs it. */
export function serverHint(part: 'speaking' | 'listening'): {
  before: string;
  route: string;
  after: string;
} {
  return part === 'speaking'
    ? {
        before:
          'A speech server you run yourself. Nodal sends it the reply at the standard address, ',
        route: '/audio/speech',
        after: '. Nodal does not start or stop it.',
      }
    : {
        before:
          'A transcription server you run yourself, on this computer or your network. Nodal sends it the audio at the standard address, ',
        route: '/audio/transcriptions',
        after: '. Nodal does not start or stop it.',
      };
}

export const KEY_PLACEHOLDER = 'Only if your server asks for one';
export const KEY_KEPT_PLACEHOLDER = 'A key is saved. Type a new one to replace it';

/** "Nothing listens at 127.0.0.1:8786 (connection refused).", from the runner's words. */
export function unreachableText(detail?: string): string {
  const url = /^(https?:\/\/[^\s/]+)/.exec(detail ?? '')?.[1];
  const code = /no answer \(([^)]+)\)/.exec(detail ?? '')?.[1];
  const why =
    code === 'ECONNREFUSED'
      ? 'connection refused'
      : code === 'ENOTFOUND'
        ? 'unknown host'
        : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
          ? 'no answer in time'
          : code === 'ECONNRESET' || code === 'UND_ERR_SOCKET'
            ? 'the connection was closed'
            : (code ?? detail ?? 'no answer');
  return `Nothing listens at ${url ? hostOf(url) : 'that address'} (${why}).`;
}

export type ServerListing =
  | { state: 'listed'; models: readonly { id: string }[] }
  | { state: 'unavailable'; code: string; detail?: string }
  | { state: 'loading' };

/** The line under a server's model field: where the models come from, or why none. */
export function serverListedText(
  address: string,
  listing: ServerListing | null,
  part: 'speaking' | 'listening',
): { text: string; route?: string; after?: string } {
  const host = hostOf(address);
  if (listing === null) return { text: 'Type the address of your server.' };
  if (listing.state === 'loading') return { text: `Reading the models of the server at ${host}…` };
  if (listing.state === 'unavailable') {
    return listing.code === 'speech_unreachable'
      ? { text: 'The saved model. The server could not list its models: it does not answer.' }
      : {
          text: `The server at ${host} did not list its models (${listing.code}${
            listing.detail ? `: ${listing.detail}` : ''
          }).`,
        };
  }
  if (listing.models.length === 0) {
    return {
      text: `The server at ${host} answers, but lists no models at `,
      route: '/models',
      after: '. Type the name it expects; Nodal checks it on the sample when you save.',
    };
  }
  return part === 'speaking'
    ? {
        text: `Models listed by the server at ${host}. Servers do not list their voices in a standard way: type the name your server's documentation gives.`,
      }
    : { text: `Models listed by the server at ${host}, read just now.` };
}

/** A time of the day, as the person reads it: 10:42. */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Seconds, two decimals: 0.21 s. */
export function secondsOf(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Why a part does not answer, from the trial's code and the words that came back. */
export function notAnsweringText(c: {
  code: string;
  detail?: string;
  heard?: string;
  model?: string;
}): string {
  switch (c.code) {
    case 'speech_unreachable':
      return unreachableText(c.detail);
    case 'transcription_not_faithful':
      return c.heard === undefined || c.heard === ''
        ? `${c.model ?? 'The model'} wrote nothing for the sample “OK.”.`
        : `${c.model ?? 'The model'} wrote “${c.heard}” for the sample “OK.”.`;
    case 'transcription_needs_voice':
      return `The sample is spoken by your voice, and the voice did not speak${
        c.detail ? `: ${c.detail}` : '.'
      }`;
    case 'voice_setting_missing':
      return 'No voice is saved for this workspace yet.';
    default:
      return `${c.code}${c.detail ? `: ${c.detail}` : ''}.`;
  }
}

/** The line after a part on a server that does not answer. */
export function serverDownHelp(part: 'speaking' | 'listening'): string {
  return part === 'listening'
    ? 'Start your transcription server, then check again. Until it answers, what you say to Nodal gets this same error back. Nodal does not switch to OpenRouter on its own.'
    : "Start your speech server, then check again. Until it answers, Nodal's replies are not spoken. Nodal does not switch to another voice on its own.";
}

/** The status of a part whose fields are not complete yet. */
export function notCheckedText(part: 'speaking' | 'listening'): string {
  return part === 'listening'
    ? 'Choose a model to try the sample “OK.” on it.'
    : 'Choose a model and a voice to try the sample “OK.” with them.';
}

/** Where a part goes, in the unsaved-change line. */
export function destinationOf(source: string, address?: string): string {
  if (source !== 'openai-compatible') return sourceLabel(source);
  const host = address ? hostOf(address) : '';
  return /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)
    ? 'the local server'
    : `the server at ${host || 'its address'}`;
}

/** The second line of a refusal that quotes what the ear wrote. */
export function notFaithfulHelp(stays: string | null): string {
  return `A model that does not write back a known sample would get what you say wrong too. Choose another model, then save again. Nothing changed${
    stays ? `: listening stays on ${stays}` : ''
  }.`;
}
