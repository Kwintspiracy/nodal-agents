import 'server-only';
import { eq, and, entityLlmKeys } from '@nodal-agents/db';
import { getDb } from '@/lib/server.ts';
import { decrypt } from '@nodal-agents/secrets';
import {
  SpeechError,
  getTranscriptionAdapter,
  type AudioMimeType,
  type SpeechProvider,
} from '@nodal-agents/speech';
import { guardVoiceRequest, isGuardFailure } from '../_guard.ts';

/**
 * POST /api/voice/transcribe — audio in, text out.
 *
 * The body is the raw audio, with its container in `Content-Type`. No multipart
 * wrapper: there is exactly one field, and base64 in JSON would inflate every
 * recording by a third for nothing.
 */

/** Twenty megabytes. A push-to-talk turn is seconds long — Opus at 24 kbps puts
 *  a full minute under 200 kB — so this is not a product limit, it is the point
 *  past which someone is uploading a film to be transcribed on this key. Checked
 *  against Content-Length AND against what actually arrives, because the header
 *  is a claim. */
const MAX_BYTES = 20 * 1024 * 1024;

/** The provider is fixed rather than taken from the request. Letting the client
 *  choose would let a page pick whichever vendor has a key configured. */
const PROVIDER: SpeechProvider = 'google';

export async function POST(req: Request): Promise<Response> {
  const guard = await guardVoiceRequest(req);
  if (isGuardFailure(guard)) return guard.response;

  const adapter = getTranscriptionAdapter(PROVIDER);

  // `audio/webm;codecs=opus` is what a Chrome MediaRecorder emits; the
  // parameters are stripped so the container is matched, not the codec string.
  const mimeType = (req.headers.get('content-type') ?? '').split(';')[0]?.trim() as AudioMimeType;
  if (!adapter.capabilities.accepts.includes(mimeType)) {
    return Response.json(
      {
        error: 'unsupported_audio_type',
        got: mimeType || null,
        // The client uses this to pick a recording format it can actually send,
        // instead of discovering the rejection after the user has spoken.
        accepts: adapter.capabilities.accepts,
      },
      { status: 415 },
    );
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) {
    return Response.json({ error: 'audio_too_large', maxBytes: MAX_BYTES }, { status: 413 });
  }

  const audio = new Uint8Array(await req.arrayBuffer());
  if (audio.length === 0) {
    return Response.json({ error: 'empty_audio' }, { status: 400 });
  }
  // The header was a claim; this is the measurement.
  if (audio.length > MAX_BYTES) {
    return Response.json({ error: 'audio_too_large', maxBytes: MAX_BYTES }, { status: 413 });
  }

  const db = getDb();
  const [key] = await db
    .select({ apiKey: entityLlmKeys.apiKey })
    .from(entityLlmKeys)
    .where(
      and(
        eq(entityLlmKeys.entityId, guard.entityId),
        eq(entityLlmKeys.provider, PROVIDER),
        eq(entityLlmKeys.isActive, true),
      ),
    )
    .limit(1);

  if (!key?.apiKey) {
    // Fail loud and NAME the provider: "voice does not work" is unactionable,
    // "add a google key" is a click away.
    return Response.json({ error: 'no_key_for_provider', provider: PROVIDER }, { status: 409 });
  }

  const language = req.headers.get('x-nodal-language') ?? undefined;

  try {
    const result = await adapter.transcribe(
      language ? { audio, mimeType, language } : { audio, mimeType },
      decrypt(key.apiKey),
    );
    return Response.json({ text: result.text, latencyMs: result.latencyMs });
  } catch (err) {
    if (err instanceof SpeechError) {
      // The vendor's own wording is what separates "your key is out of credit"
      // from "that container is not supported" — never rewritten, never
      // swallowed. `status` distinguishes a caller error from a vendor outage.
      const status = err.code === 'speech_bad_request' ? 400 : 502;
      return Response.json({ error: err.code, message: err.message }, { status });
    }
    console.error('[voice/transcribe]', err);
    return Response.json({ error: 'transcribe_failed' }, { status: 500 });
  }
}
