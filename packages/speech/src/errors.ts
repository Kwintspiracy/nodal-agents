import { redactSecretsInText } from '@nodal-agents/shared';

/**
 * Every failure in this package is one of these codes. Deliberately narrow: a
 * caller has to be able to tell "the vendor said no" (retry, or tell the user
 * their key is out of credit) from "you asked for something impossible"
 * (a programming error) without parsing prose.
 */
export type SpeechErrorCode =
  /** No adapter registered for the requested provider. Config/programming error. */
  | 'speech_provider_not_found'
  /** The provider answered, but not with audio/text — bad key, refusal. */
  | 'speech_provider_error'
  /** The provider refused because the key has no credit left (HTTP 402).
   *  Its own code because it is the one refusal the person fixes themselves,
   *  at the vendor, and a screen or a module says so without parsing prose
   *  (#969: the workspace's Google key answered 402 "Your prepayment credits
   *  are depleted" on 2026-11-03). */
  | 'speech_no_credit'
  /** The provider transcribed the audio and found no words in it: silence,
   *  room noise, a button pressed and released. A fact about the audio rather
   *  than a refusal, so a voice turn can say "nothing heard" instead of an
   *  error, and still never store an empty message (#941). */
  | 'speech_nothing_heard'
  /** The request could not be built: empty text, a mime type the provider does
   *  not accept, an unknown voice id. Caught before any network call. */
  | 'speech_bad_request';

/**
 * Every failure of this package carries vendor words (an error body, a
 * refusal message), and those words reach people: the turn's spoken failure,
 * the refusal at Save, the sample, `generate_speech`, the logs. A vendor can
 * echo the credential it refused ("Incorrect API key provided: sk-or-v1-…",
 * "API key not valid: AIza…"). So the message is masked HERE, where the words
 * enter Nodal, once for every adapter and every consumer: an adapter cannot
 * forget it, because no SpeechError exists unmasked (review of #972, pass 2).
 */
export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  /** The vendor's HTTP status, when there was one. */
  readonly status?: number;

  constructor(code: SpeechErrorCode, message: string, status?: number) {
    super(redactSecretsInText(message));
    this.name = 'SpeechError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * The code of a vendor's non-OK HTTP answer. One mapping for every adapter, so
 * "no credit" reads the same whichever vendor said it.
 */
export function vendorRefusalCode(status: number): SpeechErrorCode {
  return status === 402 ? 'speech_no_credit' : 'speech_provider_error';
}
