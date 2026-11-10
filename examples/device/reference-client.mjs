// reference-client.mjs: a device connected to Nodal, with the built client file.
//
//   node examples/device/reference-client.mjs <nodal address> <question.wav> [reply-audio-file] [choice]
//
// It pairs (prints the code to confirm in Settings → Devices), says one
// recorded WAV file as a spoken turn, writes the reply's voice to a file, and
// prints the first card it receives. It answers that card only with the choice
// the person gave on the command line (a label of the card); without one, or
// with a label the card does not offer, the card is left for the dashboard.
// The session is kept in nodal-session.json: a second run reconnects without
// pairing again.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, pair } from '../../packages/device-client/dist/nodal-device.mjs';

const [url, wavPath, outPath = 'reply.audio', chosen] = process.argv.slice(2);
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
  console.log(`Card: ${card.text}
Choices: ${card.choices.map((c) => c.label).join(' / ')}`);
  const choice = card.choices.find((c) => c.label === chosen);
  if (!choice) return console.log('Not answered: answer it from the dashboard.');
  console.log(`Answered: ${choice.label}`);
  await nodal.answer(card.cardId, choice);
});

const turn = await nodal.say(readFileSync(wavPath), 'audio/wav');
console.log(`Heard: ${turn.transcript}\nReply: ${turn.reply}`);
writeFileSync(outPath, Buffer.concat(voice));

// A task the agent launched ends on this device: wait for its end, then leave.
const ENDS = ['done', 'cancelled', 'failed'];
if (turn.spawnedJobId) {
  const end = await new Promise((resolve) =>
    nodal.on('state', (s) => s.jobId === turn.spawnedJobId && ENDS.includes(s.state) && resolve(s)),
  );
  console.log(`Job: ${end.state}`);
}
nodal.close();
