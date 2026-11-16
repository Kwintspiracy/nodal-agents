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
  SpeechModelOffer,
  SpeechProvider,
  SpeechStreamChunk,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionAdapter,
  TranscriptionCapabilities,
  TranscriptionModelOffer,
  Voice,
} from './speech-adapter.ts';

export interface BoundSpeech {
  readonly provider: SpeechProvider;
  readonly capabilities: SpeechCapabilities;
  listVoices(): Promise<readonly Voice[]>;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
  synthesizeStream?(req: SynthesizeRequest): AsyncIterable<SpeechStreamChunk>;
  listModels?(): Promise<readonly SpeechModelOffer[]>;
}

export interface BoundTranscription {
  readonly provider: SpeechProvider;
  readonly capabilities: TranscriptionCapabilities;
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
  listModels?(): Promise<readonly TranscriptionModelOffer[]>;
}

/** An empty key is refused when binding, not on the first call: the caller
 *  learns it where it built the value, not in the middle of an agent's turn.
 *  An adapter that needs no key says so (`requiresKey: false`, a server the
 *  user runs, #1048): that is the adapter's fact, never a guess here. */
function assertKey(
  adapter: { provider: SpeechProvider; requiresKey: boolean },
  connection: SpeechConnection,
): void {
  if (adapter.requiresKey && connection.apiKey.trim().length === 0) {
    throw new SpeechError(
      'speech_bad_request',
      `${adapter.provider}: the connection has no API key`,
    );
  }
}

export function bindSpeech(adapter: SpeechAdapter, connection: SpeechConnection): BoundSpeech {
  assertKey(adapter, connection);
  const stream = adapter.synthesizeStream;
  const models = adapter.listModels;
  return {
    provider: adapter.provider,
    capabilities: adapter.capabilities,
    listVoices: () => adapter.listVoices(connection),
    synthesize: (req) => adapter.synthesize(req, connection),
    ...(stream
      ? { synthesizeStream: (req: SynthesizeRequest) => stream.call(adapter, req, connection) }
      : {}),
    ...(models ? { listModels: () => models.call(adapter, connection) } : {}),
  };
}

export function bindTranscription(
  adapter: TranscriptionAdapter,
  connection: SpeechConnection,
): BoundTranscription {
  assertKey(adapter, connection);
  const models = adapter.listModels;
  return {
    provider: adapter.provider,
    capabilities: adapter.capabilities,
    transcribe: (req) => adapter.transcribe(req, connection),
    ...(models ? { listModels: () => models.call(adapter, connection) } : {}),
  };
}
