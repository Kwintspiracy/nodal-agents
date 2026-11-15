// machine-trace.mjs — ce que fait la MACHINE pendant qu'une étape de CI tourne.
//
// POURQUOI (#748). Le job `e2e-smoke` perdait son runner au milieu des
// parcours : l'étape ne finissait jamais, ou le runner recevait un « shutdown
// signal » au bout de trois minutes, et rien ne disait ce que la machine
// faisait à ce moment-là. Ce module relève, toutes les quelques secondes, ce
// qui manque pour trancher : la mémoire disponible, le swap et son trafic, la
// pression (PSI), les OOM kills du noyau, la charge, le disque, et les
// processus qui pèsent le plus (mémoire et CPU), regroupés par nom.
//
// Il relève la MACHINE entière, pas un arbre de processus : la stack est
// lancée détachée par `boot-stack.mjs` et n'est donc pas dans l'arbre de
// l'étape qui la teste. C'est la différence avec `build-heap-sampler.mjs`, qui
// mesure la RSS de l'arbre d'un build pour régler un plancher de tas.
//
// Linux seulement : tout se lit dans /proc et /sys, sans outil externe.
//
// Les fonctions `parse*`, `etiquette`, `regrouper`, `ligne` et `bilan` sont
// pures ; `releverMachine` et `identite` lisent le système. Les tests portent
// sur les premières avec des fixtures, et sur le tout avec un vrai relevé.

import { readFileSync, readdirSync, readlinkSync, statfsSync } from 'node:fs';
import { cpus, release } from 'node:os';

const KO = 1024;
const GO = 1024 * 1024 * 1024;

/** `/proc/meminfo` → les quatre valeurs utiles, en octets. Une absence est une erreur. */
export function parseMeminfo(texte) {
  const champs = {};
  for (const l of texte.split('\n')) {
    const m = /^(\w+):\s+(\d+) kB/.exec(l);
    if (m) champs[m[1]] = Number(m[2]) * KO;
  }
  for (const c of ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']) {
    if (champs[c] === undefined) throw new Error(`machine-trace: /proc/meminfo has no ${c}`);
  }
  return {
    total: champs.MemTotal,
    disponible: champs.MemAvailable,
    swapTotal: champs.SwapTotal,
    swapLibre: champs.SwapFree,
  };
}

/** `/proc/vmstat` → les compteurs cumulés qui disent swap, défauts de page et OOM. */
export function parseVmstat(texte) {
  const v = {};
  for (const l of texte.split('\n')) {
    const [cle, val] = l.split(' ');
    if (val !== undefined) v[cle] = Number(val);
  }
  for (const c of ['pswpin', 'pswpout', 'pgmajfault', 'oom_kill']) {
    if (v[c] === undefined) throw new Error(`machine-trace: /proc/vmstat has no ${c}`);
  }
  return { pswpin: v.pswpin, pswpout: v.pswpout, pgmajfault: v.pgmajfault, oomKill: v.oom_kill };
}

/**
 * `/proc/pressure/<x>` → `avg10` de « some » et de « full » (en %). `full`
 * n'existe pas pour le CPU sur les noyaux anciens : il vaut alors null, et
 * la ligne l'écrit comme absent, pas comme zéro.
 */
export function parsePressure(texte) {
  const lire = (genre) => {
    const m = new RegExp(`^${genre} avg10=([\\d.]+)`, 'm').exec(texte);
    return m ? Number(m[1]) : null;
  };
  const some = lire('some');
  if (some === null) throw new Error('machine-trace: a pressure file has no "some" line');
  return { some, full: lire('full') };
}

/**
 * `/proc/<pid>/stat` → pid, nom, parent, temps CPU (tics), RSS (pages).
 * Le nom est entre parenthèses et peut en contenir, ainsi que des espaces :
 * on coupe donc à la DERNIÈRE parenthèse fermante (proc(5)).
 */
export function parseProcStat(texte) {
  const ouvre = texte.indexOf('(');
  const ferme = texte.lastIndexOf(')');
  if (ouvre < 0 || ferme < ouvre)
    throw new Error(`machine-trace: unreadable stat line "${texte.slice(0, 60)}"`);
  const pid = Number(texte.slice(0, ouvre).trim());
  const nom = texte.slice(ouvre + 1, ferme);
  // Après ")" : champ 3 (state) en position 0, donc le champ n est en n - 3.
  const f = texte.slice(ferme + 2).split(' ');
  return {
    pid,
    nom,
    ppid: Number(f[4 - 3]),
    tics: Number(f[14 - 3]) + Number(f[15 - 3]),
    rssPages: Number(f[24 - 3]),
  };
}

/** Noms trop génériques pour dire qui est le processus : on lit sa ligne de commande. */
const NOMS_GENERIQUES = new Set(['node', 'MainThread', 'sh', 'bash', 'tsx', 'npm', 'pnpm']);

/**
 * Le nom sous lequel un processus apparaît dans la trace.
 *
 * Next se renomme « next-server (v16.x) » et le noyau tronque à 15 caractères :
 * on garde ce qui précède l'espace ou la parenthèse. Un `node` ne dit rien :
 * on cherche dans sa ligne de commande (puis son dossier courant) le paquet
 * du dépôt qu'il fait tourner (`apps/runner`, `apps/cli`…), sinon un outil
 * connu, sinon le nom du premier script.
 */
export function etiquette(nom, argv = [], cwd = '') {
  const brut = nom.split(/[ (]/)[0] || nom;
  // Node 24 nomme son fil principal « MainThread » : c'est un `node`.
  const court = brut === 'MainThread' ? 'node' : brut;
  if (!NOMS_GENERIQUES.has(brut) || argv.length === 0) return court;
  const ligne = argv.join(' ');
  const paquet = /(?:^|\/)((?:apps|packages)\/[\w.-]+)/.exec(`${ligne} ${cwd}`);
  if (/playwright/.test(ligne)) return `${court}:playwright`;
  if (paquet) return `${court}:${paquet[1]}`;
  if (/[/\\]next[/\\]/.test(ligne)) return `${court}:next`;
  // Un NOM DE FICHIER de script, et rien d'autre : la trace part dans un
  // artefact que GitHub ne masque pas (revue de la PR #1107). Un argument
  // libre (`bash -c "<une ligne>"`, la valeur d'une option) n'y entre jamais.
  const script = argv
    .slice(1)
    .map((a) => a.split(/[/\\]/).pop())
    .find((nomDeFichier) => SCRIPT.test(nomDeFichier));
  return script ? `${court}:${script}` : court;
}

/** Ce qu'est un nom de fichier de script : un nom simple et une extension connue. */
const SCRIPT = /^[\w.-]+\.(?:mjs|cjs|js|mts|cts|ts|sh|py)$/;

/**
 * Regroupe les processus par étiquette : RSS sommée et CPU (%) entre deux
 * relevés. Tous les processus sont relus à chaque relevé, donc un pid absent
 * du précédent est NÉ entre les deux : tout son temps CPU tient dans
 * l'intervalle. Sans relevé précédent (`avant` null), le CPU instantané
 * n'existe pas : il vaut null, et la ligne le dit.
 */
export function regrouper(avant, apres, dtSec, ticsParSec, taillePage) {
  const precedent = avant ? new Map(avant.map((p) => [p.pid, p.tics])) : null;
  const groupes = new Map();
  for (const p of apres) {
    const g = groupes.get(p.etiquette) ?? {
      etiquette: p.etiquette,
      n: 0,
      rss: 0,
      cpu: precedent ? 0 : null,
    };
    g.n++;
    g.rss += p.rssPages * taillePage;
    if (precedent && dtSec > 0) {
      const delta = p.tics - (precedent.get(p.pid) ?? 0);
      g.cpu += (Math.max(0, delta) / ticsParSec / dtSec) * 100;
    }
    groupes.set(p.etiquette, g);
  }
  return [...groupes.values()];
}

const go = (octets) => `${(octets / GO).toFixed(1)}G`;
const nomGroupe = (g) => (g.n > 1 ? `${g.etiquette}(${g.n})` : g.etiquette);

/**
 * Une ligne de trace. Tout ce qui sert à trancher tient sur une ligne, pour
 * que la DERNIÈRE ligne du journal suffise à dire l'état de la machine.
 */
export function ligne(r, { depuisSec, heure, top = 4 }) {
  const utilise = r.mem.total - r.mem.disponible;
  const swap = r.mem.swapTotal - r.mem.swapLibre;
  const parMem = [...r.groupes].sort((a, b) => b.rss - a.rss).slice(0, top);
  const premier = r.groupes.some((g) => g.cpu === null);
  const parCpu = [...r.groupes]
    .filter((g) => g.cpu !== null && g.cpu >= 1)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, top);
  const psi = (p) => `${p.some.toFixed(1)}/${p.full === null ? '-' : p.full.toFixed(1)}`;
  return (
    `[machine ${heure} +${depuisSec}s] ` +
    `mem used ${go(utilise)} avail ${go(r.mem.disponible)} swap ${go(swap)}` +
    ` | swap in/out ${r.debits.swapIn}/${r.debits.swapOut} pg/s majflt ${r.debits.majflt}/s oom_kill +${r.debits.oomKill}` +
    ` | psi some/full mem ${psi(r.psi.mem)} io ${psi(r.psi.io)} cpu ${psi(r.psi.cpu)}` +
    ` | load ${r.charge} | disk free ${go(r.disqueLibre)}` +
    ` | top mem: ${parMem.map((g) => `${nomGroupe(g)} ${go(g.rss)}`).join(', ')}` +
    ` | top cpu: ${premier ? 'n/a (first sample)' : parCpu.length ? parCpu.map((g) => `${nomGroupe(g)} ${Math.round(g.cpu)}%`).join(', ') : 'none over 1%'}`
  );
}

/**
 * Le bilan d'une trace : les pics, et quand. C'est la ligne que la mesure de
 * référence (dix runs) recopie.
 */
export function bilan(releves) {
  if (releves.length === 0) return '[machine] summary: no sample was taken';
  let pic = releves[0];
  let picSwap = 0;
  let picPsi = 0;
  let oom = 0;
  const parEtiquette = new Map();
  for (const r of releves) {
    if (r.mem.total - r.mem.disponible > pic.mem.total - pic.mem.disponible) pic = r;
    picSwap = Math.max(picSwap, r.mem.swapTotal - r.mem.swapLibre);
    picPsi = Math.max(picPsi, r.psi.mem.some);
    oom += r.debits.oomKill;
    for (const g of r.groupes)
      parEtiquette.set(g.etiquette, Math.max(parEtiquette.get(g.etiquette) ?? 0, g.rss));
  }
  const top = [...parEtiquette.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return (
    `[machine] summary: ${releves.length} samples; peak used ${go(pic.mem.total - pic.mem.disponible)} of ${go(pic.mem.total)}` +
    ` (min avail ${go(pic.mem.disponible)} at +${pic.depuisSec}s); peak swap ${go(picSwap)}; peak psi mem some ${picPsi.toFixed(1)}%;` +
    ` oom kills ${oom}; peak per process: ${top.map(([e, o]) => `${e} ${go(o)}`).join(', ')}`
  );
}

// ── Lecture du système ───────────────────────────────────────────────────────

const lire = (chemin) => readFileSync(chemin, 'utf8');

/** Lit une valeur de /sys ou /proc pour l'en-tête ; l'illisible est DIT, jamais deviné. */
function valeur(chemin) {
  try {
    return lire(chemin).trim();
  } catch (err) {
    return `unreadable (${err.code ?? err.message})`;
  }
}

/** Le cgroup de ce processus (v2), pour lire la limite de mémoire qui s'y applique. */
function cheminCgroup() {
  const l = lire('/proc/self/cgroup')
    .split('\n')
    .find((x) => x.startsWith('0::'));
  return l ? `/sys/fs/cgroup${l.slice(3)}` : null;
}

/**
 * Sur QUELLE machine on tourne. Le fournisseur et le modèle viennent du DMI
 * (sur EC2 Nitro, `product_name` est le type d'instance) : c'est ce qui
 * distingue deux runners que GitHub étiquette pareil.
 */
export function identite() {
  const mem = parseMeminfo(lire('/proc/meminfo'));
  const cg = cheminCgroup();
  return (
    `[machine] host: vendor "${valeur('/sys/class/dmi/id/sys_vendor')}" product "${valeur('/sys/class/dmi/id/product_name')}"` +
    ` | ${cpus().length} cpus "${cpus()[0]?.model ?? '?'}" | mem ${go(mem.total)} swap ${go(mem.swapTotal)}` +
    ` | kernel ${release()} | swappiness ${valeur('/proc/sys/vm/swappiness')} overcommit ${valeur('/proc/sys/vm/overcommit_memory')}` +
    ` | cgroup ${cg ?? 'none'} memory.max ${cg ? valeur(`${cg}/memory.max`) : '-'}`
  );
}

/** Les processus vivants, étiquetés. Un processus qui meurt pendant la lecture est sauté. */
function processus(taillePage) {
  const liste = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let p;
    try {
      p = parseProcStat(lire(`/proc/${d}/stat`));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ESRCH') continue;
      throw err;
    }
    let argv = [];
    let cwd = '';
    // La ligne de commande ne se lit que pour les noms génériques qui pèsent :
    // c'est ce qui garde un relevé sous quelques millisecondes.
    if (
      NOMS_GENERIQUES.has(p.nom.split(/[ (]/)[0]) &&
      p.rssPages * taillePage >= 20 * 1024 * 1024
    ) {
      try {
        argv = lire(`/proc/${d}/cmdline`).split('\0').filter(Boolean);
        cwd = readlinkSync(`/proc/${d}/cwd`);
      } catch {
        // Processus mort, ou dossier courant illisible : l'étiquette retombe sur le nom.
      }
    }
    liste.push({ ...p, etiquette: etiquette(p.nom, argv, cwd) });
  }
  return liste;
}

/**
 * Un relevé complet. `avant` est le relevé précédent (ou null) : les débits
 * (swap, défauts de page, OOM, CPU par processus) sont des différences.
 */
export function releverMachine(avant, { ticsParSec, taillePage, maintenantMs, disque = '/' }) {
  const mem = parseMeminfo(lire('/proc/meminfo'));
  const vm = parseVmstat(lire('/proc/vmstat'));
  const psi = {
    mem: parsePressure(lire('/proc/pressure/memory')),
    io: parsePressure(lire('/proc/pressure/io')),
    cpu: parsePressure(lire('/proc/pressure/cpu')),
  };
  const procs = processus(taillePage);
  const dtSec = avant ? (maintenantMs - avant.ms) / 1000 : 0;
  const par = (a, b) => (dtSec > 0 ? Math.round((b - a) / dtSec) : 0);
  const debits = avant
    ? {
        swapIn: par(avant.vm.pswpin, vm.pswpin),
        swapOut: par(avant.vm.pswpout, vm.pswpout),
        majflt: par(avant.vm.pgmajfault, vm.pgmajfault),
        oomKill: vm.oomKill - avant.vm.oomKill,
      }
    : { swapIn: 0, swapOut: 0, majflt: 0, oomKill: 0 };
  const fs = statfsSync(disque);
  return {
    ms: maintenantMs,
    mem,
    vm,
    psi,
    debits,
    procs,
    groupes: regrouper(avant?.procs ?? null, procs, dtSec, ticsParSec, taillePage),
    charge: lire('/proc/loadavg').split(' ').slice(0, 3).join(' '),
    disqueLibre: fs.bavail * fs.bsize,
  };
}

// ── Ce qui survit à un runner perdu ─────────────────────────────────────────
//
// Mesuré sur la PR de #748 (job 132773066041) : quand le runner est perdu, le
// journal du job n'existe pas (`BlobNotFound`) et l'artefact `if: always()` est
// sauté. Ce qui arrive quand même au serveur, c'est la CHRONOLOGIE du job
// (l'étape y passe « cancelled » pendant l'arrêt) — et les annotations
// (`::warning::`) voyagent par ce canal-là, au moment où elles sont écrites.
// GitHub en garde dix par type et par étape : on n'en écrit donc qu'aux moments
// qui comptent (l'identité de la machine, chaque seuil de mémoire franchi, un
// OOM kill, le signal d'arrêt, le bilan), jamais à chaque relevé.

/** Les seuils de mémoire disponible (Go) dont le franchissement est annoncé. */
export const SEUILS_DISPONIBLE_GO = [4, 3, 2, 1, 0.5];

/**
 * Les seuils que `disponible` (octets) vient de franchir vers le bas, parmi
 * ceux qui ne l'ont pas encore été (`deja`). Du plus haut au plus bas.
 */
export function seuilsFranchis(disponible, deja) {
  return SEUILS_DISPONIBLE_GO.filter((s) => !deja.has(s) && disponible < s * GO);
}

/**
 * Une commande d'annotation GitHub Actions. Les caractères réservés sont
 * échappés comme le runner les lit (`%`, retours ; et `:` `,` dans le titre),
 * sinon une ligne de trace couperait la commande.
 */
export function annotation(genre, titre, texte) {
  const donnee = (t) => t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const propriete = (t) => donnee(t).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::${genre} title=${propriete(titre)}::${donnee(texte)}`;
}

// ── La trace observe, elle ne décide jamais ─────────────────────────────────
//
// Revue de la PR #1107 (constats 1 et 4) : un relevé qui jetait dans la
// minuterie, un `getconf` absent ou un fichier `--out` illisible terminaient le
// lanceur. L'étape devenait rouge sur une panne de la TRACE, la commande
// restait orpheline, ou ne démarrait pas. Règle unique : le code de sortie de
// la commande est le seul verdict de l'étape. Toute partie de la trace passe
// par `essayer` ; la première panne est dite UNE fois (invariant #4 : elle
// nomme ce qui a lâché), puis la trace s'arrête et plus aucune partie ne tourne.
// Les parseurs, eux, restent stricts : c'est le lanceur qui survit à leur refus.

/**
 * @param {(ligne: string) => void} dire  ce qui écrit la panne (le journal, une annotation)
 * @returns {{ essayer: <T>(quoi: string, fn: () => T) => T | undefined, readonly panne: { quoi: string, message: string } | null }}
 */
export function gardien(dire) {
  let panne = null;
  return {
    get panne() {
      return panne;
    },
    essayer(quoi, fn) {
      if (panne) return undefined;
      try {
        return fn();
      } catch (err) {
        panne = { quoi, message: String(err?.message ?? err).split('\n')[0] };
        try {
          dire(
            `[machine] trace stopped: ${quoi} failed (${panne.message}); the command goes on and its exit code is the step's verdict`,
          );
        } catch {
          // DIRE la panne a échoué aussi (revue de la PR #1107, passe 2) : la
          // sortie de l'étape est partie, et le fichier vient de lâcher. Il ne
          // reste aucun canal où l'écrire ; le silence est la seule issue
          // honnête. Ce qui compte continue : la commande va au bout et son
          // code est rendu.
        }
        return undefined;
      }
    },
  };
}
