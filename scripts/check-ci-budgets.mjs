#!/usr/bin/env node
// check-ci-budgets.mjs — `pnpm ci:budgets` : les bornes de temps de la CI tiennent-elles ? (#517)
//
// Les règles et leur pourquoi sont dans scripts/lib/ci-budgets.mjs. Sortie 1 en
// nommant chaque job et chaque étape en défaut ; sortie 0 sinon.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifierWorkflow } from './lib/ci-budgets.mjs';

const dossier = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const fichiers = readdirSync(dossier).filter((f) => /\.ya?ml$/.test(f));
const constats = fichiers.flatMap((f) =>
  verifierWorkflow(f, readFileSync(join(dossier, f), 'utf8')),
);

if (constats.length > 0) {
  for (const c of constats) console.error(`✗ ${c}`);
  console.error(
    `\n${constats.length} CI budget problem(s). Bound every run step (timeout-minutes, from its measured duration) and keep each job's bound ≥ the sum of its steps + 5 min.`,
  );
  process.exit(1);
}
console.log(`✔ CI budgets hold in ${fichiers.length} workflows.`);
