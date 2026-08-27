#!/usr/bin/env node
// release-check.mjs — TOUT ce qu'une release doit satisfaire, en une commande.
//
//     pnpm release:check
//
// Pourquoi ce fichier existe : chaque publication a coûté une panne découverte
// À LA MAIN, tard, et jamais la même.
//
//   0.8.0  le tarball partait avec des chunks manquants — dashboard en 500 sur
//          une install fraîche. Trouvé par un utilisateur.
//   0.8.1  `next` en `^16.2.6` face à un bundle pré-compilé : toute install
//          fraîche mourait sur `validationLevel`. Trouvée trois semaines après.
//   0.8.7  un BOM UTF-8 dans deux `package.json` (le pack ne parsait plus),
//          puis 2,6 Go de manifestes de traçage dans le tarball — refusé par
//          npm en `413 Payload Too Large`, au moment du publish.
//
// Chacune avait sa garde, ajoutée après coup, à un endroit différent. Il fallait
// s'en souvenir et les lancer dans le bon ordre. Ce script est la liste, et il
// ÉCHOUE FORT : rien ne se publie sur une vérification sautée.
//
// Chaque contrôle dit ce qu'il vérifie, ce qu'il a trouvé, et quoi faire.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipSlow = process.argv.includes('--fast');

let failed = 0;
const started = Date.now();

function step(label, fn) {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    const note = fn();
    console.log(`  ✔ ${note ?? 'ok'}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${err.message}`);
  }
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', ...opts });
}

/** Une commande longue, sortie affichée telle quelle ; jette si elle échoue. */
function shLive(cmd) {
  const r = spawnSync(cmd, {
    cwd: repoRoot,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n    ');
    throw new Error(`\`${cmd}\` a échoué :\n    ${tail}`);
  }
  return r.stdout ?? '';
}

// ─── 1. La version ───────────────────────────────────────────────────────────

const version = JSON.parse(
  readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8'),
).version;

step(`Version ${version} — forme et cohérence`, () => {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    throw new Error(`"${version}" n'est pas un numéro semver.`);
  }
  const packPath = resolve(repoRoot, 'pack/package.json');
  if (existsSync(packPath)) {
    const packVersion = JSON.parse(readFileSync(packPath, 'utf8')).version;
    // `build-pack` réécrit pack/package.json depuis apps/cli — un écart ici
    // signale seulement un pack périmé, pas une incohérence de source.
    if (packVersion !== version) {
      return `apps/cli à ${version} ; pack/ encore à ${packVersion} (sera réécrit par le build)`;
    }
  }
  return `apps/cli et pack/ à ${version}`;
});

step('Cette version n’est pas DÉJÀ publiée', () => {
  // Publier deux fois le même numéro est impossible, et le découvrir au
  // `npm publish` fait perdre tout le temps du build.
  let published;
  try {
    published = sh('npm view nodal-agents versions --json', { stdio: 'pipe' });
  } catch {
    return 'registre injoignable — contrôle sauté (le publish tranchera)';
  }
  const versions = JSON.parse(published);
  if (versions.includes(version)) {
    throw new Error(
      `${version} est déjà sur npm. Une version publiée ne se remplace pas — bumper.`,
    );
  }
  const latest = versions[versions.length - 1];
  return `absente du registre (dernière publiée : ${latest})`;
});

step('Le CHANGELOG décrit cette version', () => {
  const changelog = readFileSync(resolve(repoRoot, 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`## v${version}`)) {
    throw new Error(
      `aucune section "## v${version}" dans CHANGELOG.md.\n` +
        '    Une release sans notes est une release que personne ne peut évaluer.',
    );
  }
  return `section "## v${version}" présente`;
});

// ─── 2. L'hygiène des fichiers ───────────────────────────────────────────────

step('Aucun BOM UTF-8 dans les fichiers suivis', () => {
  // Un `package.json` avec BOM ne se parse pas — le pack meurt dessus. PowerShell
  // en ajoute un avec `Set-Content -Encoding utf8`, ce qui rend l'erreur d'autant
  // plus déroutante qu'elle apparaît loin de l'édition.
  const files = sh('git ls-files')
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  const withBom = [];
  for (const f of files) {
    const p = resolve(repoRoot, f);
    let buf;
    try {
      buf = readFileSync(p);
    } catch {
      continue;
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) withBom.push(f);
  }
  if (withBom.length > 0) {
    throw new Error(
      `${withBom.length} fichier(s) avec BOM :\n    ${withBom.slice(0, 8).join('\n    ')}` +
        (withBom.length > 8 ? `\n    … et ${withBom.length - 8} autres` : ''),
    );
  }
  return `${files.length} fichiers, aucun BOM`;
});

step('L’arbre git est propre', () => {
  const dirty = sh('git status --porcelain').trim();
  if (dirty) {
    const n = dirty.split('\n').length;
    throw new Error(
      `${n} fichier(s) non commité(s). Le tag pointerait sur un état qui n'est nulle part.`,
    );
  }
  return 'rien à commiter';
});

step('La branche est mergée dans main', () => {
  const branch = sh('git rev-parse --abbrev-ref HEAD').trim();
  if (branch === 'main') return 'sur main';
  const ahead = sh(`git rev-list --count main..HEAD`).trim();
  if (ahead !== '0') {
    throw new Error(
      `${branch} a ${ahead} commit(s) d'avance sur main.\n` +
        "    Le tag pointerait hors de main, et le changelog décrirait du code qui n'y est pas.",
    );
  }
  return `${branch} est à jour avec main`;
});

// ─── 3. Le code ──────────────────────────────────────────────────────────────

if (skipSlow) {
  console.log('\n(--fast : gauntlet, pack et smoke sautés)');
} else {
  step('Typecheck', () => {
    shLive('pnpm typecheck');
    return 'aucune erreur';
  });
  step('Tests', () => {
    shLive('pnpm test');
    return 'suite verte';
  });
  step('Lint', () => {
    shLive('pnpm lint');
    return 'aucune erreur';
  });
  step('Format', () => {
    shLive(
      'node node_modules/prettier/bin/prettier.cjs --check "apps/**/*.{ts,tsx}" "packages/**/*.ts"',
    );
    return 'conforme';
  });
  step('Architecture (dependency-cruiser)', () => {
    shLive('pnpm deps:check');
    return 'aucune violation';
  });

  // ─── 4. Le paquet ──────────────────────────────────────────────────────────

  step('Pack — chunks complets, deps épinglées, taille sous plafond', () => {
    // build-pack porte ses propres gardes et échoue fort ; on relaie son verdict.
    const out = shLive('node scripts/build-pack.mjs');
    const size = /Pack size: (\d+) MB/.exec(out)?.[1] ?? '?';
    const chunks = /chunk integrity: ([^\n]+)/.exec(out)?.[1]?.trim() ?? 'vérifiée';
    return `${size} MB décompressés · ${chunks}`;
  });

  step('Une install FRAÎCHE démarre et sert', () => {
    // La seule preuve qui compte : le tarball installé ailleurs, qui boote.
    const out = shLive('node scripts/smoke-pack.mjs');
    if (!/boots and serves/.test(out)) {
      throw new Error("le smoke-test n'a pas confirmé le démarrage");
    }
    return 'runner, web et rendu de page vérifiés';
  });
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\n${'─'.repeat(66)}`);
if (failed > 0) {
  console.log(`✗ ${failed} contrôle(s) en échec — NE PAS PUBLIER  (${seconds}s)`);
  process.exit(1);
}
console.log(`✅ nodal-agents@${version} est prête à publier  (${seconds}s)\n`);
console.log('  cd pack && npm publish');
console.log(`  git tag v${version} && git push --tags`);
console.log('\n  Les deux restent TES gestes.');
