import { describe, it, expect } from 'vitest';
import { googleSpeechAdapter, googleTranscriptionAdapter } from '../providers/google.ts';

/**
 * The live half. Everything else in this package mocks `fetch` and proves what
 * we PUT on the wire; this one proves the wire works — that the models exist,
 * that the request shape is the one Google actually accepts, and that the audio
 * we emit is audio a transcriber can read back.
 *
 * Skipped without `GOOGLE_API_KEY`, so CI and a clean checkout stay green. Run
 * it deliberately:
 *
 *     GOOGLE_API_KEY=… pnpm --filter @nodal-agents/speech test
 *
 * (on Windows: `$env:GOOGLE_API_KEY='…'` first). Never pass a key as a CLI
 * argument — it lands in the shell history and in every process listing.
 *
 * The round trip is the assertion, and it is deliberately the SIMPLEST possible
 * case: one short French sentence, synthesised, then handed straight back to the
 * transcriber. If the sentence survives that loop, both halves work and they
 * agree on a container. Anything more elaborate would tell us less.
 *
 * KNOWN DEFECT — la queue des énoncés courts (mesuré le 2026-08-11, reproduit
 * 3 fois par cas, pas une observation isolée):
 *
 *   « Quelle heure est-il à Tokyo »  → 1.3 s d'audio, transcrit « Quelle heure
 *                                      est-il ». Trop court pour la phrase: la
 *                                      SYNTHÈSE coupe, la transcription est
 *                                      fidèle à ce qu'elle reçoit.
 *   même phrase + « Merci. »         → 2.4 s, phrase entière, 2 fois sur 2.
 *   « … à Berlin ? »                 → une fois « Bertrand », une fois juste.
 *   « Quelle heure est-il à Tokyo ? » → 200 SANS AUCUN AUDIO, 2 fois sur 2.
 *                                      Déterministe pour cette chaîne précise,
 *                                      pas un aléa réseau.
 *
 * Rien n'est contourné ici. Une rustine du genre « ajouter un mot muet à la fin
 * de chaque énoncé » serait exactement le repli silencieux qu'interdit
 * l'invariant #4, et elle ferait prononcer ce mot. Le défaut est donc consigné,
 * l'adaptateur crie sur un 200 sans audio, et la décision — changer de voix,
 * changer de fournisseur, ou vivre avec — se prendra sur de vraies phrases
 * d'agent, pas sur ce banc.
 *
 * À noter aussi: cette boucle synthèse→transcription N'EST PAS le produit. Le
 * produit, c'est une voix humaine transcrite, et un texte d'agent écouté par une
 * oreille humaine. Le rond-trip cumule les erreurs des deux systèmes; il prouve
 * que la plomberie tient, pas la qualité perçue.
 */
const KEY = process.env['GOOGLE_API_KEY'];
const live = KEY ? describe : describe.skip;

/** Letters only, lowercased — so the comparison survives punctuation and
 *  capitalisation drifting between synthesis and transcription. */
const shape = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

live('google, en vrai', () => {
  const PHRASE = 'Bonjour Quentin, la chaîne audio fonctionne.';

  it(
    'synthesises French, then reads its own audio back word for word',
    { timeout: 120_000 },
    async () => {
      const spoken = await googleSpeechAdapter.synthesize(
        { text: PHRASE, voiceId: 'Kore', language: 'fr-FR' },
        KEY!,
      );

      // A real answer, not an empty 200 dressed as success.
      expect(spoken.mimeType).toBe('audio/wav');
      expect(spoken.audio.length).toBeGreaterThan(10_000);
      expect(String.fromCharCode(...spoken.audio.slice(0, 4))).toBe('RIFF');
      // The header must describe the payload, or players truncate it.
      const declared = new DataView(spoken.audio.buffer).getUint32(40, true);
      expect(declared).toBe(spoken.audio.length - 44);

      const heard = await googleTranscriptionAdapter.transcribe(
        { audio: spoken.audio, mimeType: 'audio/wav', language: 'fr-FR' },
        KEY!,
      );

      expect(shape(heard.text)).toBe(shape(PHRASE));

      // Latency is this feature's product risk, so it is printed rather than
      // asserted: a threshold here would fail on a slow network and tell us
      // nothing, while the number itself is what decides whether continuous
      // conversation is buildable. First measurement, 2026-08-11: 3.7 s to
      // speak, 2.6 s to listen.
      // console.warn rather than console.log: the lint rule allows it, and the
      // number genuinely belongs in the output — a run whose latencies you
      // cannot see tells you the chain works but not whether it is usable.
      console.warn(
        `[live] synthèse ${spoken.latencyMs} ms (${spoken.audio.length} octets) · ` +
          `transcription ${heard.latencyMs} ms`,
      );
    },
  );

  it(
    'transcribes rather than answering, when the audio is a question',
    { timeout: 120_000 },
    async () => {
      // The failure this guards is subtle and would look like a good product:
      // the user asks a question, a helpful model answers, and the chat records
      // the ANSWER as what the user said. Mocked tests can only check the
      // wording of the instruction; only a live model shows it obeys.
      //
      // The assertion is on the OPENING of the sentence, not the whole of it,
      // and that is a deliberate concession to a measured defect — see
      // "la queue des énoncés courts" below. An answer would not start with
      // these words, so the guard still does its job.
      const question = 'Quelle heure est-il à Berlin ? Merci beaucoup.';
      const spoken = await googleSpeechAdapter.synthesize(
        { text: question, voiceId: 'Kore', language: 'fr-FR' },
        KEY!,
      );
      const heard = await googleTranscriptionAdapter.transcribe(
        { audio: spoken.audio, mimeType: 'audio/wav', language: 'fr-FR' },
        KEY!,
      );
      expect(shape(heard.text).startsWith(shape('Quelle heure est-il'))).toBe(true);
    },
  );

  it(
    'reports an unusable key loudly instead of returning silence',
    { timeout: 60_000 },
    async () => {
      await expect(
        googleSpeechAdapter.synthesize({ text: 'test', voiceId: 'Kore' }, 'not-a-real-key'),
      ).rejects.toThrow(/HTTP 4\d\d/);
    },
  );
});
