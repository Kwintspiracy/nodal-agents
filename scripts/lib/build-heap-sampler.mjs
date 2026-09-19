// build-heap-sampler.mjs — combien de mémoire une commande de build demande.
//
// POURQUOI (#219). Le plancher de tas du build web a doublé le 19/09 — 12 288
// à 24 576 Mo — sans que le besoin réel ait été mesuré : le build mourait, on a
// monté le chiffre jusqu'à ce qu'il passe. Un plancher posé comme ça ne redescend
// jamais, et le jour où le besoin double VRAIMENT, personne ne le voit.
//
// Ce module rend le nombre, et il le rend PENDANT le build de release : c'est
// le seul moment où le build tourne de toute façon. `build-pack.mjs` l'appelle
// autour de `next build` ; `scripts/measure-web-build-heap.mjs` l'appelle seul
// quand on veut essayer un autre plancher.
//
// Deux chiffres, parce qu'il y a deux questions :
//
//   picProcessusMo — le plus gros processus. C'est celui qui meurt en SIGABRT
//                    quand le tas ne tient plus, donc celui sur lequel se règle
//                    le plancher.
//   picArbreMo     — la somme des processus vivants au même instant. C'est ce
//                    que la MACHINE doit avoir libre. C'est ce chiffre qui dit
//                    si une machine de 16 Go peut encore construire le pack.
//
// LES DEUX SONT DES RSS, pas des tas V8. On mesure de l'extérieur : un tas se
// lit de l'intérieur du processus, et le build en ouvre des dizaines dont
// aucun ne nous appartient. La RSS contient donc en plus le code, les tampons
// et ce que SWC alloue hors du tas — mesuré le 20/09, 13 069 Mo de RSS pour un
// tas borné à 12 288. C'est la bonne grandeur pour « ce que la machine doit
// avoir », et une borne haute pour « ce que le tas demande ».
//
// ET CE SONT DES RELEVÉS, pas un compteur. On regarde toutes les deux secondes :
// un pic plus court que ça passe entre deux relevés. Mesuré le 20/09 contre le
// compteur de Windows sur le même build : 15 223 Mo relevés pour 15 417 Mo
// réels, soit 1,3 % sous la vérité. C'est une des raisons pour lesquelles le
// plancher se pose AVEC une marge et jamais au pic nu.

import { spawn, execFileSync } from 'node:child_process';

/** Intervalle d'échantillonnage. Plus court coûte du CPU au build qu'on mesure. */
export const INTERVALLE_MS = 2000;

/** En dessous de ce seuil un processus est du bruit (shells, wrappers). */
export const PLANCHER_BRUIT_MO = 64;

/**
 * Les pid de l'arbre enraciné en `racine`, `racine` comprise.
 *
 * Le build se déporte : `next build` ouvre des workers, qui ouvrent les leurs.
 * Filtrer sur « tous les node de la machine » attraperait les processus des
 * autres sessions — sur une machine de développement il en tourne en
 * permanence, et le pic mesuré serait le leur.
 */
export function arbreDe(processus, racine) {
  const enfants = new Map();
  for (const p of processus) {
    if (!enfants.has(p.ppid)) enfants.set(p.ppid, []);
    enfants.get(p.ppid).push(p.pid);
  }
  const vus = new Set([racine]);
  const file = [racine];
  while (file.length > 0) {
    const courant = file.shift();
    for (const enfant of enfants.get(courant) ?? []) {
      if (vus.has(enfant)) continue;
      vus.add(enfant);
      file.push(enfant);
    }
  }
  return vus;
}

/**
 * Les deux pics, à partir des échantillons.
 *
 * Un échantillon est `{ t, processus: [{ pid, rssMo }] }` — l'arbre déjà filtré.
 * `picArbreMo` se calcule par échantillon puis se maximise : sommer les pics
 * individuels donnerait un total que la machine n'a jamais porté, puisque les
 * workers ne culminent pas ensemble.
 *
 * `relevesUtiles` compte les échantillons qui ont VU quelque chose. Il est là
 * parce que sans lui un pic de 0 est indiscernable d'un build minuscule :
 * `relever()` avale ses erreurs pour qu'un relevé raté ne tue pas la mesure, et
 * si TOUS échouent — PowerShell indisponible, droits refusés — le résultat est
 * un zéro parfaitement présentable, que le verdict lisait « −100 % sur la
 * référence, tout va bien ». Un chiffre absent doit se dire absent
 * (invariant #4). Constat 2 de la revue C sur la PR #277.
 */
export function picsDe(echantillons) {
  let picProcessusMo = 0;
  let pidPic = null;
  let picArbreMo = 0;
  let tPicArbre = null;
  let relevesUtiles = 0;
  for (const e of echantillons) {
    if (e.processus.length > 0) relevesUtiles += 1;
    let total = 0;
    for (const p of e.processus) {
      total += p.rssMo;
      if (p.rssMo > picProcessusMo) {
        picProcessusMo = p.rssMo;
        pidPic = p.pid;
      }
    }
    if (total > picArbreMo) {
      picArbreMo = total;
      tPicArbre = e.t;
    }
  }
  return { picProcessusMo, pidPic, picArbreMo, tPicArbre, relevesUtiles };
}

/**
 * Le plancher que la mesure justifie : le pic d'un processus majoré d'une
 * marge, arrondi au multiple de 1024 supérieur.
 *
 * La marge n'est pas de la superstition. Le pic dépend de la machine (nombre de
 * cœurs → nombre de workers), du système de fichiers et de ce que le tas a eu
 * le temps de ramasser. Un plancher posé AU pic mesuré meurt sur la machine
 * d'à côté.
 */
export function plancherPour(picProcessusMo, margePourCent = 25) {
  const avecMarge = picProcessusMo * (1 + margePourCent / 100);
  return Math.ceil(avecMarge / 1024) * 1024;
}

/**
 * Ce que le build de release dit du pic qu'il vient de mesurer, face à la
 * dernière mesure de référence.
 *
 * POURQUOI PAS UNE COMPARAISON AU PLANCHER. Le plancher est un
 * `--max-old-space-size` : il borne le tas V8 et RIEN d'autre. Le pic mesuré
 * ici est une RSS, qui contient en plus le code, les tampons et tout ce que
 * SWC alloue hors du tas — mesuré le 20/09 : 13 069 Mo de RSS pour un tas
 * borné à 12 288. Comparer les deux ferait crier le build à chaque fois, et
 * une alerte qui crie toujours ne se lit plus.
 *
 * Face à une référence, en revanche, le chiffre dit quelque chose : il a monté
 * de tant depuis la dernière fois qu'on a regardé. C'est exactement ce qui a
 * manqué le 19/09, où un plancher a doublé sans que personne puisse dire de
 * combien le besoin, lui, avait bougé.
 *
 * Ça N'ÉCHOUE JAMAIS. Le pic dépend de la machine — nombre de cœurs, version
 * de Node, ce que le tas a eu le temps de ramasser. Mesuré le 20/09 : 61 s de
 * compilation sur le runner de la CI (4 cœurs, Node 22) contre 840 s sur la
 * machine de release (24 cœurs, Node 26.4.0). Faire échouer une release sur un
 * écart pareil serait la faire échouer sur le matériel de celui qui la coupe.
 *
 * Il prend la MESURE, pas le seul nombre, parce qu'il a besoin de savoir si le
 * chiffre existe : `relevesUtiles` à zéro veut dire « personne n'a regardé »,
 * ce qui n'est pas la même chose qu'un pic bas.
 */
export function verdictPic(mesure, reference, seuilHausse = 0.25) {
  const { picProcessusMo, relevesUtiles } = mesure;
  if (!relevesUtiles) {
    // Aucun relevé n'a vu de processus : il n'y a pas de pic à comparer, et
    // surtout pas un pic de zéro. Le dire, plutôt que de rendre un verdict
    // rassurant sur un chiffre qui n'existe pas.
    return {
      niveau: 'indisponible',
      message:
        "Pic non mesuré : aucun relevé n'a vu de processus (échantillonnage muet — " +
        "l'outil de relevé du système a-t-il répondu ?). Le build a pu se passer très bien ; " +
        "simplement, personne ne l'a regardé.",
    };
  }
  if (!reference || !Number.isFinite(reference.picProcessusMo) || reference.picProcessusMo <= 0) {
    return {
      niveau: 'sans-reference',
      message:
        `Pic d'un processus ${picProcessusMo} Mo. Aucune référence enregistrée : ` +
        `écrire ce chiffre dans scripts/build-heap-reference.json pour que le prochain build ait de quoi comparer.`,
    };
  }
  const hausse = (picProcessusMo - reference.picProcessusMo) / reference.picProcessusMo;
  if (hausse > seuilHausse) {
    return {
      niveau: 'hausse',
      message:
        `Pic d'un processus ${picProcessusMo} Mo, soit +${Math.round(hausse * 100)} % sur la référence ` +
        `(${reference.picProcessusMo} Mo, ${reference.commit}, ${reference.machine}). ` +
        `Sur la même machine, c'est une régression à expliquer (#219) ; sur une autre, c'est peut-être ` +
        `seulement plus de cœurs — dans ce cas ré-enregistrer la référence.`,
    };
  }
  return {
    niveau: 'ok',
    message:
      `Pic d'un processus ${picProcessusMo} Mo, référence ${reference.picProcessusMo} Mo ` +
      `(${hausse >= 0 ? '+' : ''}${Math.round(hausse * 100)} %).`,
  };
}

/** `ps` POSIX : « pid ppid rss(Ko) » par ligne, une ligne d'en-tête. */
export function parserPsPosix(sortie) {
  const out = [];
  for (const ligne of sortie.split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(ligne);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssMo: Number(m[3]) / 1024 });
  }
  return out;
}

/** `Get-CimInstance Win32_Process | ConvertTo-Json` : tableau, ou objet seul. */
export function parserCimWindows(json) {
  const brut = JSON.parse(json);
  const liste = Array.isArray(brut) ? brut : [brut];
  return liste.map((p) => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId),
    // WorkingSetSize est en octets, et remonte en chaîne au-delà de 2^31.
    rssMo: Number(p.WorkingSetSize) / (1024 * 1024),
  }));
}

/** Un relevé de tous les processus de la machine, normalisé. */
export function relever() {
  if (process.platform === 'win32') {
    const json = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return parserCimWindows(json);
  }
  const sortie = execFileSync('ps', ['-eo', 'pid,ppid,rss'], { encoding: 'utf8' });
  return parserPsPosix(sortie);
}

/**
 * Lance `ligneDeCommande` et rend son code de sortie avec les pics de son arbre.
 *
 * `shell: true` est obligatoire sous Windows (pnpm est un `.cmd`), et la ligne
 * est passée entière : avec un tableau d'arguments, Node déprécie l'appel parce
 * que les arguments sont concaténés sans échappement. Rien ici ne vient de
 * l'extérieur.
 */
export async function mesurerCommande(ligneDeCommande, { cwd, env, intervalleMs = INTERVALLE_MS }) {
  const debut = Date.now();
  const enfant = spawn(ligneDeCommande, { cwd, env, stdio: 'inherit', shell: true });

  const echantillons = [];
  const minuteur = setInterval(() => {
    let tous;
    try {
      tous = relever();
    } catch {
      // Un relevé raté ne doit pas tuer la mesure : le suivant reprendra.
      return;
    }
    const dansArbre = arbreDe(tous, enfant.pid);
    echantillons.push({
      t: Math.round((Date.now() - debut) / 1000),
      processus: tous
        .filter((p) => dansArbre.has(p.pid) && p.rssMo >= PLANCHER_BRUIT_MO)
        .map((p) => ({ pid: p.pid, rssMo: Math.round(p.rssMo) })),
    });
  }, intervalleMs);

  const code = await new Promise((res) => enfant.on('close', res));
  clearInterval(minuteur);

  return {
    codeSortie: code,
    secondes: Math.round((Date.now() - debut) / 1000),
    echantillons,
    ...picsDe(echantillons),
  };
}

/** Le NODE_OPTIONS de l'appelant, son `--max-old-space-size` remplacé par `capMo`. */
export function nodeOptionsAvecCap(inherited, capMo) {
  const sans = (inherited ?? '').replace(/--max-old-space-size=\d+/g, '').trim();
  return `${sans} --max-old-space-size=${String(capMo)}`.trim();
}
