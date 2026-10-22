#!/usr/bin/env node
// install-playwright.mjs — installe Chromium pour les parcours e2e de la CI.
// Utilisé par `ci.yml` (e2e-smoke) et `qa.yml`, qui avaient chacun la même
// boucle `timeout 300 playwright install --with-deps` (#852).
//
//   node scripts/install-playwright.mjs
//
// Le déroulé :
//   1. le navigateur (`playwright install chromium`) : un téléchargement chez
//      Playwright, pas chez Ubuntu ; le workflow met `~/.cache/ms-playwright` en
//      cache, clé = la version exacte de Playwright, donc un cache chaud ne
//      télécharge rien ;
//   2. la SONDE des dépendances système (`install-deps --dry-run`, locale, sans
//      réseau) puis `dpkg-query` : seuls les paquets réellement absents comptent ;
//   3. si aucun ne manque, apt n'est jamais lancé. Sinon : `update`, `install
//      --download-only` (le réseau, bornée, réessayée), puis `install` depuis le
//      cache local (court, jamais coupé en plein dpkg) ;
//   4. une dernière vérification : les paquets sont là, ou c'est un échec.
//
// Sortie 0 : Chromium et ses dépendances sont en place. Sortie 1 : l'installation
// a échoué — l'annotation dit « browser install failed », jamais un test rouge.
// Linux seulement : c'est un script de runner.

import { spawn } from 'node:child_process';
import {
  OPTIONS_APT,
  avecReessais,
  decrire,
  lancerBornee,
  paquetsDeLaSonde,
  vraimentManquants,
  EchecInstallation,
} from './lib/install-playwright.mjs';

if (process.platform !== 'linux') {
  console.error(
    'install-playwright: Linux only (a CI runner script). On a workstation: pnpm --filter @nodal-agents/web exec playwright install chromium',
  );
  process.exit(2);
}

// Un multiplicateur des bornes, pour que le test rejoue une panne en secondes et
// non en minutes. Absent, il vaut 1 ; un workflow n'y touche jamais.
const FACTEUR = Number(process.env.INSTALL_PLAYWRIGHT_BORNE_FACTEUR ?? '1');
if (!Number.isFinite(FACTEUR) || FACTEUR <= 0) {
  console.error(
    `install-playwright: INSTALL_PLAYWRIGHT_BORNE_FACTEUR must be a positive number, got "${process.env.INSTALL_PLAYWRIGHT_BORNE_FACTEUR}"`,
  );
  process.exit(2);
}
const bornee = (secondes) => secondes * FACTEUR;

const PNPM_PLAYWRIGHT = ['--filter', '@nodal-agents/web', 'exec', 'playwright'];
const NAVIGATEURS = ['chromium', 'chromium-headless-shell'];
const root = process.getuid?.() === 0;
// Root n'a pas besoin de sudo. `env` repasse le mode non interactif à travers sudo.
const SUDO = root ? [] : ['sudo', '-n'];
const PREFIXE_APT = [...SUDO, 'env', 'DEBIAN_FRONTEND=noninteractive'];

const journal = (m) => console.log(`[install-playwright] ${m}`);
const groupe = (titre) => console.log(`::group::${titre}`);
const finGroupe = () => console.log('::endgroup::');

/** Lance une commande courte et rend {code, stdout}. La sortie est aussi imprimée. */
function capturer(commande, args) {
  return new Promise((resolve, reject) => {
    const enfant = spawn(commande, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    enfant.stdout.on('data', (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    enfant.on('error', reject);
    enfant.on('exit', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** Les processus apt/dpkg encore vivants (les nôtres orphelins, ou ceux d'un tiers). */
async function processusApt() {
  const lignes = [];
  for (const args of [
    ['-a', '-x', 'apt-get|apt|dpkg'],
    ['-a', '-f', '^/usr/lib/apt/methods/'],
  ]) {
    const r = await new Promise((resolve) => {
      const e = spawn('pgrep', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      e.stdout.on('data', (d) => (out += d));
      e.on('error', () => resolve({ out: '', absent: true }));
      e.on('exit', () => resolve({ out }));
    });
    if (r.absent) throw new Error('pgrep is not available: cannot check the dpkg lock holders');
    lignes.push(...r.out.split('\n').filter(Boolean));
  }
  return lignes;
}

/** Entre deux tentatives apt : plus aucun apt/dpkg ne doit tourner, et on le dit. */
async function verrouLibreAvantReessai(n) {
  const vivants = await processusApt();
  if (vivants.length === 0) {
    journal(`dpkg lock check after attempt ${n}: no apt/dpkg process left, the lock is free`);
  } else {
    journal(
      `dpkg lock check after attempt ${n}: still running (DPkg::Lock::Timeout will wait for it):\n${vivants.join('\n')}`,
    );
  }
}

/**
 * La réparation entre deux tentatives d'installation. Un échec ici est journalisé,
 * pas jeté : c'est la tentative suivante (puis la preuve finale) qui décide, et
 * elle échoue haut et fort si dpkg est resté en vrac.
 */
async function reparerDpkg() {
  for (const [nom, commande, args] of [
    ['dpkg --configure -a', 'dpkg', ['--configure', '-a']],
    ['apt-get install -f', 'apt-get', [...OPTIONS_APT, 'install', '-f', '-y']],
  ]) {
    const code = await lancerBornee({
      prefixe: PREFIXE_APT,
      secondes: bornee(60),
      commande,
      args,
    });
    journal(`repair between attempts: ${nom} ${code === 0 ? 'ok' : `failed (${decrire(code)})`}`);
  }
}

async function paquetsAbsents() {
  // La sonde sort en 1 quand des paquets manquent : pnpm imprime alors une
  // erreur « ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL » qui est ATTENDUE, pas une panne.
  journal('probing system dependencies (a non-zero exit below means "some are missing")');
  const sonde = await capturer('timeout', [
    '--kill-after=10',
    String(bornee(60)),
    'pnpm',
    ...PNPM_PLAYWRIGHT,
    'install-deps',
    '--dry-run',
    ...NAVIGATEURS,
  ]);
  const listes = paquetsDeLaSonde(sonde.stdout);
  if (listes === null) {
    throw new Error(
      `the dependency probe (playwright install-deps --dry-run) answered neither "all installed" nor a package list (exit ${sonde.code})`,
    );
  }
  if (listes.length === 0) return [];
  const dpkg = await capturer('dpkg-query', [
    '-W',
    '-f=${binary:Package} ${db:Status-Status}\\n',
    ...listes,
  ]);
  // dpkg-query sort 1 si un paquet est inconnu : ce n'est pas une panne, c'est
  // un paquet absent — il n'apparaît simplement pas dans la sortie.
  return vraimentManquants(listes, dpkg.stdout);
}

async function installer() {
  // 1. Le navigateur. Réseau Playwright, pas Ubuntu : réessayé, borné.
  groupe('Chromium download');
  await avecReessais({
    phase: 'browser download',
    tentatives: 3,
    journal,
    essai: () =>
      lancerBornee({
        secondes: bornee(60),
        commande: 'pnpm',
        args: [...PNPM_PLAYWRIGHT, 'install', 'chromium'],
      }),
    entre: async () => {},
  });
  finGroupe();

  // 2-3. Les dépendances système, seulement celles qui manquent.
  groupe('System dependencies');
  const absents = await paquetsAbsents();
  if (absents.length === 0) {
    journal('every system dependency is already installed: apt is not used');
    finGroupe();
    return;
  }
  journal(`${absents.length} system package(s) missing: ${absents.join(' ')}`);

  const apt = (nom, secondes, tentatives, args, entre = verrouLibreAvantReessai) =>
    avecReessais({
      phase: nom,
      tentatives,
      journal,
      essai: () =>
        lancerBornee({
          prefixe: PREFIXE_APT,
          secondes: bornee(secondes),
          commande: 'apt-get',
          args: [...OPTIONS_APT, ...args],
        }),
      entre,
    });
  await apt('apt-get update', 45, 3, ['update']);
  // Le réseau d'abord, seul : une coupure ici ne laisse AUCUN paquet à moitié
  // configuré. L'installation qui suit lit le cache local.
  await apt('apt-get download', 90, 3, [
    'install',
    '-y',
    '--no-install-recommends',
    '--download-only',
    ...absents,
  ]);
  // Hors réseau (les .deb sont dans le cache local : ~3 s mesurées pour 9 polices),
  // mais c'est la seule phase qui MODIFIE dpkg. Une coupure (borne, verrou tenu par
  // un tiers plus longtemps que DPkg::Lock::Timeout) peut la laisser à moitié faite :
  // même échelle de tentatives que les autres, et entre deux, la réparation
  // idempotente standard (`dpkg --configure -a`, `apt-get install -f`) avant de
  // relancer.
  await apt(
    'apt-get install',
    60,
    3,
    ['install', '-y', '--no-install-recommends', ...absents],
    async (n) => {
      await verrouLibreAvantReessai(n);
      await reparerDpkg();
    },
  );
  finGroupe();

  // 4. La preuve : ces paquets sont là.
  const restants = await paquetsAbsents();
  if (restants.length > 0) {
    throw new Error(`system packages still missing after the install: ${restants.join(' ')}`);
  }
  journal('system dependencies verified');
}

try {
  await installer();
  journal('Chromium and its system dependencies are in place');
} catch (e) {
  finGroupe();
  const detail =
    e instanceof EchecInstallation ? e.message : `browser install failed: ${e.message}`;
  console.log(`::error title=Playwright browser install failed::${detail}`);
  console.error(`install-playwright: ${detail}`);
  console.error(
    'This is an INSTALL failure (browser or system packages), not a test failure: no test was run.',
  );
  process.exit(1);
}
