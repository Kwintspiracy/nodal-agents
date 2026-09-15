#!/usr/bin/env node
// apps/qa/build.mjs — rend le portail qualité en un site statique.
//
// Un seul fichier HTML, navigation par ancres, aucune dépendance : il se
// déploie sur GitHub Pages tel quel et s'ouvre en local sans serveur.
//
// Règle de ce portail : **ce qui n'est pas mesuré est montré comme non mesuré**,
// jamais comme zéro et jamais comme vert. C'est la seule différence entre un
// tableau de bord et une décoration.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ecartsDe, verdictDuBanc, tendance, etatDunParcours, MOT_ETAT } from './lib.mjs';
import { EXPLICATIONS } from './explications.mjs';

const ICI = dirname(fileURLToPath(import.meta.url));
const DATA = join(ICI, 'data');
const DIST = join(ICI, 'dist');

const s = JSON.parse(readFileSync(join(DATA, 'snapshot.json'), 'utf8'));
const historique = existsSync(join(DATA, 'history.ndjson'))
  ? readFileSync(join(DATA, 'history.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : [];

/**
 * L'en-tête d'une page : son titre, deux phrases qui disent pourquoi elle
 * existe, et le bouton qui ouvre l'explication complète. Quentin, 12/09 :
 * « je ne sais pas ce que je regarde ». Un titre seul ne suffit à personne.
 */
const RAIL = {
  chantiers: ['01', 'The board'],
  capacites: ['02', 'The product'],
  ecarts: ['03', 'What is wrong'],
  parcours: ['04', 'Journeys'],
  memoire: ['05', 'Over time'],
  vue: ['06', 'The code'],
  banc: ['07', 'Measures'],
  ci: ['08', 'What runs it'],
  historique: ['09', 'The record'],
};

const entete = (id, titre) => {
  const x = EXPLICATIONS[id];
  if (!x) throw new Error(`page sans explication : ${id}`);
  const [n, rubrique] = RAIL[id] ?? ['', ''];
  return `<div class="entete-page">
    <div class="rail-page"><span class="rail-page__n">${n}</span><span class="mono">${esc(rubrique)}</span></div>
    <div class="entete-page__corps">
      <h2 class="titre-vue">${esc(titre)}</h2>
      <p class="pourquoi">${esc(x.enBref)}</p>
    </div>
    <button type="button" class="btn-comprendre" data-explique="${id}">Understand this page</button>
  </div>`;
};

/** Une phrase au-dessus d'un tableau ou d'un cadre : ce qu'on est en train de regarder. */
const repere = (id, bloc) => {
  const t = EXPLICATIONS[id]?.blocs?.[bloc];
  if (!t) throw new Error(`bloc sans repère : ${id}.${bloc}`);
  return `<p class="repere">${esc(t)}</p>`;
};

/** La modale, une seule, remplie au clic depuis les explications embarquées. */
const modaleExplications = () => `<dialog id="explication" class="modale">
  <div class="modale__cadre">
    <header class="modale__tete">
      <h2 id="explication-titre"></h2>
      <button type="button" class="modale__fermer" data-fermer aria-label="Close">Close</button>
    </header>
    <div id="explication-corps" class="modale__corps"></div>
  </div>
</dialog>
<script>
  window.__EXPLICATIONS = ${JSON.stringify(
    Object.fromEntries(
      Object.entries(EXPLICATIONS).map(([k, v]) => [k, { titre: v.titre, parties: v.parties }]),
    ),
  ).replace(/</g, '\u003c')};
</script>`;

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '·');

/**
 * Le chemin entre un rouge et sa CAUSE.
 *
 * Un nom de test rouge dans un tableau est un cul-de-sac : on sait que ça casse,
 * jamais ce que l'utilisateur aurait vu. Ce lien mène au run qui l'a vu rouge,
 * donc à son rapport, ses traces et ses captures d'écran.
 *
 * Rien du tout quand l'adresse manque — une mesure locale n'a pas de run à
 * montrer, et un lien mort coûte plus cher que pas de lien.
 */
const lienRun = (url) =>
  url
    ? `<a class="lien-run" href="${esc(url)}" target="_blank" rel="noopener">see the run</a>`
    : '';
const pct = (v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : null);
/** Le jour seul — sur un axe de courbe, l'heure d'une collecte n'apprend rien. */
const jourFr = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '·';
const dateFr = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '·';

// ─── Écarts : la liste qui dit quoi faire, classée par ce que ça coûte ────────

// La liste vit dans `lib.mjs`, sous test : c'est elle qui décide de ce qu'on
// regarde en premier, et elle est passée d'un tas indifférencié à une hiérarchie
// déduite de faits (issue #65).
const ecarts = () => ecartsDe(s, historique);

// ─── Fragments ────────────────────────────────────────────────────────────────

function barre(valeur, libelle) {
  if (typeof valeur !== 'number') {
    return `<div class="jauge jauge--inconnue" role="img" aria-label="${esc(libelle)}: not measured"><span>not measured</span></div>`;
  }
  const ton = valeur >= 80 ? 'ok' : valeur >= 60 ? 'moyen' : 'faible';
  return `<div class="jauge jauge--${ton}" role="img" aria-label="${esc(libelle)}: ${valeur.toFixed(1)}%">
      <i style="width:${Math.max(0, Math.min(100, valeur)).toFixed(1)}%"></i><span>${valeur.toFixed(1)}%</span></div>`;
}

/** L'âge d'une date en jours pleins, compté depuis la collecte — jamais depuis l'ouverture de la page. */
const joursDepuis = (iso, reference = s.genereLe) => {
  if (!iso) return null;
  const de = Date.parse(iso);
  const a = Date.parse(reference);
  if (!Number.isFinite(de) || !Number.isFinite(a)) return null;
  return Math.max(0, Math.floor((a - de) / 86400000));
};

/**
 * Une courbe, en SVG écrit à la main.
 *
 * Aucune bibliothèque : le portail est un fichier HTML qui doit s'ouvrir sans
 * réseau et se déployer sur GitHub Pages tel quel. Une ligne, une aire légère,
 * le dernier point marqué, et l'axe des valeurs à l'échelle des données —
 * partir de zéro écraserait une variation de deux points de couverture au point
 * de la rendre invisible, ce qui est exactement ce qu'on vient regarder.
 *
 * Un seul point ne donne pas de tendance, et la page le DIT plutôt que de
 * tracer une ligne horizontale qui ressemblerait à « stable ».
 */
function courbe(t, { titre, libelle, fmt = (v) => v.toFixed(1) }) {
  const pts = t.valeurs ?? [];
  if (pts.length === 0) {
    return `<article class="courbe">
      <h4>${esc(titre)}</h4>
      <p class="courbe__vide">No measured collection over the window. Nothing to plot, and nothing is plotted.</p>
    </article>`;
  }

  // Un viewBox proche de la largeur rendue (une carte sur trois d'une grille) :
  // un viewBox deux fois trop large écrase les libellés à cinq pixels, ce que la
  // première capture a montré sans appel.
  const W = 360;
  const H = 170;
  const [mg, md, mh, mb] = [46, 12, 18, 26];
  const vals = pts.map((p) => p.valeur);
  let bas = Math.min(...vals);
  let haut = Math.max(...vals);
  if (haut === bas) {
    // Une série parfaitement plate : on l'entoure, sinon la division par zéro.
    bas -= 1;
    haut += 1;
  } else {
    const marge = (haut - bas) * 0.15;
    bas -= marge;
    haut += marge;
  }
  const x = (i) =>
    pts.length === 1 ? (mg + (W - md)) / 2 : mg + (i * (W - mg - md)) / (pts.length - 1);
  const y = (v) => mh + (1 - (v - bas) / (haut - bas)) * (H - mh - mb);

  const ligne = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.valeur).toFixed(1)}`).join(' ');
  const dernier = pts.at(-1);
  const aire =
    pts.length > 1
      ? `<polygon class="courbe__aire" points="${x(0).toFixed(1)},${(H - mb).toFixed(1)} ${ligne} ${x(pts.length - 1).toFixed(1)},${(H - mb).toFixed(1)}"></polygon>`
      : '';

  const fleche = { monte: '↗', descend: '↘', stable: '→' }[t.direction] ?? '';
  const resume =
    t.delta == null
      ? 'a single collection, no trend yet'
      : `${fleche} ${t.delta > 0 ? '+' : ''}${fmt(t.delta)} since ${jourFr(pts[0].le)}`;

  return `<article class="courbe">
  <h4>${esc(titre)} <span class="courbe__resume courbe__resume--${t.direction ?? 'seule'}">${esc(resume)}</span></h4>
  <svg viewBox="0 0 ${W} ${H}" class="courbe__trace" role="img" aria-label="${esc(libelle)}: ${esc(resume)}">
    <line class="courbe__axe" x1="${mg}" y1="${mh}" x2="${W - md}" y2="${mh}"></line>
    <line class="courbe__axe" x1="${mg}" y1="${H - mb}" x2="${W - md}" y2="${H - mb}"></line>
    <text class="courbe__graduation" x="${mg - 8}" y="${mh + 4}" text-anchor="end">${esc(fmt(haut))}</text>
    <text class="courbe__graduation" x="${mg - 8}" y="${H - mb + 4}" text-anchor="end">${esc(fmt(bas))}</text>
    ${aire}
    ${pts.length > 1 ? `<polyline class="courbe__ligne" points="${ligne}"></polyline>` : ''}
    <circle class="courbe__point" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(dernier.valeur).toFixed(1)}" r="4"></circle>
    <text class="courbe__valeur" x="${Math.min(x(pts.length - 1) + 10, W - md).toFixed(1)}" y="${(y(dernier.valeur) - 9).toFixed(1)}" text-anchor="end">${esc(fmt(dernier.valeur))}</text>
    <text class="courbe__date" x="${mg}" y="${H - 6}">${esc(jourFr(pts[0].le))}</text>
    <text class="courbe__date" x="${W - md}" y="${H - 6}" text-anchor="end">${esc(jourFr(dernier.le))}</text>
  </svg>
</article>`;
}

function vueEnsemble() {
  const r = s.resume;
  // Sept jours, et pas trente : sous ce chiffre, la question est « est-ce qu'on
  // vient d'ajouter du code sans test », pas « où en était-on ce mois-ci ».
  const tCouv = tendance(historique, 'couvertureLignes', { jours: 7 });
  const phraseCouv =
    tCouv.delta == null
      ? `No trend yet: ${tCouv.valeurs.length} measured collection(s) over the last 7 days, two are needed.`
      : tCouv.direction === 'stable'
        ? 'Stable over 7 days.'
        : `${tCouv.direction === 'monte' ? 'Up' : 'Down'} ${Math.abs(tCouv.delta)} point(s) over 7 days.`;
  const couvert = pct(r.couvertureLignes);
  const partJouee = r.specsE2e > 0 ? Math.round((r.specsE2eJoueesParLaCi / r.specsE2e) * 100) : 0;

  return `
<section id="vue" class="vue">
  ${entete('vue', 'Tests, overview')}

  ${repere('vue', 'cartes')}
  <div class="cartes">
    <article class="carte carte--phare">
      <h3>Real line coverage</h3>
      <p class="chiffre">${couvert ?? '·'}</p>
      <p class="sous">${n(r.lignesCouvertes)} lines covered out of ${n(r.lignesTotal)}<br>
        <b>over ${r.paquetsMesures} measured packages / ${r.paquets}</b></p>
      ${barre(r.couvertureLignes, 'line coverage')}
      <p class="tendance tendance--${tCouv.direction ?? 'seule'}">${esc(phraseCouv)}</p>
      <p class="avertissement">This number only holds for the measured share. ${r.paquets - r.paquetsMesures} package${r.paquets - r.paquetsMesures > 1 ? 's have' : ' has'} never been instrumented, they count in neither the numerator nor the denominator.</p>
    </article>

    <article class="carte">
      <h3>Test cases</h3>
      <p class="chiffre">${n(r.casDeTest)}</p>
      <p class="sous">in ${n(r.fichiersDeTest)} files, end-to-end aside</p>
    </article>

    <article class="carte ${r.specsE2eJoueesParLaCi < r.specsE2e ? 'carte--alerte' : ''}">
      <h3>Journeys played by the CI</h3>
      <p class="chiffre">${r.specsE2eJoueesParLaCi} <span class="sur">/ ${r.specsE2e}</span></p>
      <p class="sous">${n(r.casE2e)} cases written · ${
        r.specsE2e - r.specsE2eJoueesParLaCi > 0
          ? `<b>${r.specsE2e - r.specsE2eJoueesParLaCi} never played</b>`
          : 'every one of them played'
      }</p>
      ${barre(partJouee, 'journeys played')}
    </article>

    <article class="carte">
      <h3>Bench sections</h3>
      <p class="chiffre">${s.banc.sections.length}</p>
      <p class="sous">${s.ci.some((w) => w.lanceBanc) ? 'run by the CI' : '<b>never run by the CI</b>'}</p>
    </article>
  </div>

  <h3 class="sous-titre">Coverage by package</h3>
  ${repere('vue', 'paquets')}
  <p class="note-section">Sorted by uncovered line count: what sits on top is what costs the most to ignore. An unmeasured package is hatched, it does not have zero, it has nothing.</p>
  <div class="tableau">
    <table>
      <thead><tr><th>Package</th><th>Cases</th><th class="num">Lines</th><th style="min-width:180px">Line coverage</th><th class="num">Branches</th></tr></thead>
      <tbody>
        ${[...s.paquets]
          .filter((p) => p.tests.cas > 0 || p.couverture)
          .sort((a, b) => {
            const na = a.couverture
              ? (a.couverture.lignesTotal ?? 0) - (a.couverture.lignesCouvertes ?? 0)
              : -1;
            const nb = b.couverture
              ? (b.couverture.lignesTotal ?? 0) - (b.couverture.lignesCouvertes ?? 0)
              : -1;
            return nb - na;
          })
          .map(
            (p) => `<tr>
              <td><span class="mono">${esc(p.nom)}</span></td>
              <td class="num">${n(p.tests.cas)}</td>
              <td class="num dim">${p.couverture ? `${n(p.couverture.lignesCouvertes)}/${n(p.couverture.lignesTotal)}` : '·'}</td>
              <td>${barre(p.couverture?.lignes ?? null, p.nom)}</td>
              <td class="num dim">${p.couverture ? pct(p.couverture.branches) : '·'}</td>
            </tr>`,
          )
          .join('\n')}
      </tbody>
    </table>
  </div>
</section>`;
}

function vueParcours() {
  // Regroupés par CADENCE, pas par « joué / pas joué ». Un parcours joué la
  // nuit constate une régression ; joué à chaque PR, il la BLOQUE avant le
  // merge. Les mettre dans le même sac, c'est appeler « couvert » un parcours
  // qui ne garde rien.
  const parCadence = new Map();
  for (const p of s.parcours) {
    const c = p.cadence ?? 'never played';
    parCadence.set(c, [...(parCadence.get(c) ?? []), p]);
  }
  const ORDRE = [
    'every pull request',
    'every push to main',
    'every night',
    'by hand',
    'never played',
  ];

  const ligne = (p) => {
    const r = p.resultat;
    const e = etatDunParcours(p);
    let etat;
    if (e.rouge) {
      // ROUGE, et nommé. Un fichier que personne ne joue garde zéro
      // régression, et il ne le disait pas : il portait le même gris qu'un
      // parcours sain dont le rapport manque (issue #110).
      etat = `<span class="pastille pastille--ko">${e.mot}</span>`;
    } else if (!r) {
      etat = `<span class="pastille pastille--inconnu">${e.mot}</span>`;
    } else {
      // Quatre sorts, montrés SÉPARÉMENT. Un cas ignoré n'est pas un cas rouge :
      // les confondre, c'est le défaut que ce portail dénonce ailleurs.
      const bouts = [];
      if (r.vert) bouts.push(`<span class="pastille pastille--ok">${r.vert} green</span>`);
      if (r.rouge) bouts.push(`<span class="pastille pastille--ko">${r.rouge} red</span>`);
      if (r.instable)
        bouts.push(`<span class="pastille pastille--moyen">${r.instable} flaky</span>`);
      if (r['ignoré'])
        bouts.push(`<span class="pastille pastille--inconnu">${r['ignoré']} skipped</span>`);
      etat = bouts.join(' ') || '<span class="pastille pastille--inconnu">nothing to say</span>';
    }
    return `<tr>
      <td><span class="mono">${esc(p.nom)}</span><br>${
        p.intention
          ? `<span class="intention">${esc(p.intention)}</span>`
          : '<span class="intention intention--absente">no description</span>'
      }
        ${r?.rouge ? lienRun(s.execution?.url) : ''}
        ${e.rouge ? '<br><span class="intention intention--absente">Nothing runs it: this file guards nothing.</span>' : ''}</td>
      <td class="num">${p.cas}</td>
      <td>${etat}</td>
      <td class="num dim">${r?.dureeMs ? `${(r.dureeMs / 1000).toFixed(1)} s` : '·'}</td>
    </tr>`;
  };

  const bloc = (cadence) => {
    const dedans = parCadence.get(cadence);
    if (!dedans || dedans.length === 0) return '';
    const note =
      cadence === 'every pull request'
        ? 'These BLOCK a regression before the merge.'
        : cadence === 'every night'
          ? 'These OBSERVE it the next day. They guard no pull request.'
          : cadence === 'never played'
            ? 'Written, versioned, and run by no continuous integration. These are reds, not blanks: they guard nothing.'
            : '';
    return `<h3 class="sous-titre">${esc(cadence)} <span class="compte">${dedans.length}</span></h3>
      ${note ? `<p class="note-section">${note}</p>` : ''}
      <div class="tableau"><table>
        <thead><tr><th>Journey</th><th class="num">Cases</th><th style="min-width:230px">Last result</th><th class="num">Duration</th></tr></thead>
        <tbody>${dedans.map(ligne).join('\n')}</tbody>
      </table></div>`;
  };

  const bloque = (parCadence.get('every pull request') ?? []).length;
  const jamais = s.parcours.filter((p) => etatDunParcours(p).rouge);
  return `
<section id="parcours" class="vue">
  ${entete('parcours', 'Journeys')}
  <p class="chapo">${s.parcours.length} versioned, and <b>only ${bloque} guard a pull request</b>: the others observe after the fact, or never.</p>
  ${
    jamais.length > 0
      ? `<div class="alerte"><b>${jamais.length} journey${jamais.length > 1 ? 's are' : ' is'} never played.</b> A journey nobody runs is a claim of coverage that does not exist. Delete it, or put it in a workflow.</div>`
      : ''
  }
  ${repere('parcours', 'cadence')}
  ${ORDRE.map(bloc).join('\n')}
</section>`;
}

function vueBanc() {
  return `
<section id="banc" class="vue">
  ${entete('banc', 'Bench')}
  ${
    s.ci.some((w) => w.lanceBanc)
      ? ''
      : `<div class="alerte"><b>No workflow runs it.</b> The bench can detect a regression and say so; it stays silent as long as nothing runs it.</div>`
  }
  ${(() => {
    // Le verdict du DERNIER passage, et pas seulement les baselines acceptées.
    // Le banc détectait les régressions, les écrivait, et personne ne les lisait
    // — la vue ne montrait que ce qui avait été validé un jour.
    const v = verdictDuBanc(s.banc?.dernierRun);
    if (v.absent) {
      return `<div class="alerte"><b>No run recorded.</b> The values below are the ACCEPTED baselines, not a measurement of the day. Missing is not "nothing moved".</div>`;
    }
    if (v.regressions.length === 0 && v.erreurs.length === 0) {
      return `<p class="note-section">Last run on ${esc(dateFr(v.mesureLe))}: no regression, no section down.</p>`;
    }
    const bouts = [];
    if (v.regressions.length > 0) {
      bouts.push(
        `<b>${v.regressions.length} section(s) regressed:</b> ${v.regressions.map(esc).join(', ')}`,
      );
    }
    if (v.erreurs.length > 0) {
      bouts.push(
        `<b>${v.erreurs.length} section(s) could not run:</b> ${v.erreurs.map(esc).join(', ')}: a fault, not a slowdown`,
      );
    }
    return `<div class="alerte">${bouts.join('<br>')}<br><span class="dim">Run of ${esc(dateFr(v.mesureLe))}.</span></div>`;
  })()}
  ${repere('banc', 'sections')}
  <div class="grille-banc">
    ${s.banc.sections
      .map(
        (b) => `<article class="bloc-banc">
        <header><h3 class="mono">${esc(b.id)}</h3><span class="dim mono">ref. ${esc((b.gitSha ?? '').slice(0, 7))}</span></header>
        <dl>${b.metriques
          .map(
            (m) =>
              `<div><dt>${esc(m.label)}</dt><dd>${n(m.valeur)} <span class="unite">${esc(m.unite ?? '')}</span></dd></div>`,
          )
          .join('')}</dl>
        <p class="dim">accepted on ${dateFr(b.accepteeLe)}</p>
      </article>`,
      )
      .join('\n')}
  </div>
</section>`;
}

/**
 * Le prix d'une PR : combien de minutes on attend ses contrôles.
 *
 * En TÊTE de la page, avant la mécanique des workflows, parce que c'est la
 * seule chose de cette page qui se subit tous les jours. Et parce que ce chiffre
 * décide du sort des tests : quand l'attente devient insupportable, c'est la
 * suite qu'on raccourcit, jamais la machine.
 *
 * Absent quand GitHub n'a pas répondu — jamais un zéro, qui ferait croire à une
 * CI gratuite.
 */
function cadrePrix() {
  const p = s.prixCi;
  if (!p) {
    return `<article class="prix prix--absent">
      <h3>Price of a pull request</h3>
      <p class="avertissement">GitHub did not answer. The cost of the checks is not measured for this collection, that is not zero minutes, it is no measurement.</p>
    </article>`;
  }
  if (p.runs === 0) {
    return `<article class="prix prix--absent">
      <h3>Price of a pull request</h3>
      <p class="avertissement">No GREEN run among the last thirty. A wait is only measured on a run that went all the way: a red run stops at the first failure and would give a flattering duration.</p>
    </article>`;
  }
  const min = (v) => (typeof v === 'number' ? `${v.toFixed(1)} min` : '·');
  return `<article class="prix">
  <h3>Price of a pull request <span class="dim">${p.runs} green run(s) out of the last 30</span></h3>
  <div class="prix__chiffres">
    <div class="prix__bloc prix__bloc--phare"><span class="prix__valeur">${min(p.mediane)}</span><span class="prix__quoi">median</span></div>
    <div class="prix__bloc"><span class="prix__valeur">${min(p.dernier)}</span><span class="prix__quoi">last</span></div>
    <div class="prix__bloc"><span class="prix__valeur">${min(p.pire)}</span><span class="prix__quoi">worst</span></div>
    <div class="prix__bloc"><span class="prix__valeur prix__valeur--${p.tendance ?? 'seule'}">${
      p.tendance == null
        ? '·'
        : `${{ monte: '↗', descend: '↘', stable: '→' }[p.tendance]} ${p.hausse > 0 ? '+' : ''}${p.hausse} %`
    }</span><span class="prix__quoi">trend</span></div>
  </div>
  ${courbe(
    { valeurs: p.serie, delta: p.deltaMin, direction: p.tendance },
    {
      titre: 'Duration of green runs',
      libelle: 'Minutes of waiting per CI run',
      fmt: (v) => `${v.toFixed(1)} min`,
    },
  )}
</article>`;
}

function vueCi() {
  return `
<section id="ci" class="vue">
  ${entete('ci', 'What triggers what')}
  ${repere('ci', 'prix')}
  ${cadrePrix()}
  <div class="grille-ci">
    ${s.ci
      .map(
        (w) => `<article class="bloc-ci">
      <header><h3>${esc(w.nom)}</h3><span class="dim mono">${esc(w.fichier)}</span></header>
      <p class="ligne-meta"><b>Triggers</b> ${w.declencheurs.length ? w.declencheurs.map((d) => `<span class="jeton">${esc(d)}</span>`).join(' ') : '<span class="dim">none</span>'}</p>
      <p class="ligne-meta"><b>Jobs</b> ${w.jobs.map((j) => `<span class="jeton">${esc(j)}</span>`).join(' ')}</p>
      <p class="ligne-meta"><b>Bench</b> ${w.lanceBanc ? '<span class="pastille pastille--ok">run</span>' : '<span class="pastille pastille--ko">not run</span>'}
         &nbsp;<b>Coverage</b> ${w.lanceCouverture ? '<span class="pastille pastille--ok">measured</span>' : '<span class="pastille pastille--ko">not measured</span>'}</p>
      ${w.specsNommees.length ? `<p class="ligne-meta"><b>Journeys played</b> ${w.specsNommees.map((x) => `<span class="jeton mono">${esc(x)}</span>`).join(' ')}</p>` : ''}
    </article>`,
      )
      .join('\n')}
  </div>
</section>`;
}

// La seule vue qui parle du PRODUIT. Toutes les autres parlent du dépôt :
// « @nodal-agents/web à 78 % » ne dit rien à personne. Ici la ligne est une
// phrase qu'un humain reconnaît, et elle ne rend plus un VERDICT.
//
// Elle en rendait un jusqu'au 12/09 — « prouvée », « cassée » — et Quentin a
// posé les deux questions auxquelles ce mot ne répondait pas : « quand c'est
// vert, ça veut dire que le runner fonctionne, ou juste que cocher les boutons
// fonctionne ? Et quand c'est rouge, c'est le test ou les boutons ? ». Deux
// colonnes, deux faits : ce que l'ÉCRAN a dit, ce que le MOTEUR a dit.
//
// Le rouge n'apparaît que sur une preuve qui a ÉCHOUÉ. Une absence est grise et
// DITE — la peindre en rouge enverrait chercher une panne là où personne n'a
// écrit de test, et la peindre en vert serait le mensonge qu'on répare ici.
const PASTILLE_NIVEAU = {
  passee: 'ok',
  echouee: 'ko',
  instable: 'moyen',
  ignoree: 'moyen',
  'jamais jouee': 'moyen',
  absente: 'inconnu',
};

/** Au-delà, la liste des tests devient un mur : le reste se replie. */
const TESTS_VISIBLES = 3;

function vueCapacites() {
  const reg = s.capacites?.registre ?? [];
  if (reg.length === 0) {
    return `<section id="capacites" class="vue">${entete('capacites', 'What the product can do')}
      <p class="chapo">No registry in this collection.</p></section>`;
  }
  // Une collecte antérieure aux niveaux écran/moteur n'a pas ces clés. Le
  // rendu plantait dessus — et `apps/qa build` sortait en erreur dans la CI
  // de toute PR, tant que la mesure nocturne n'avait pas réécrit les données.
  // On le DIT, on ne devine pas : deviner afficherait un registre faux.
  if (!reg[0]?.ecran || !reg[0]?.moteur) {
    return `<section id="capacites" class="vue">${entete('capacites', 'What the product can do')}
      <p class="chapo">This collection predates the screen / engine levels: its registry does not say at which level each capability is proven. The next measurement will replace it.</p></section>`;
  }

  const tombees = reg.filter((c) => c.ecran.etat === 'echouee' || c.moteur.etat === 'echouee');
  const sansMoteur = reg.filter((c) => c.moteur.etat === 'absente');
  const sansEcran = reg.filter((c) => c.ecran.etat === 'absente');
  const rien = reg.filter(
    (c) => c.ecran.etat === 'absente' && c.moteur.etat === 'absente' && c.nonDit.length === 0,
  );

  const domaines = [];
  for (const c of reg) {
    const d = domaines.find((x) => x.nom === c.domaine);
    if (d) d.capacites.push(c);
    else domaines.push({ nom: c.domaine, capacites: [c] });
  }

  /** Le nom court d'un test : le fichier, et le titre du cas quand on l'a. */
  const nomsDe = (preuves) => [
    ...new Set(
      preuves.map(
        (x) =>
          x.titre ||
          String(x.origine ?? '?')
            .split('/')
            .pop(),
      ),
    ),
  ];

  const cellule = (n) => {
    const mot = MOT_ETAT[n.etat];
    const cls = PASTILLE_NIVEAU[n.etat] ?? 'inconnu';
    if (n.etat === 'absente') {
      return `<td><span class="pastille pastille--${cls}">${esc(mot)}</span>
        <div class="dim petit">no test at this level</div></td>`;
    }
    const noms = nomsDe(n.preuves);
    const tete = noms.slice(0, TESTS_VISIBLES);
    const reste = noms.slice(TESTS_VISIBLES);
    // Seulement quand elle TOMBE : sur une preuve verte, le lien n'emmène
    // nulle part d'utile et ne ferait que du bruit.
    const cause = n.etat === 'echouee' ? ` ${lienRun(s.execution?.url)}` : '';
    return `<td><span class="pastille pastille--${cls}">${esc(mot)}</span>${cause}
      <div class="preuves">${tete.map((t) => `<div>${esc(t)}</div>`).join('')}${
        reste.length > 0
          ? `<details><summary>${reste.length} more</summary>${reste
              .map((t) => `<div>${esc(t)}</div>`)
              .join('')}</details>`
          : ''
      }</div></td>`;
  };

  const lignes = (caps) =>
    caps
      .map(
        (c) => `<tr>
        <td><b>${esc(c.nom)}</b>${c.exigee ? ' <span class="jeton">required</span>' : ''}<br>
          <span class="intention">${esc(c.question)}</span>
          <div class="phrase-cap">${esc(c.phrase)}</div>
          ${
            c.nonDit.length > 0
              ? `<div class="dim petit preuves"><details><summary>${
                  c.nonDit.length
                } label(s) with no level</summary>${nomsDe(c.nonDit)
                  .map((t) => `<div>${esc(t)}</div>`)
                  .join('')}</details></div>`
              : ''
          }
          ${
            c.ecran.etat === 'absente' && c.ecranAttendu
              ? `<div class="dim petit">What a screen test should check: ${esc(
                  c.ecranAttendu,
                )}</div>`
              : ''
          }
          ${
            c.moteur.etat === 'absente' && c.preuveAttendue
              ? `<div class="dim petit">What an engine test should check: ${esc(
                  c.preuveAttendue,
                )}</div>`
              : ''
          }</td>
        ${cellule(c.ecran)}
        ${cellule(c.moteur)}
      </tr>`,
      )
      .join('');

  return `
<section id="capacites" class="vue">
  ${entete('capacites', 'What the product can do')}
  <p class="chapo">The <b>screen</b> says the buttons chain together; the <b>engine</b> says the thing is done behind. A capability is only truly verified if both exist and pass.</p>

  ${repere('capacites', 'compteurs')}
  <div class="cartes">
    <article class="carte carte--phare ${tombees.length > 0 ? 'carte--alerte' : ''}">
      <h3>Failed proofs</h3>
      <p class="chiffre">${tombees.length}</p>
      <p class="sous">out of ${reg.length} named capabilities</p>
      <p class="avertissement">A test that proved them failed. This is the only card that talks about a fault.</p>
    </article>

    <article class="carte ${sansMoteur.length > 0 ? 'carte--alerte' : ''}">
      <h3>No engine proof</h3>
      <p class="chiffre">${sansMoteur.length}</p>
      <p class="sous">the façade may be checked, the engine is not</p>
    </article>

    <article class="carte">
      <h3>No screen proof</h3>
      <p class="chiffre">${sansEcran.length}</p>
      <p class="sous">nothing says a user can get there through the interface</p>
    </article>

    <article class="carte">
      <h3>No proof at all</h3>
      <p class="chiffre">${rien.length}</p>
      <p class="sous">neither screen nor engine, what we believe is shipped</p>
    </article>
  </div>
  ${repere('capacites', 'registre')}

  ${domaines
    .map(
      (d) => `
  <h3 class="sous-titre">${esc(d.nom)} <span class="compte">${d.capacites.length}</span></h3>
  <table class="tableau tableau--capacites">
    <thead><tr><th>Capability</th><th>Screen</th><th>Engine</th></tr></thead>
    <tbody>${lignes(d.capacites)}</tbody>
  </table>`,
    )
    .join('')}

  <p class="note-section">The label <code>@cap:&lt;slug&gt;/ecran</code> or <code>@cap:&lt;slug&gt;/moteur</code> goes in the title of a <code>describe</code> or of a test, and holds for every case it contains. <code>node apps/qa/porte.mjs</code> refuses a label that names nothing, and a required capability no test claims any more; a label with no level is flagged without blocking, for the duration of the transition.</p>
</section>`;
}

// Ce que le portail ne savait pas dire : « ce test a tourné 47 fois, échoué 3
// fois ». Une photo ne le sait jamais. L'instabilité, surtout, est indétectable
// dans une seule exécution — un test qui tombe un jour sur trois passe pour vert
// à chaque fois qu'il passe.
function ruban(recents) {
  const CLASSE = { v: 'ok', r: 'ko', i: 'inconnu', f: 'moyen' };
  return [...String(recents ?? '')]
    .map((c) => `<i class="grain grain--${CLASSE[c] ?? 'inconnu'}"></i>`)
    .join('');
}

function vueMemoire() {
  const m = s.memoire;
  if (!m || m.total === 0) {
    return `<section id="memoire" class="vue">${entete('memoire', 'Test memory')}
      <p class="chapo">No test tracked so far. The memory fills up at every measurement; it needs several runs before it can say anything useful.</p></section>`;
  }

  // `colonneJours` n'est posée que sur les cassés : l'âge d'un rouge ne veut
  // rien dire pour un test instable, qui est vert une fois sur deux.
  const lignes = (liste, colonneAge, colonneJours = false) =>
    liste
      .map((e) => {
        const jours = joursDepuis(e.rougeDepuis);
        return `<tr>
      <td><span class="intention">${esc(e.fichier ?? '')}</span><br><b>${esc(e.titre ?? e.cle)}</b>
        ${lienRun(e.dernierRougeExecution)}</td>
      <td class="mono">${ruban(e.recents)}</td>
      <td class="num">${e.echecs}/${e.tours}</td>
      <td class="num">${e.tauxEchec != null ? e.tauxEchec + ' %' : '·'}</td>
      <td>${esc(dateFr(colonneAge ? e.rougeDepuis : e.dernierTourLe))}</td>
      ${colonneJours ? `<td class="num ${jours != null && jours > 14 ? 'dette' : ''}">${jours != null ? `${jours} d` : '<span class="dim">flip never seen</span>'}</td>` : ''}
    </tr>`;
      })
      .join('');

  const casses = (m.casses ?? 0) > 0 ? (m.listeCasses ?? []) : [];
  // Écrit par la collecte, pas recalculé ici : le portail ne juge rien, il rend.
  const rep = m.reparations ?? { durees: [], mediane: null };

  return `
<section id="memoire" class="vue">
  ${entete('memoire', 'Test memory')}

  <div class="cartes">
    <article class="carte carte--phare ${m.instables > 0 ? 'carte--alerte' : ''}">
      <h3>Flaky tests</h3>
      <p class="chiffre">${m.instables}</p>
      <p class="sous">green AND red within their window</p>
      <p class="avertissement">A broken test gets repaired. A flaky test gets endured: no isolated run gives it away, it passes for green every time it passes.</p>
    </article>

    <article class="carte ${m.casses > 0 ? 'carte--alerte' : ''}">
      <h3>Broken tests</h3>
      <p class="chiffre">${m.casses}</p>
      <p class="sous">red at every known run</p>
    </article>

    <article class="carte">
      <h3>Tracked tests</h3>
      <p class="chiffre">${n(m.total)}</p>
      <p class="sous">${n(m.joues)} played at the last measurement</p>
    </article>

    <article class="carte">
      <h3>Repaired in (median)</h3>
      <p class="chiffre">${rep.mediane != null ? `${rep.mediane} <span class="sur">d</span>` : '·'}</p>
      <p class="sous">${
        rep.mediane != null
          ? `over ${rep.durees.length} repair(s) observed end to end`
          : 'no repair observed so far'
      }</p>
      ${
        rep.mediane == null
          ? `<p class="avertissement">A test has to be seen falling AND THEN turning green again for a duration to exist. None of the ${n(m.total)} tracked tests has made that trip under our eyes yet.</p>`
          : ''
      }
    </article>
  </div>

  ${
    (m.pires ?? []).length > 0
      ? `<h3 class="sous-titre">The most harmful <span class="compte">${m.pires.length}</span></h3>
  ${repere('memoire', 'nuisibles')}
  <p class="note-section">Sorted by failure rate. The ribbon reads left to right, oldest to newest.</p>
  <table class="tableau">
    <thead><tr><th>Test</th><th>Last runs</th><th>Failures</th><th>Rate</th><th>Red since</th></tr></thead>
    <tbody>${lignes(m.pires, true)}</tbody>
  </table>`
      : `<p class="note-section">No flaky test detected. That may be true, or the memory is still too short to see it: flakiness needs several runs before it shows, and it counts ${(m.pires ?? []).length === 0 && m.total > 0 ? 'few' : 'none'} so far.</p>`
  }
  ${casses.length > 0 ? `<h3 class="sous-titre">Broken</h3>${repere('memoire', 'casses')}<table class="tableau"><thead><tr><th>Test</th><th>Last runs</th><th>Failures</th><th>Rate</th><th>Red since</th><th class="num">Age</th></tr></thead><tbody>${lignes(casses, true, true)}</tbody></table>` : ''}
</section>`;
}

function vueEcarts() {
  const list = ecarts();
  return `
<section id="ecarts" class="vue">
  ${entete('ecarts', 'Gaps')}
  <ol class="ecarts">
    ${list
      .map(
        (e, i) => `<li class="ecart ecart--${e.gravite}">
      <span class="rang">${String(i + 1).padStart(2, '0')}</span>
      <div>
        <h3>${esc(e.titre)}</h3>
        <p>${esc(e.detail)}</p>
        ${e.quoi.length ? `<p class="quoi">${e.quoi.map((q) => `<span class="jeton mono">${esc(q)}</span>`).join(' ')}</p>` : ''}
      </div>
    </li>`,
      )
      .join('\n')}
  </ol>
</section>`;
}

// « Abandonné » est une colonne à part entière : sans elle, une PR fermée
// sans merge n'apparaîtrait NULLE PART — disparue du tableau sans trace.
const COLONNES = ['To do', 'In progress', 'In review', 'To test', 'Done', 'Abandoned'];

const TONS_ETIQUETTE = {
  decision: 'violet',
  security: 'rouge',
  test: 'bleu',
  debt: 'ambre',
  cost: 'vert',
  product: 'rose',
};

function vueChantiers() {
  const cartes = s.chantiers?.cartes ?? null;
  if (!cartes) {
    return `<section id="chantiers" class="vue actif">${entete('chantiers', 'Work in flight')}
      <div class="alerte">GitHub did not answer, the portal shows nothing rather than a stale list.</div></section>`;
  }

  const carte = (c) => {
    const etiquettes = (c.etiquettes ?? [])
      .map((e) => `<span class="etiq etiq--${TONS_ETIQUETTE[e] ?? 'gris'}">${esc(e)}</span>`)
      .join('');
    const ci =
      c.ci === 'vert'
        ? '<span class="pastille pastille--ok">CI green</span>'
        : c.ci === 'rouge'
          ? '<span class="pastille pastille--ko">CI red</span>'
          : c.ci === 'en cours'
            ? '<span class="pastille pastille--inconnu">CI running</span>'
            : '';
    return `<a class="ticket ticket--${c.type}" href="${esc(c.url)}" target="_blank" rel="noopener">
      <span class="ticket__tete"><span class="num-ticket">${c.type === 'pr' ? 'PR ' : ''}#${c.numero}</span>${c.brouillon ? '<span class="etiq etiq--gris">draft</span>' : ''}${c.parPr != null ? `<span class="etiq etiq--gris">PR #${Number(c.parPr)}</span>` : ''}${ci}</span>
      <span class="ticket__titre">${esc(c.titre)}</span>
      ${etiquettes ? `<span class="ticket__pied">${etiquettes}</span>` : ''}
    </a>`;
  };

  // « Fait » est borné : une colonne qui empile tout l'historique noie les
  // quatre autres, et ce n'est pas là qu'on regarde.
  const colonnes = COLONNES.map((nom) => {
    const dedans = cartes.filter((c) => c.colonne === nom);
    const montrees = nom === 'Done' || nom === 'Abandoned' ? dedans.slice(0, 8) : dedans;
    return `<section class="colonne">
      <header><h3>${esc(nom)}</h3><span class="compte">${dedans.length}</span></header>
      <div class="pile">
        ${montrees.length ? montrees.map(carte).join('') : '<p class="vide">Nothing here.</p>'}
        ${dedans.length > montrees.length ? `<p class="vide">+ ${dedans.length - montrees.length} more</p>` : ''}
      </div>
    </section>`;
  }).join('');

  const aFaire = cartes.filter((c) => c.colonne === 'To do').length;
  const enReview = cartes.filter((c) => c.colonne === 'In review').length;

  return `
<section id="chantiers" class="vue actif">
  ${entete('chantiers', 'Work in flight')}
  ${aFaire > 0 ? `<div class="rappel"><b>${aFaire} decision${aFaire > 1 ? 's' : ''} waiting on you</b>: they block the rest until they are settled.${enReview > 0 ? ` And ${enReview} pull request${enReview > 1 ? 's are' : ' is'} waiting for your merge.` : ''}</div>` : ''}
  <div class="kanban">${colonnes}</div>
</section>`;
}

function vueHistorique() {
  if (historique.length === 0) {
    return `<section id="historique" class="vue">${entete('historique', 'History')}
      <div class="alerte">No collection recorded.</div></section>`;
  }
  const derniers = historique.slice(-40);
  const max = Math.max(...derniers.map((h) => h.casDeTest ?? 0), 1);
  // Trente jours : assez pour voir une dérive, assez court pour qu'un chiffre
  // d'il y a trois mois ne fasse pas passer une baisse récente pour une hausse.
  const f = { jours: 30 };
  return `
<section id="historique" class="vue">
  ${entete('historique', 'History')}

  <h3 class="sous-titre">What moves</h3>
  ${repere('historique', 'courbes')}
  <div class="courbes">
    ${courbe(tendance(historique, 'couvertureLignes', f), {
      titre: 'Line coverage',
      libelle: 'line coverage as a percentage',
      fmt: (v) => `${v.toFixed(1)} %`,
    })}
    ${courbe(tendance(historique, 'capacitesVerifiees', f), {
      titre: 'Capabilities verified at both levels',
      libelle: 'capabilities whose screen proof AND engine proof passed',
      fmt: (v) => `${Math.round(v)}`,
    })}
    ${courbe(tendance(historique, 'testsCasses', f), {
      titre: 'Broken tests',
      libelle: 'number of tests red at each of their last runs',
      fmt: (v) => `${Math.round(v)}`,
    })}
  </div>

  <h3 class="sous-titre">Every collection</h3>
  <div class="sparkline" role="img" aria-label="change in the number of test cases over time">
    ${derniers.map((h) => `<i style="height:${Math.max(4, ((h.casDeTest ?? 0) / max) * 100).toFixed(1)}%" title="${esc(dateFr(h.le))} · ${n(h.casDeTest)} cases"></i>`).join('')}
  </div>
  <div class="tableau"><table>
    <thead><tr><th>When</th><th>Trigger</th><th>Commit</th><th class="num">Cases</th><th class="num">Journeys in CI</th><th class="num">Coverage</th></tr></thead>
    <tbody>${[...derniers]
      .reverse()
      .map(
        (
          h,
        ) => `<tr><td>${esc(dateFr(h.le))}</td><td><span class="jeton">${esc(h.declencheur)}</span></td>
        <td class="mono dim">${esc(h.commit ?? '·')}</td><td class="num">${n(h.casDeTest)}</td>
        <td class="num">${h.specsE2eJoueesParLaCi ?? '·'}/${h.specsE2e ?? '·'}</td>
        <td class="num">${pct(h.couvertureLignes) ?? '·'}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>
</section>`;
}

// ─── Le document ──────────────────────────────────────────────────────────────

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nodal-Agents, Quality</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{
  /* Homepage identity, same three signal colours the dashboard uses.
     The accent is the connector blue, NOT the orange-red of the homepage:
     on this portal orange-red already means "this is broken", and a page where
     the brand colour and the failure colour are the same colour cannot be
     read. So the flame carries the failure token, the lime carries the pass one,
     and the blue carries everything interactive. */
  --fond:#fbfbfa; --panneau:#ffffff; --panneau2:#f2f2ef; --barre:#111113;
  --encre:#111113; --encre2:#55555a; --encre3:#8a8a8f; --regle:rgba(17,17,19,.12);
  --accent:#2f5ae0; --accent-doux:rgba(47,90,224,.09);
  --ok:#4d7c0f; --ok-doux:rgba(77,124,15,.12);
  --ko:#e8471f; --ko-doux:rgba(232,71,31,.11);
  --moyen:#a8701c; --moyen-doux:rgba(168,112,28,.14);
  --inconnu:#8a8a8f;
  /* Flat on purpose: a box is defined by its hairline, never by a shadow. */
  --ombre:none;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --fond:#0b0b0d; --panneau:#141417; --panneau2:#1a1a1f; --barre:#0b0b0d;
  --encre:#f2f2ef; --encre2:#a0a0a4; --encre3:#7c7c81; --regle:rgba(255,255,255,.14);
  --accent:#6d8fff; --accent-doux:rgba(109,143,255,.14);
  --ok:#a3d61f; --ok-doux:rgba(163,214,31,.13);
  --ko:#ff6a48; --ko-doux:rgba(255,106,72,.14);
  --moyen:#dfa85c; --moyen-doux:rgba(223,168,92,.15);
  --inconnu:#7c7c81;
  --ombre:none;
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --fond:#0b0b0d; --panneau:#141417; --panneau2:#1a1a1f; --barre:#0b0b0d;
  --encre:#f2f2ef; --encre2:#a0a0a4; --encre3:#7c7c81; --regle:rgba(255,255,255,.14);
  --accent:#6d8fff; --accent-doux:rgba(109,143,255,.14);
  --ok:#a3d61f; --ok-doux:rgba(163,214,31,.13);
  --ko:#ff6a48; --ko-doux:rgba(255,106,72,.14);
  --moyen:#dfa85c; --moyen-doux:rgba(223,168,92,.15);
  --inconnu:#7c7c81;
  --ombre:none;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--fond);color:var(--encre2);
  font-family:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:Archivo,system-ui,sans-serif;color:var(--encre);letter-spacing:-.015em;text-wrap:balance;margin:0}
.mono,td.num,.chiffre{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
.grain{display:inline-block;width:7px;height:14px;margin-right:2px;border-radius:2px;vertical-align:middle}
.grain--ok{background:var(--ok)}
.grain--ko{background:var(--ko)}
.grain--moyen{background:var(--moyen)}
.grain--inconnu{background:var(--regle)}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* ── Charpente ──────────────────────────────────────────────────────────────
   Une barre laterale fixe, mais dans la grammaire de la homepage : meme fond
   que la page, un filet a droite, l'index numerote, des compteurs discrets.
   Rien de la colonne noire d'avant, sauf la position. Le contenu prend toute
   la largeur restante, ce dont le tableau de bord a besoin. */
.app{display:grid;grid-template-columns:256px minmax(0,1fr);min-height:100vh}
.rail{position:sticky;top:0;height:100vh;overflow-y:auto;
  border-right:1px solid var(--regle);padding:26px 20px 24px;
  display:flex;flex-direction:column;gap:30px}
.marque{display:flex;flex-direction:column;gap:3px;text-decoration:none;color:var(--encre)}
.marque b{font-family:Archivo,sans-serif;font-size:18px;font-weight:700;letter-spacing:-.02em;
  display:flex;align-items:center;gap:9px}
.marque b::before{content:'';width:10px;height:10px;border-radius:50%;background:#ff5631;flex:none}
.marque span{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--encre3);
  letter-spacing:.14em;padding-left:19px}

nav{display:flex;flex-direction:column;gap:1px;counter-reset:vue}
nav a{display:flex;align-items:baseline;gap:9px;padding:9px 10px 9px 12px;
  color:var(--encre2);text-decoration:none;font-size:15px;border-radius:3px;
  box-shadow:inset 2px 0 0 transparent}
nav>a{counter-increment:vue}
nav>a::before{content:counter(vue,decimal-leading-zero);font-family:"JetBrains Mono",monospace;
  font-size:10px;color:var(--encre3);letter-spacing:.04em}
nav>a.discret{counter-increment:none}
nav>a.discret::before{content:none;}
nav a b{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:11px;
  font-weight:400;color:var(--encre3)}
nav a:hover{color:var(--encre);background:var(--panneau2)}
nav a.actif{color:var(--encre);font-weight:600;box-shadow:inset 2px 0 0 #ff5631;background:var(--panneau2)}
nav a.actif::before,nav a.actif b{color:#ff5631}
nav .rubrique{margin:22px 0 4px;padding:14px 12px 0;font-family:"JetBrains Mono",monospace;
  font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--encre3);
  border-top:1px solid var(--regle)}
nav a.discret{font-size:14px;padding-left:12px;color:var(--encre3)}
nav a.discret:hover,nav a.discret.actif{color:var(--encre)}

.rail footer{margin-top:auto;font-family:"JetBrains Mono",monospace;font-size:11px;
  color:var(--encre3);line-height:1.8;padding-top:20px;border-top:1px solid var(--regle)}

.contenu{width:100%;padding:clamp(34px,4vw,56px) clamp(20px,3.2vw,48px) 110px}

/* ── Vues ── */
.vue{display:none}
.vue.actif{display:block}

/* L'en-tête d'une page : le rail numéroté de la homepage à gauche, le titre et
   sa raison d'être au centre, le bouton d'explication à droite. */
.entete-page{display:grid;grid-template-columns:168px minmax(0,1fr) auto;gap:clamp(20px,3vw,44px);
  align-items:start;margin-bottom:38px}
.rail-page{display:flex;flex-direction:column;gap:3px;padding-top:9px}
.rail-page__n{font-family:Archivo,sans-serif;font-size:13px;font-weight:700;color:#ff5631;letter-spacing:.06em}
.rail-page .mono{font-size:11px;color:var(--encre3);letter-spacing:.14em;text-transform:uppercase}
.titre-vue{font-size:clamp(28px,3.4vw,42px);font-weight:700;line-height:1.05;margin-bottom:12px}
.pourquoi{color:var(--encre2);font-size:16px;line-height:1.6;max-width:66ch;margin:0}
.chapo{color:var(--encre3);max-width:74ch;margin:0 0 30px;font-size:15px}
.sous-titre{font-size:14px;font-weight:600;margin:44px 0 8px;display:flex;align-items:center;gap:10px}
.compte{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--encre3)}
.note-section{color:var(--encre3);font-size:13px;margin:0 0 14px;max-width:80ch}
.btn-comprendre{background:transparent;color:var(--encre);border:1px solid var(--regle);
  border-radius:3px;padding:9px 16px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;
  white-space:nowrap}
.btn-comprendre:hover{border-color:var(--encre);background:var(--panneau2)}
.btn-comprendre:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.repere{color:var(--encre3);font-size:13px;margin:0 0 10px;max-width:80ch}
.modale{border:0;padding:0;background:transparent;max-width:none;max-height:none;width:100vw;height:100vh}
.modale::backdrop{background:rgba(0,0,0,.45)}
.modale__cadre{background:var(--fond);color:var(--encre);border:1px solid var(--regle);border-radius:6px;width:min(880px,calc(100vw - 32px));max-height:calc(100vh - 48px);margin:24px auto;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.28)}
.modale__tete{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 24px;border-bottom:1px solid var(--regle)}
.modale__tete h2{font-family:Archivo,sans-serif;font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0}
.modale__fermer{background:transparent;color:var(--encre2);border:1px solid var(--regle);border-radius:3px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}
.modale__corps{overflow:auto;padding:8px 24px 24px;font-size:15px;line-height:1.6}
.modale__partie{padding:22px 0;border-bottom:1px solid var(--regle)}
.modale__partie:last-child{border-bottom:0}
.modale__partie h3{font-family:"JetBrains Mono",monospace;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--encre3);margin:0 0 10px;font-weight:400}
.modale__partie p,.modale__partie li{color:var(--encre2);max-width:76ch}
.modale__partie ul{padding-left:20px;margin:8px 0}
.modale__partie li{margin:4px 0}
.modale__partie code{font-size:.92em}

/* ── Cartes ── */
/* 200px et non 215 : la Mémoire porte quatre cartes plus une en double largeur,
   soit cinq colonnes, à 215 la dernière tombait seule sur une deuxième ligne. */
.cartes{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1px;
  margin-bottom:10px;background:var(--regle);border:1px solid var(--regle);border-radius:6px;overflow:hidden}
.carte{background:var(--fond);padding:22px 22px 20px;display:flex;flex-direction:column;gap:7px}
.carte--phare{grid-column:span 2}
.carte--phare .chiffre{color:var(--accent)}
.carte--alerte .chiffre{color:var(--ko)}
.carte h3{font-size:11px;text-transform:uppercase;letter-spacing:.11em;color:var(--encre3);font-weight:500;order:2}
.chiffre{margin:0;font-family:Archivo,sans-serif;font-size:clamp(30px,3.4vw,40px);line-height:1;
  color:var(--encre);font-weight:700;letter-spacing:-.03em;order:1}
.chiffre .sur{font-size:21px;color:var(--encre3);font-weight:600}
.sous{margin:0;font-size:13px;color:var(--encre3);order:3}
.avertissement{margin:8px 0 0;font-size:12px;color:var(--encre3);border-top:1px solid var(--regle);padding-top:9px;order:4}


/* ── Jauge : trois états, dont « inconnu » ── */
.jauge{position:relative;height:20px;border-radius:4px;background:var(--panneau2);overflow:hidden;
  display:flex;align-items:center;min-width:120px}
.jauge i{position:absolute;inset:0 auto 0 0;display:block;border-radius:4px}
.jauge span{position:relative;z-index:1;font-family:"JetBrains Mono",monospace;font-size:11px;
  padding:0 8px;font-variant-numeric:tabular-nums}
.jauge--ok i{background:var(--ok-doux);border-right:2px solid var(--ok)}
.jauge--ok span{color:var(--ok)}
.jauge--moyen i{background:var(--moyen-doux);border-right:2px solid var(--moyen)}
.jauge--moyen span{color:var(--moyen)}
.jauge--faible i{background:var(--ko-doux);border-right:2px solid var(--ko)}
.jauge--faible span{color:var(--ko)}
.jauge--inconnue{background:repeating-linear-gradient(135deg,var(--panneau2),var(--panneau2) 5px,transparent 5px,transparent 10px)}
.jauge--inconnue span{color:var(--inconnu)}

/* ── Tableaux ── */
.tableau{overflow-x:auto;border-top:2px solid var(--encre)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.11em;color:var(--encre3);
  font-weight:500;padding:14px 16px 12px 0;border-bottom:1px solid var(--regle);background:var(--fond)}
th:last-child,td:last-child{padding-right:0}
td{padding:15px 16px 15px 0;border-bottom:1px solid var(--regle);vertical-align:top;line-height:1.5}
tr:last-child td{border-bottom:0}
.num{text-align:right}
.dim{color:var(--encre3)}
.intention{font-size:12px;color:var(--encre3);display:inline-block;margin-top:2px;max-width:62ch}
.intention--absente{font-style:italic;opacity:.65}

/* ── Pastilles et jetons ── */
.pastille{display:inline-block;font-family:"JetBrains Mono",monospace;font-size:11px;
  padding:2px 8px;border-radius:3px;white-space:nowrap}
.pastille--ok{background:var(--ok-doux);color:var(--ok)}
.pastille--ko{background:var(--ko-doux);color:var(--ko)}
.pastille--inconnu{background:var(--panneau2);color:var(--inconnu)}
.pastille--moyen{background:var(--moyen-doux);color:var(--moyen)}
.petit{font-size:11px;margin-top:3px}
.phrase-cap{font-size:12px;color:var(--encre2);margin-top:4px;font-variant-numeric:tabular-nums}
.tableau--capacites th:nth-child(2),.tableau--capacites th:nth-child(3),
.tableau--capacites td:nth-child(2),.tableau--capacites td:nth-child(3){width:23%;vertical-align:top}
.preuves{font-size:11px;color:var(--encre3);margin-top:4px;line-height:1.45;overflow-wrap:anywhere}
.preuves details{margin-top:2px}
.preuves summary{cursor:pointer;color:var(--encre3)}
.jeton{display:inline-block;font-size:11px;padding:1px 7px;border:1px solid var(--regle);
  border-radius:3px;color:var(--encre3);white-space:nowrap}

/* ── Écarts ── */
.ecarts{list-style:none;margin:0;padding:0;border-top:2px solid var(--encre)}
.ecart{display:grid;grid-template-columns:112px minmax(0,1fr);gap:24px;
  padding:22px 0;border-bottom:1px solid var(--regle)}
.rang{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.11em;text-transform:uppercase;
  color:var(--inconnu);padding-top:5px}
.ecart--haute .rang{color:var(--ko)}
.ecart--moyenne .rang{color:var(--moyen)}
.ecart--haute .rang{color:var(--ko)}
.ecart--moyenne .rang{color:var(--moyen)}
.ecart h3{font-family:Archivo,sans-serif;font-size:20px;font-weight:700;letter-spacing:-.015em;margin-bottom:6px}
.ecart p{margin:0;font-size:15px;max-width:82ch;color:var(--encre2)}
.quoi{margin-top:9px !important;display:flex;flex-wrap:wrap;gap:5px}

/* ── Banc et CI ── */
.grille-banc,.grille-ci{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));
  gap:clamp(22px,3vw,44px)}
.bloc-banc,.bloc-ci{border-top:2px solid var(--encre);padding-top:16px}
.bloc-banc header,.bloc-ci header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  margin-bottom:14px}
.bloc-banc h3,.bloc-ci h3{font-family:Archivo,sans-serif;font-size:17px;font-weight:700;letter-spacing:-.01em}
.bloc-banc dl{margin:0;display:grid;gap:5px}
.bloc-banc dl>div{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.bloc-banc dt{font-size:13px;color:var(--encre3)}
.bloc-banc dd{margin:0;font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--encre);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.unite{color:var(--encre3);font-size:11px}
.ligne-meta{margin:0 0 7px;font-size:13px;display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.ligne-meta b{color:var(--encre3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-right:3px}

/* ── Kanban ── */
.rappel{border-left:3px solid var(--accent);padding:2px 0 2px 18px;margin:0 0 30px;
  font-size:17px;color:var(--encre2);max-width:80ch}
.rappel b{color:var(--encre);font-weight:700;font-family:Archivo,sans-serif}
/* Le tableau prend TOUTE la largeur de la fenetre, pas celle de la colonne de
   texte : six colonnes de cartes ne se lisent pas dans 1220 px. Il sort donc de
   la gouttiere et se reprend sa propre marge, et sous 1180 px il defile
   horizontalement plutot que d'ecraser ses colonnes. */
.kanban{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:18px;
  align-items:start;padding-bottom:12px}
/* Sous 1180 px, six colonnes lisibles ne tiennent plus : le tableau defile
   plutot que d'ecraser ses cartes en bandes de texte. Lui seul defile, pas la
   page. */
/* Sous 1400 px, six colonnes lisibles ne tiennent plus a cote de la barre : le
   tableau defile, et lui seul. Il reprend la gouttiere du contenu pour que la
   premiere et la derniere carte soient a la meme distance du bord que le reste
   de la page. */
@media(max-width:1400px){
  .kanban{grid-template-columns:repeat(6,minmax(236px,1fr));overflow-x:auto;
    margin-inline:calc(clamp(20px,3.2vw,48px) * -1);padding-inline:clamp(20px,3.2vw,48px)}
}
.colonne{min-width:0}
.colonne header{display:flex;justify-content:space-between;align-items:baseline;
  gap:8px;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid var(--encre)}
.colonne h3{font-size:11px;text-transform:uppercase;letter-spacing:.11em;color:var(--encre)}
.pile{display:flex;flex-direction:column;gap:10px}
.ticket{display:flex;flex-direction:column;gap:9px;background:var(--panneau);
  border:1px solid var(--regle);border-radius:5px;padding:15px 16px 14px;
  text-decoration:none;color:var(--encre2);transition:border-color .15s ease}
.ticket:hover{border-color:var(--encre)}
.ticket--pr{box-shadow:inset 3px 0 0 var(--accent)}
.ticket__tete{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.ticket__titre{font-size:15px;line-height:1.4;color:var(--encre)}
.ticket__pied{display:flex;flex-wrap:wrap;gap:5px}
.num-ticket{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--encre3)}
.vide{font-size:13px;color:var(--encre3);margin:0;padding:6px 0}
.etiq{display:inline-block;font-size:10px;padding:1px 7px;border-radius:3px;
  border:1px solid transparent;white-space:nowrap}
.etiq--violet{background:rgba(124,92,220,.14);color:#7c5cdc;border-color:rgba(124,92,220,.3)}
.etiq--rouge{background:var(--ko-doux);color:var(--ko);border-color:var(--ko)}
.etiq--bleu{background:rgba(37,120,190,.14);color:#2578be;border-color:rgba(37,120,190,.3)}
.etiq--ambre{background:var(--moyen-doux);color:var(--moyen);border-color:var(--moyen)}
.etiq--vert{background:var(--ok-doux);color:var(--ok);border-color:var(--ok)}
.etiq--rose{background:rgba(198,70,140,.14);color:#c6468c;border-color:rgba(198,70,140,.3)}
.etiq--gris{background:var(--panneau2);color:var(--encre3);border-color:var(--regle)}

/* ── Divers ── */
.alerte{border-left:3px solid var(--ko);padding:2px 0 2px 18px;color:var(--encre2);
  font-size:16px;margin:0 0 26px;max-width:80ch}
.alerte b{color:var(--ko);font-weight:700}
/* Le prix d'une PR : le seul chiffre de cette page qui se subit tous les jours,
   donc en tête et en gros. La courbe reprend les conventions des autres. */
.prix{border-top:2px solid var(--encre);padding:16px 0 0;margin:0 0 30px}
.prix h3{margin:0 0 14px;font-family:Archivo,sans-serif;font-size:17px;font-weight:700;color:var(--encre);
  display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.prix h3 .dim{font-size:12px;font-weight:400}
.prix__chiffres{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px}
.prix__bloc{flex:1 1 130px;border-left:1px solid var(--regle);padding:2px 0 2px 16px;
  display:flex;flex-direction:column;gap:3px}
.prix__bloc:first-child{border-left:0;padding-left:0}
.prix__bloc--phare .prix__valeur{color:var(--accent)}
.prix__valeur{font-family:Archivo,sans-serif;font-size:26px;font-weight:700;letter-spacing:-.03em;
  color:var(--encre);font-variant-numeric:tabular-nums}
.prix__valeur--monte{color:var(--ko)}
.prix__valeur--descend{color:var(--ok)}
.prix__valeur--seule{color:var(--encre3)}
.prix__quoi{font-size:12px;color:var(--encre3)}
.prix--absent .avertissement{border-top:0;padding-top:0;font-size:13px}
.prix .courbe{border:0;padding:0;background:none;max-width:420px}
/* Ici, DESCENDRE est une bonne nouvelle — c'est moins d'attente. L'inverse des
   autres courbes du portail, où une baisse est une perte : les couleurs du
   résumé sont donc retournées, sinon une CI qui accélère s'affiche en rouge. */
.prix .courbe__resume--descend{color:var(--ok)}
.prix .courbe__resume--monte{color:var(--ko)}

/* « voir le run » : le chemin entre un rouge et ce que l'utilisateur aurait vu.
   Discret par défaut, il ne doit pas concurrencer le nom du test. */
.lien-run{display:inline-block;font-size:11px;margin-top:3px;color:var(--accent);
  text-decoration:none;border-bottom:1px dotted var(--accent)}
.lien-run:hover{border-bottom-style:solid}

/* Les courbes : SVG écrit à la main, couleurs par variables pour que les deux
   thèmes restent lisibles sans une seconde feuille de style. */
.courbes{display:grid;gap:14px;margin:0 0 18px}
@media (min-width:1100px){.courbes{grid-template-columns:repeat(3,1fr)}}
.courbe{border-top:1px solid var(--regle);padding:14px 0 0}
.courbe h4{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--encre);
  display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.courbe__resume{font-weight:500;font-size:12px;color:var(--encre2)}
.courbe__resume--monte{color:var(--ok)}
.courbe__resume--descend{color:var(--ko)}
.courbe__resume--seule{color:var(--encre3);font-style:italic}
.courbe__vide{margin:0;font-size:13px;color:var(--encre3)}
.courbe__trace{display:block;width:100%;height:auto;overflow:visible}
.courbe__axe{stroke:var(--regle);stroke-width:1}
.courbe__ligne{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.courbe__aire{fill:var(--accent-doux);stroke:none}
.courbe__point{fill:var(--accent);stroke:var(--panneau);stroke-width:2}
.courbe__graduation,.courbe__date{fill:var(--encre3);font-size:12px;font-family:inherit}
.courbe__valeur{fill:var(--encre);font-size:13px;font-weight:600;font-family:inherit}
.tendance{margin:6px 0 0;font-size:13px;color:var(--encre2)}
.tendance--monte{color:var(--ok)}
.tendance--descend{color:var(--ko)}
.tendance--seule{color:var(--encre3);font-style:italic}
/* Un rouge de plus de deux semaines : ce n'est plus une régression, c'est une dette. */
td.dette{color:var(--ko);font-weight:600}
.sparkline{display:flex;align-items:flex-end;gap:3px;height:80px;
  border-bottom:1px solid var(--regle);padding:12px 0;margin-bottom:22px}
.sparkline i{flex:1;min-width:3px;background:var(--accent-doux);border-top:2px solid var(--accent);border-radius:2px 2px 0 0}
@media(max-width:900px){
  .app{grid-template-columns:minmax(0,1fr)}
  .rail{position:static;height:auto;overflow:visible;border-right:0;
    border-bottom:1px solid var(--regle);gap:18px;padding:20px 16px}
  nav{flex-direction:row;flex-wrap:wrap;gap:2px}
  nav a{padding:8px 11px;box-shadow:none;border-bottom:2px solid transparent}
  nav a.actif{box-shadow:none;border-bottom-color:#ff5631;background:transparent}
  nav .rubrique{margin:0;align-self:center;padding:0 10px 0 14px;border-top:0;
    border-left:1px solid var(--regle)}
  .rail footer{margin-top:0;border-top:0;padding-top:0;line-height:1.6}
  .rail footer br{display:none}
  .entete-page{grid-template-columns:minmax(0,1fr);gap:14px}
  .rail-page{flex-direction:row;align-items:baseline;gap:10px;padding-top:0}
  .ecart{grid-template-columns:minmax(0,1fr);gap:8px}
}
@media(max-width:620px){
  .cartes{grid-template-columns:minmax(0,1fr)}
  .carte--phare{grid-column:span 1}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<div class="app">
  <aside class="rail">
    <a class="marque" href="#chantiers">
      <b>Quality</b>
      <span>NODAL-AGENTS</span>
    </a>
    <nav id="nav">
      <a href="#chantiers" class="actif">Work in flight <b>${(s.chantiers?.cartes ?? []).filter((c) => c.colonne !== 'Done').length}</b></a>
      <a href="#capacites">Capabilities <b>${
        (s.capacites?.registre ?? []).filter(
          (c) => c.ecran?.etat === 'echouee' || c.moteur?.etat === 'echouee',
        ).length
      }</b></a>
      <a href="#ecarts">Gaps <b>${ecarts().length}</b></a>
      <a href="#parcours">Journeys <b>${s.resume.specsE2eJoueesParLaCi}/${s.resume.specsE2e}</b></a>
      <a href="#memoire">Test memory <b>${(s.memoire?.instables ?? 0) + (s.memoire?.casses ?? 0)}</b></a>
      <p class="rubrique">How it runs</p>
      <a href="#vue" class="discret">Tests, overview</a>
      <a href="#banc" class="discret">Bench <b>${s.banc.sections.length}</b></a>
      <a href="#ci" class="discret">Triggers <b>${s.ci.length}</b></a>
      <a href="#historique" class="discret">History <b>${historique.length}</b></a>
    </nav>
    <footer>
      ${esc(s.branche ?? '')}<br>
      ${esc(s.commit ?? '')}<br>
      measured ${esc(dateFr(s.genereLe))}<br>
      board as of ${esc(dateFr(s.tableauLe ?? s.genereLe))}
    </footer>
  </aside>
  <main class="contenu">
    ${vueChantiers()}
    ${vueCapacites()}
    ${vueEnsemble()}
    ${vueEcarts()}
    ${vueParcours()}
    ${vueBanc()}
    ${vueCi()}
    ${vueMemoire()}
    ${vueHistorique()}
  </main>
</div>
${modaleExplications()}
<script>
(function(){
  var vues = document.querySelectorAll('.vue');
  var liens = document.querySelectorAll('#nav a');
  function montrer(id){
    var trouve = false;
    vues.forEach(function(v){ var ok = ('#'+v.id)===id; v.classList.toggle('actif', ok); if(ok) trouve = true; });
    if(!trouve){ vues[0].classList.add('actif'); id = '#'+vues[0].id; }
    liens.forEach(function(a){ a.classList.toggle('actif', a.getAttribute('href')===id); });
    window.scrollTo(0,0);
  }
  window.addEventListener('hashchange', function(){ montrer(location.hash); });
  montrer(location.hash || '#chantiers');

  // « Comprendre cette page » : une seule modale, remplie depuis les
  // explications embarquées. Un <dialog> natif du document, pas window.alert :
  // il se ferme à Échap, au clic sur le fond, ou au bouton.
  var modale = document.getElementById('explication');
  var titre = document.getElementById('explication-titre');
  var corps = document.getElementById('explication-corps');
  function ouvrir(id){
    var x = (window.__EXPLICATIONS || {})[id];
    if(!x || !modale) return;
    titre.textContent = x.titre;
    corps.innerHTML = x.parties.map(function(p){
      return '<section class="modale__partie"><h3>' + p.titre + '</h3>' + p.texte + '</section>';
    }).join('');
    modale.showModal();
    corps.scrollTop = 0;
  }
  document.querySelectorAll('[data-explique]').forEach(function(b){
    b.addEventListener('click', function(){ ouvrir(b.getAttribute('data-explique')); });
  });
  if(modale){
    modale.querySelector('[data-fermer]').addEventListener('click', function(){ modale.close(); });
    modale.addEventListener('click', function(e){ if(e.target === modale) modale.close(); });
  }
})();
</script>
</body>
</html>`;

if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), html);
console.log(`portal rendered → apps/qa/dist/index.html (${(html.length / 1024).toFixed(0)} KB)`);
