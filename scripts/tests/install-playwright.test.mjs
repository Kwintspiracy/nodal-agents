// install-playwright.test.mjs — l'installation de Chromium en CI ne bute plus sur
// son propre apt-get orphelin (#852).
//
// Le défaut : `timeout 300 playwright install --with-deps` dans une boucle.
// `timeout` tuait `pnpm`, pas l'`apt-get` que Playwright lançait dessous ; celui-ci
// survivait et gardait le verrou dpkg. Les tentatives suivantes échouaient en une
// seconde sur « Could not get lock … held by process N (apt-get) » : trois fois le
// 22/10/2026 (runs 39767924868, 39771651908, 39773781284), toujours sur un miroir
// Azure lent, alors qu'aucun test n'avait tourné.
//
// Ce que ces tests prouvent, sur de vrais processus :
//   - une tentative coupée par sa borne ne laisse AUCUN descendant vivant, donc
//     la suivante obtient le verrou (c'est le défaut lui-même) ;
//   - apt n'est lancé que pour les paquets réellement absents, et jamais quand
//     tout est là (un cache chaud + une image complète = aucun accès au miroir) ;
//   - un échec dit « browser install failed » et sort en 1, il n'est jamais avalé.
// Les parties qui lancent des processus supposent Linux (groupes de processus,
// `timeout` de coreutils) : c'est l'OS des runners, la seule cible du script.

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  paquetsDeLaSonde,
  vraimentManquants,
  commandeBornee,
  avecReessais,
  lancerBornee,
  EchecInstallation,
  OPTIONS_APT,
} from '../lib/install-playwright.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const linux = process.platform === 'linux';
const dossiers = [];
afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'install-pw-'));
  dossiers.push(d);
  return d;
}
function vivant(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('paquetsDeLaSonde', () => {
  it('tout est installé : liste vide', () => {
    expect(paquetsDeLaSonde('All system dependencies are installed.\n')).toEqual([]);
  });

  it('liste les paquets manquants', () => {
    const sortie = 'Missing system dependencies (3):\n  libasound2t64\n  libnss3\n  xvfb\n';
    expect(paquetsDeLaSonde(sortie)).toEqual(['libasound2t64', 'libnss3', 'xvfb']);
  });

  it('ni l’un ni l’autre : null, la sonde elle-même a échoué (jamais « rien ne manque »)', () => {
    expect(paquetsDeLaSonde('E: Unable to locate package libnss3\n')).toBeNull();
    expect(paquetsDeLaSonde('')).toBeNull();
  });
});

describe('vraimentManquants', () => {
  it('ne garde que les paquets absents : une mise à jour en attente n’est pas un manque', () => {
    const dpkg = 'libnss3:amd64 installed\nlibasound2t64:amd64 installed\n';
    expect(vraimentManquants(['libnss3', 'libasound2t64', 'xvfb'], dpkg)).toEqual(['xvfb']);
  });

  it('un paquet seulement « config-files » ou « not-installed » manque', () => {
    const dpkg = 'libfoo:amd64 config-files\nlibbar:amd64 not-installed\nlibok:amd64 installed\n';
    expect(vraimentManquants(['libfoo', 'libbar', 'libok'], dpkg)).toEqual(['libfoo', 'libbar']);
  });

  it('sortie vide de dpkg-query (aucun paquet connu) : tout manque', () => {
    expect(vraimentManquants(['a', 'b'], '')).toEqual(['a', 'b']);
  });
});

describe('commandeBornee', () => {
  it('le préfixe sudo passe AVANT timeout : celui qui tue est root, comme apt-get', () => {
    expect(
      commandeBornee({
        prefixe: ['sudo', '-n'],
        secondes: 90,
        commande: 'apt-get',
        args: ['update'],
      }),
    ).toEqual(['sudo', '-n', 'timeout', '--kill-after=15', '90', 'apt-get', 'update']);
  });
});

describe('OPTIONS_APT', () => {
  it('borne le réseau d’apt et attend le verrou au lieu d’échouer dessus', () => {
    const ligne = OPTIONS_APT.join(' ');
    expect(ligne).toContain('Acquire::Retries=3');
    expect(ligne).toContain('Acquire::http::Timeout=20');
    expect(ligne).toContain('Acquire::https::Timeout=20');
    expect(ligne).toContain('DPkg::Lock::Timeout=60');
  });
});

describe('avecReessais', () => {
  it('rend le numéro de la tentative qui réussit, et laisse passer entre-temps la vérification du verrou', async () => {
    const codes = [124, 100, 0];
    const entre = [];
    const vues = [];
    const n = await avecReessais({
      phase: 'p',
      tentatives: 3,
      journal: (m) => vues.push(m),
      essai: async (i) => codes[i - 1],
      entre: async (i) => entre.push(i),
    });
    expect(n).toBe(3);
    expect(entre).toEqual([1, 2]);
    expect(vues).toEqual([
      'p: attempt 1/3 failed (cut off by its 124 time bound)',
      'p: attempt 2/3 failed (exit code 100)',
    ]);
  });

  it('toutes les tentatives échouent : EchecInstallation qui nomme la phase et le dernier code', async () => {
    await expect(
      avecReessais({
        phase: 'apt-get download',
        tentatives: 2,
        journal: () => {},
        essai: async () => 100,
        entre: async () => {},
      }),
    ).rejects.toThrowError(new EchecInstallation('apt-get download', 2, 100));
    const e = new EchecInstallation('apt-get download', 2, 100);
    expect(e.message).toBe(
      'browser install failed in phase "apt-get download": 2 attempt(s), last one exit code 100',
    );
  });
});

// Le défaut lui-même : un "apt-get" dont le travail survit à la mort de son
// parent et tient le "verrou" (un fichier pid : tant que ce processus vit, toute
// autre tentative sort en 100, comme dpkg).
describe.skipIf(!linux)('lancerBornee — une tentative coupée ne laisse rien derrière', () => {
  function fauxApt(dir) {
    const script = join(dir, 'fake-apt');
    writeFileSync(
      script,
      `#!/bin/sh
STATE="${dir}"
if [ -e "$STATE/worker" ] && kill -0 "$(cat "$STATE/worker")" 2>/dev/null; then
  echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process $(cat "$STATE/worker") (apt-get)"
  exit 100
fi
if [ ! -e "$STATE/hung" ]; then
  touch "$STATE/hung"
  sleep 120 &
  echo $! > "$STATE/worker"
  wait
  exit 1
fi
echo ok > "$STATE/done"
`,
    );
    chmodSync(script, 0o755);
    return script;
  }

  it('la tentative 2 obtient le verrou parce que le travail de la tentative 1 est MORT', async () => {
    const dir = tmp();
    const script = fauxApt(dir);
    const vues = [];
    const n = await avecReessais({
      phase: 'fake apt',
      tentatives: 3,
      journal: (m) => vues.push(m),
      essai: () => lancerBornee({ secondes: 1, graceSecondes: 2, commande: script, args: [] }),
      entre: async () => {},
    });
    expect(n).toBe(2);
    expect(readFileSync(join(dir, 'done'), 'utf8')).toBe('ok\n');
    // Le descendant qui tenait le verrou est mort pour de bon, pas seulement son parent.
    expect(vivant(Number(readFileSync(join(dir, 'worker'), 'utf8')))).toBe(false);
    expect(vues).toEqual(['fake apt: attempt 1/3 failed (cut off by its 124 time bound)']);
  }, 30_000);
});

// Le script entier, contre des faux `pnpm`, `sudo`, `apt-get`, `dpkg-query` posés
// en tête du PATH : ce qui est prouvé est ce que le script FAIT (apt lancé ou
// non, avec quels paquets, quel code, quel message), pas combien de fois il appelle.
describe.skipIf(!linux)('scripts/install-playwright.mjs', () => {
  function monde({
    sondePaquets = ['libfoo1', 'libbar2'],
    dejaInstalles = false,
    aptDownload,
    aptInstall = (d) => `touch "${d}/installed-libs"; exit 0`,
  } = {}) {
    const dir = tmp();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const ecrire = (nom, contenu) => {
      writeFileSync(join(bin, nom), contenu);
      chmodSync(join(bin, nom), 0o755);
    };
    const liste = sondePaquets.map((p) => `  ${p}`).join('\\n');
    ecrire(
      'pnpm',
      `#!/bin/sh
case "$*" in
  *install-deps*)
    if [ -e "${dir}/installed-libs" ] || [ -z "${sondePaquets.join('')}" ]; then
      echo "All system dependencies are installed."; exit 0
    fi
    printf 'Missing system dependencies (${sondePaquets.length}):\\n${liste}\\n'; exit 1;;
  *) touch "${dir}/browser"; exit 0;;
esac
`,
    );
    ecrire('sudo', '#!/bin/sh\nshift\nexec "$@"\n');
    ecrire(
      'dpkg-query',
      `#!/bin/sh
for a in "$@"; do
  case "$a" in -*) continue;; esac
  if [ -e "${dir}/installed-libs" ] || [ "${dejaInstalles}" = "true" ]; then echo "$a:amd64 installed"; fi
done
`,
    );
    ecrire(
      'apt-get',
      `#!/bin/sh
echo "$*" >> "${dir}/apt.log"
case "$*" in
  *update*) exit 0;;
  *--download-only*)
${
  aptDownload ??
  `    if [ ! -e "${dir}/hung" ]; then
      touch "${dir}/hung"
      sleep 120 &
      echo $! > "${dir}/worker"
      wait
      exit 1
    fi
    if kill -0 "$(cat "${dir}/worker")" 2>/dev/null; then
      echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process $(cat "${dir}/worker") (apt-get)"; exit 100
    fi
    exit 0`
};;
  *" install -f"*) exit 0;;
  *) ${aptInstall(dir)};;
esac
`,
    );
    // dpkg n'est lancé que par la réparation entre deux tentatives d'installation.
    ecrire(
      'dpkg',
      `#!/bin/sh
echo "$*" >> "${dir}/dpkg.log"
exit 0
`,
    );
    return { dir, bin };
  }

  function lancer({ bin }) {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(racine, 'scripts', 'install-playwright.mjs')],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            // 90 s → 1,8 s : la panne se rejoue en secondes.
            INSTALL_PLAYWRIGHT_BORNE_FACTEUR: '0.02',
          },
        },
        (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  it('le miroir se fige à la 1re tentative : la 2e obtient le verrou, les paquets sont installés', async () => {
    const m = monde();
    const r = await lancer(m);
    expect(r.code).toBe(0);
    // Le navigateur est installé, puis exactement les paquets MANQUANTS arrivent par apt.
    expect(existsSync(join(m.dir, 'browser'))).toBe(true);
    const apt = readFileSync(join(m.dir, 'apt.log'), 'utf8').split('\n').filter(Boolean);
    const installFinal = apt.at(-1);
    expect(installFinal).toContain('install -y --no-install-recommends libfoo1 libbar2');
    expect(installFinal).not.toContain('--download-only');
    expect(existsSync(join(m.dir, 'installed-libs'))).toBe(true);
    // La tentative figée a été coupée, signalée, et son travail est mort.
    expect(r.stdout).toContain('apt-get download: attempt 1/3 failed (cut off by its');
    expect(r.stdout).toContain('dpkg lock check after attempt 1');
    expect(vivant(Number(readFileSync(join(m.dir, 'worker'), 'utf8')))).toBe(false);
    expect(r.stdout).toContain('system dependencies verified');
  }, 60_000);

  it('toutes les dépendances sont déjà là : apt n’est JAMAIS lancé', async () => {
    const m = monde({ sondePaquets: [] });
    const r = await lancer(m);
    expect(r.code).toBe(0);
    expect(existsSync(join(m.dir, 'browser'))).toBe(true);
    expect(existsSync(join(m.dir, 'apt.log'))).toBe(false);
    expect(r.stdout).toContain('every system dependency is already installed: apt is not used');
  }, 30_000);

  it('la sonde liste des paquets installés qui n’ont qu’une mise à jour : apt n’est pas lancé non plus', async () => {
    const m = monde({ dejaInstalles: true });
    const r = await lancer(m);
    expect(r.code).toBe(0);
    expect(existsSync(join(m.dir, 'apt.log'))).toBe(false);
  }, 30_000);

  it('le miroir ne répond jamais : sortie 1, annoncée comme un échec d’INSTALLATION, rien d’installé', async () => {
    const m = monde({ aptDownload: '    echo "E: Failed to fetch" >&2; exit 100' });
    const r = await lancer(m);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('::error title=Playwright browser install failed::');
    expect(r.stderr).toContain('browser install failed in phase "apt-get download"');
    expect(r.stderr).toContain('not a test failure');
    expect(existsSync(join(m.dir, 'installed-libs'))).toBe(false);
    // 3 tentatives de téléchargement, puis plus rien : pas d’installation sur une base incomplète.
    const apt = readFileSync(join(m.dir, 'apt.log'), 'utf8').split('\n').filter(Boolean);
    expect(apt.filter((l) => l.includes('--download-only'))).toHaveLength(3);
    expect(
      apt.filter((l) => !l.includes('--download-only') && l.includes('install -y')),
    ).toHaveLength(0);
  }, 60_000);

  it('l’installation locale est coupée une fois : dpkg est réparé, la tentative 2 réussit', async () => {
    const m = monde({
      aptInstall: (d) =>
        `if [ ! -e "${d}/install-cut" ]; then touch "${d}/install-cut"; echo "E: dpkg was interrupted" >&2; exit 100; fi; touch "${d}/installed-libs"; exit 0`,
    });
    const r = await lancer(m);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('apt-get install: attempt 1/3 failed (exit code 100)');
    // La réparation a tourné ENTRE les deux tentatives : dpkg puis apt-get -f.
    expect(readFileSync(join(m.dir, 'dpkg.log'), 'utf8').trim()).toBe('--configure -a');
    const apt = readFileSync(join(m.dir, 'apt.log'), 'utf8').split('\n').filter(Boolean);
    const installs = apt.filter((l) => l.includes('install -y --no-install-recommends libfoo1'));
    // Deux téléchargements/installations : le téléchargement (--download-only) et 2 installations.
    expect(installs.filter((l) => !l.includes('--download-only'))).toHaveLength(2);
    const iRepar = apt.findIndex((l) => l.includes('install -f -y'));
    const iPremiere = apt.findIndex(
      (l) => l.includes('install -y') && !l.includes('--download-only'),
    );
    expect(iRepar).toBeGreaterThan(iPremiere);
    expect(existsSync(join(m.dir, 'installed-libs'))).toBe(true);
    expect(r.stdout).toContain('system dependencies verified');
  }, 60_000);

  it('l’installation locale échoue trois fois : sortie 1 qui nomme la phase, deux réparations, rien de déclaré vérifié', async () => {
    const m = monde({ aptInstall: () => 'echo "E: dpkg was interrupted" >&2; exit 100' });
    const r = await lancer(m);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('browser install failed in phase "apt-get install"');
    expect(r.stdout).not.toContain('system dependencies verified');
    expect(readFileSync(join(m.dir, 'dpkg.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  }, 60_000);

  it('la sonde ne répond ni « tout est installé » ni une liste : échec, jamais « rien ne manque »', async () => {
    const m = monde();
    writeFileSync(
      join(m.bin, 'pnpm'),
      `#!/bin/sh
case "$*" in
  *install-deps*) echo "E: broken" >&2; exit 100;;
  *) exit 0;;
esac
`,
    );
    const r = await lancer(m);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('the dependency probe');
    expect(existsSync(join(m.dir, 'apt.log'))).toBe(false);
  }, 30_000);
});

describe('les workflows utilisent le script et le cache', () => {
  for (const f of ['ci.yml', 'qa.yml']) {
    const texte = readFileSync(join(racine, '.github', 'workflows', f), 'utf8');

    it(`${f} : le script remplace la boucle --with-deps`, () => {
      expect(texte).toContain('run: node scripts/install-playwright.mjs');
      // Aucune commande `run:` ne relance l'installation en bloc (les commentaires
      // peuvent en parler).
      const commandes = texte.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
      expect(commandes.join(' ')).not.toContain('--with-deps');
    });

    it(`${f} : le cache des navigateurs est clé sur la version exacte de Playwright`, () => {
      expect(texte).toContain('path: ~/.cache/ms-playwright');
      expect(texte).toContain(
        'key: playwright-${{ runner.os }}-${{ steps.playwright.outputs.version }}',
      );
      // La clé lit la version INSTALLÉE : jamais une valeur écrite à la main.
      expect(texte).toContain('playwright --version');
    });
  }
});
