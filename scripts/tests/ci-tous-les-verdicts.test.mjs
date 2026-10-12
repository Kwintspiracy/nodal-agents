// ci-tous-les-verdicts.test.mjs — un premier échec ne cache jamais les autres
// verdicts (issue #698).
//
// Par défaut, turbo ANNULE les tâches restantes dès qu'une échoue. Le run
// 37433850617 l'a montré : `@nodal-agents/db#test` rouge, puis
// « Tasks: 14 successful, 29 total » — quinze paquets dont personne n'a su
// s'ils passaient. `--continue=dependencies-successful` fait tourner toute
// tâche dont les dépendances ont réussi ; le code de sortie reste non nul.
// (`always` lancerait aussi les tests d'un paquet dont le build a échoué : du
// bruit, pas un verdict.)
//
// La garde lit les VRAIS workflows : chaque `run:` qui lance un verdict turbo
// (test, lint, typecheck), directement ou par un script de la racine, doit
// porter le drapeau.
//
// Lancer depuis la racine : pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = join(repoRoot, '.github', 'workflows');
const DRAPEAU = '--continue=dependencies-successful';
const VERDICTS = ['test', 'lint', 'typecheck'];
const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).scripts;

/** La partie turbo d'une commande : ce qui suit ` -- ` va à la tâche, pas à turbo. */
function argsTurbo(commande) {
  return commande.split(' -- ')[0];
}

/** La commande turbo qu'un `run:` lance réellement, ou null s'il ne lance aucun verdict turbo. */
function verdictTurbo(run) {
  const direct = new RegExp(`\\bturbo (?:run )?(?:${VERDICTS.join('|')})\\b`);
  if (direct.test(run)) return argsTurbo(run);
  const parScript = new RegExp(`^pnpm (?:run )?(${VERDICTS.join('|')})(?=\\s|$)`).exec(run);
  if (parScript) {
    const script = scripts[parScript[1]];
    if (!direct.test(script))
      throw new Error(`pnpm ${parScript[1]} ne lance plus turbo : ${script}`);
    return argsTurbo(script);
  }
  return null;
}

/** Chaque `run:` d'une ligne de chaque workflow, avec son fichier. */
function runs() {
  const out = [];
  for (const nom of readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n))) {
    for (const ligne of readFileSync(join(WORKFLOWS, nom), 'utf-8').split(/\r?\n/)) {
      const m = /^\s*(?:-\s*)?run:\s*(.+?)\s*$/.exec(ligne);
      if (m && m[1] !== '|' && m[1] !== '>') out.push({ nom, run: m[1] });
    }
  }
  return out;
}

describe('la CI rend le verdict de chaque tâche, même après un premier échec (#698)', () => {
  const verdicts = runs()
    .map((r) => ({ ...r, turbo: verdictTurbo(r.run) }))
    .filter((r) => r.turbo !== null);

  it('chaque verdict turbo lancé par un workflow porte --continue=dependencies-successful', () => {
    const sans = verdicts
      .filter((r) => !r.turbo.includes(DRAPEAU))
      .map((r) => `${r.nom}: ${r.run}`);
    expect(sans).toEqual([]);
  });

  it('la garde voit bien les runs de test des deux CI (sinon elle ne garde rien)', () => {
    const tests = verdicts.filter((r) => /\btest\b/.test(r.turbo));
    expect(tests.filter((r) => r.nom === 'ci.yml').length).toBe(5);
    expect(tests.filter((r) => r.nom === 'ci-windows.yml').length).toBe(1);
  });
});
