// bind.ts — an adapter and the connection it speaks with, as one value.
//
// The runner resolves the key (it is the only layer that may decrypt one) and
// hands its callers an adapter already bound to it. A caller such as the
// `generate_speech` tool then speaks without ever holding the key, the same
// way `web_search` gets a search backend rather than a credential.
//
// The bound value keeps the adapter's whole surface, `synthesizeStream`
// included when the adapter has it: a streaming caller branches on
// `capabilities.streamOutput` exactly as it would on the adapter itself.

import { SpeechError } from './errors.ts';
import type {
  SpeechAdapter,
  SpeechCapabilities,
  SpeechConnection,
  SpeechProvider,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionAdapter,
  TranscriptionCapabilities,
  Voice,
} from './speech-adapter.ts';

export interface BoundSpeech {
  readonly provider: SpeechProvider;
  readonly capabilities: SpeechCapabilities;
  listVoices(): Promise<readonly Voice[]>;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
  synthesizeStream?(req: SynthesizeRequest): AsyncIterable<Uint8Array>;
}

export interface BoundTranscription {
  readonly provider: SpeechProvider;
  readonly capabilities: TranscriptionCapabilities;
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
}

/** An empty key is refused when binding, not on the first call: the caller
 *  learns it where it built the value, not in the middle of an agent's turn. */
function assertKey(provider: SpeechProvider, connection: SpeechConnection): void {
  if (connection.apiKey.trim().length === 0) {
    throw new SpeechError('speech_bad_request', `${provider}: the connection has no API key`);
  }
}

export function bindSpeech(adapter: SpeechAdapter, connection: SpeechConnection): BoundSpeech {
  assertKey(adapter.provider, connection);
  const stream = adapter.synthesizeStream;
  return {
    provider: adapter.provider,
    capabilities: adapter.capabilities,
    listVoices: () => adapter.listVoices(connection),
    synthesize: (req) => adapter.synthesize(req, connection),
    ...(stream
      ? { synthesizeStream: (req: SynthesizeRequest) => stream.call(adapter, req, connection) }
      : {}),
  };
}

export function bindTranscription(
  adapter: TranscriptionAdapter,
  connection: SpeechConnection,
): BoundTranscription {
  assertKey(adapter.provider, connection);
  return {
    provider: adapter.provider,
    capabilities: adapter.capabilities,
    transcribe: (req) => adapter.transcribe(req, connection),
  };
}
