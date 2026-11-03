/**
 * Every failure in this package is one of these codes. Deliberately narrow: a
 * caller has to be able to tell "the vendor said no" (retry, or tell the user
 * their key is out of credit) from "you asked for something impossible"
 * (a programming error) without parsing prose.
 */
export type SpeechErrorCode =
  /** No adapter registered for the requested provider. Config/programming error. */
  | 'speech_provider_not_found'
  /** The provider answered, but not with audio/text — quota, bad key, refusal. */
  | 'speech_provider_error'
  /** The request could not be built: empty text, a mime type the provider does
   *  not accept, an unknown voice id. Caught before any network call. */
  | 'speech_bad_request';

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  /** The vendor's HTTP status, when there was one. */
  readonly status?: number;

  constructor(code: SpeechErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
