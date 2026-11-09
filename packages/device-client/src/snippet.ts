// snippet.ts — the "connect in 20 lines" example, written ONCE (#950).
//
// The "Connect a device" docs page shows it with the same-machine address, and
// Settings → Devices can show it with the address that works for the owner's
// install: both read this function, so the two cannot drift
// (apps/docs/src/tests/connect-a-device.test.ts compares the page to it).
//
// Not part of the built client file: a device needs the client, not its example.

/** The example, for a Nodal reachable at `nodalUrl`. */
export function connectSnippet(nodalUrl: string): string {
  return `import { pair, connect } from './nodal-device.mjs';

const url = '${nodalUrl}';
const pairing = await pair(url, {
  name: 'Living room speaker',
  capabilities: ['microphone', 'speaker'],
});
console.log(\`Pairing code: \${pairing.userCode}\`); // show it, or say it
const session = await pairing.done(); // keep it to reconnect later

const nodal = connect(url, session);
nodal.on('speech', (s) => s.type === 'audio' && play(s.audio, s.mimeType, s.sampleRate));
nodal.on('bubble', (b) => console.log(b.text));
nodal.on('card', async (card) => {
  console.log(card.text);
  await nodal.answer(card.cardId, card.choices[0]); // or let the person choose
});
nodal.on('closed', ({ error }) => console.error(error.message));

const turn = await nodal.say(recordedWav, 'audio/wav'); // push-to-talk released
console.log(turn.transcript, '→', turn.reply);
await nodal.send('And tomorrow?'); // a typed turn
`;
}
