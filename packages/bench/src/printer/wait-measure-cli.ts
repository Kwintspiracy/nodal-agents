// printer/wait-measure-cli.ts — `tsx src/printer/wait-measure-cli.ts base=<dir> head=<dir> [--out <fichier>]`
//
// Mesure (#1071) les essais `print` des campagnes données (leurs dossiers de
// preuves), les compare, et écrit le tout en JSON. Les critères de la tête :
// au moins 4 essais sur 5 qui suivent le travail avec une attente, et aucun qui
// dise « imprimé » avant que le travail soit terminé. Aucun modèle n'est appelé.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { measureCampaign, summarise, type WaitRun } from './wait-measure';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt === -1 ? null : resolve(args[outAt + 1]!);
const sets = args
  .filter((a, i) => a.includes('=') && (outAt === -1 || i !== outAt + 1))
  .map((a) => {
    const [label, dir] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
    return { label, dir: resolve(dir) };
  });
if (sets.length === 0) {
  console.error(
    'usage: wait-measure-cli.ts base=<campaign evidence dir> head=<dir> [--out <file>]',
  );
  process.exit(2);
}

const line = (r: WaitRun): string =>
  [
    r.trial.padEnd(10),
    `waited ${r.waited ? `yes (${r.waits.join('s, ')}s)` : 'no'}`.padEnd(22),
    `state at answer ${r.stateAtAnswer ?? '-'}`.padEnd(28),
    `says printed ${r.saysPrinted ? (r.saysPrintedTooEarly ? 'YES, TOO EARLY' : 'yes') : 'no'}`,
    r.problems.length > 0 ? `  [${r.problems.join('; ')}]` : '',
  ].join('  ');

const report = sets.map(({ label, dir }) => {
  const runs = measureCampaign(dir, 'print');
  const verdict = summarise(runs);
  console.log(`\n== ${label} (${dir})`);
  for (const r of runs) {
    console.log(line(r));
    console.log(`   answer: ${(r.answer ?? '(none)').replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  console.log(
    `-> ${verdict.waited}/${verdict.runs} waited, ${verdict.saysPrintedTooEarly}/${verdict.runs} said printed before completed, ${verdict.unjudged} not judgeable`,
  );
  return { label, dir, verdict, runs };
});

const head = report.find((r) => r.label === 'head');
if (head) {
  const ok =
    head.verdict.unjudged === 0 &&
    head.verdict.waited >= Math.ceil((head.verdict.runs * 4) / 5) &&
    head.verdict.saysPrintedTooEarly === 0;
  console.log(
    `\nHead criteria (>= 4/5 waited, 0 said printed too early, every run judgeable): ${ok ? 'MET' : 'NOT MET'}`,
  );
  console.log('"says printed" is read by pattern: read each answer above before concluding.');
}
if (out) {
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nWritten: ${out}`);
}
