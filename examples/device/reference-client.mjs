// reference-client.mjs: a device connected to Nodal, with the built client file.
//
//   node examples/device/reference-client.mjs <nodal address> <question.wav> [reply-audio-file]
//
// It pairs (prints the code to confirm in Settings → Devices), says one
// recorded WAV file as a spoken turn, writes the reply's voice to a file, and
// answers the first card it receives with its first choice. The session is
// kept in nodal-session.json: a second run reconnects without pairing again.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, pair } from '../../packages/device-client/dist/nodal-device.mjs';

const [url, wavPath, outPath = 'reply.audio'] = process.argv.slice(2);
const sessionFile = process.env.NODAL_SESSION_FILE ?? 'nodal-session.json';

let session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : null;
if (!session) {
  const pairing = await pair(url, {
    name: 'Reference client',
    capabilities: ['microphone', 'speaker'],
  });
  console.log(`Pairing code: ${pairing.userCode}`);
  session = await pairing.done();
  writeFileSync(sessionFile, JSON.stringify(session));
}

const nodal = connect(url, session);
const voice = [];
nodal.on('speech', (s) => s.type === 'audio' && s.origin.kind === 'turn' && voice.push(s.audio));
nodal.on(
  'closed',
  ({ error }) => error.code !== 'closed' && (console.error(error.message), process.exit(1)),
);
let answered = false;
nodal.on('card', async (card) => {
  if (answered) return;
  answered = true;
  console.log(`Card: ${card.text} → ${card.choices[0].label}`);
  await nodal.answer(card.cardId, card.choices[0]);
});

const turn = await nodal.say(readFileSync(wavPath), 'audio/wav');
console.log(`Heard: ${turn.transcript}\nReply: ${turn.reply}`);
writeFileSync(outPath, Buffer.concat(voice));

// A task the agent launched ends on this device: wait for it, then leave.
if (turn.spawnedJobId) {
  await new Promise((resolve) =>
    nodal.on('state', (s) => s.jobId === turn.spawnedJobId && s.state !== 'waiting' && resolve(s)),
  ).then((s) => console.log(`Job: ${s.state}`));
}
nodal.close();
