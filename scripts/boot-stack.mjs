#!/usr/bin/env node
// boot-stack.mjs — démarre la stack de dev depuis les sources et rend la main
// quand le dashboard répond. Utilisé par `ci.yml` (e2e-smoke) et `qa.yml`, qui
// avaient chacun leur boucle d'attente aveugle (#514).
//
//   node scripts/boot-stack.mjs --log <fichier> [--url http://localhost:3000/] [--plafond-min 8]
//
// Sortie 0 : la stack répond et CONTINUE de tourner (les étapes suivantes la
// testent). Sortie 1 : l'adresse était déjà prise, la stack est morte, ou le
// filet est atteint — les dernières lignes du journal sont imprimées, et le
// journal entier reste dans `--log` pour l'artefact.
//
// Le plafond par défaut (8 min) est un FILET sous le délai du CLI : celui-ci
// abandonne après 300 s d'attente de santé (NODALAI_WEB_HEALTH_MS,
// NODALAI_RUNNER_HEALTH_MS) et s'arrête, ce que ce script voit tout de suite.
// Les workflows lui laissent une marge (`timeout-minutes` de l'étape et du job)
// pour qu'il puisse toujours imprimer le journal avant d'être coupé.
//
// Linux et macOS seulement, et c'est dit plutôt que tenté : sous Windows `pnpm`
// est un `.cmd`, que Node ne lance qu'à travers `cmd`, et un `cmd` détaché
// perd la sortie de ses petits-enfants — le journal serait vide et mentirait.
// Les deux workflows tournent sur ubuntu ; sur un poste Windows, la commande
// de CLAUDE.md fait la même chose à la main.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { lancerEtAttendre, finDuJournal } from './lib/boot-stack.mjs';

if (process.platform === 'win32') {
  console.error(
    'boot-stack: not supported on Windows (a detached pnpm.cmd loses its output). Run the dev command from CLAUDE.md instead: pnpm --filter nodal-agents exec tsx src/index.ts --dev',
  );
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    log: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:3000/' },
    'plafond-min': { type: 'string', default: '8' },
  },
});
if (!values.log) {
  console.error('boot-stack: --log <file> is required');
  process.exit(2);
}
const plafondMin = Number(values['plafond-min']);
if (!Number.isFinite(plafondMin) || plafondMin <= 0) {
  console.error(
    `boot-stack: --plafond-min must be a positive number, got "${values['plafond-min']}"`,
  );
  process.exit(2);
}

// La même commande que CLAUDE.md : le CLI, depuis les sources, en mode --dev
// (Postgres embarqué, migrations, runner, web HMR).
const v = await lancerEtAttendre({
  commande: 'pnpm',
  args: ['--filter', 'nodal-agents', 'exec', 'tsx', 'src/index.ts', '--dev'],
  url: values.url,
  journal: values.log,
  plafondMs: plafondMin * 60_000,
});

const secondes = Math.round(v.apresMs / 1000);
if (v.etat === 'prete') {
  console.log(
    `stack up: ${values.url} answered after ${secondes}s (pid ${v.pid}, log ${values.log})`,
  );
  process.exit(0);
}
if (v.etat === 'occupee') {
  console.error(
    `boot-stack: ${values.url} already answers before the stack was started; nothing was launched, so the next steps would test something else`,
  );
  process.exit(1);
}

let journal = '';
try {
  journal = readFileSync(values.log, 'utf8');
} catch (err) {
  journal = `(log unreadable: ${err.code ?? err.message})`;
}
console.error(finDuJournal(journal, 80));
console.error('');
if (v.etat === 'morte') {
  console.error(
    `boot-stack: the stack exited with code ${v.code} after ${secondes}s, before it was ready at ${values.url}`,
  );
} else {
  // Le filet : le CLI vit encore mais ne sert pas. Ce n'est PAS le délai du
  // produit, c'est celui de ce script ; le dire évite de chercher au mauvais endroit.
  console.error(
    `boot-stack: ${values.url} did not answer within this script's ${plafondMin} min cap; the stack (pid ${v.pid}) is still running`,
  );
}
process.exit(1);
