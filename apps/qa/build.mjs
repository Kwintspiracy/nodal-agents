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
import { ecartsDe, verdictDuBanc, tendance } from './lib.mjs';
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
const entete = (id, titre) => {
  const x = EXPLICATIONS[id];
  if (!x) throw new Error(`page sans explication : ${id}`);
  return `<div class="entete-page">
    <h2 class="titre-vue">${esc(titre)}</h2>
    <button type="button" class="btn-comprendre" data-explique="${id}">Comprendre cette page</button>
  </div>
  <p class="pourquoi">${esc(x.enBref)}</p>`;
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
      <button type="button" class="modale__fermer" data-fermer aria-label="Fermer">Fermer</button>
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
const n = (v) => (typeof v === 'number' ? v.toLocaleString('fr-FR') : '—');
const pct = (v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : null);
/** Le jour seul — sur un axe de courbe, l'heure d'une collecte n'apprend rien. */
const jourFr = (iso) =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '—';
const dateFr = (iso) =>
  iso
    ? new Date(iso).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

// ─── Écarts : la liste qui dit quoi faire, classée par ce que ça coûte ────────

// La liste vit dans `lib.mjs`, sous test : c'est elle qui décide de ce qu'on
// regarde en premier, et elle est passée d'un tas indifférencié à une hiérarchie
// déduite de faits (issue #65).
const ecarts = () => ecartsDe(s, historique);

// ─── Fragments ────────────────────────────────────────────────────────────────

function barre(valeur, libelle) {
  if (typeof valeur !== 'number') {
    return `<div class="jauge jauge--inconnue" role="img" aria-label="${esc(libelle)} : non mesuré"><span>non mesuré</span></div>`;
  }
  const ton = valeur >= 80 ? 'ok' : valeur >= 60 ? 'moyen' : 'faible';
  return `<div class="jauge jauge--${ton}" role="img" aria-label="${esc(libelle)} : ${valeur.toFixed(1)} %">
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
      <p class="courbe__vide">Aucune collecte mesurée sur la fenêtre. Rien à tracer — et rien n'est tracé.</p>
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
      ? 'une seule collecte, pas encore de tendance'
      : `${fleche} ${t.delta > 0 ? '+' : ''}${fmt(t.delta)} depuis le ${jourFr(pts[0].le)}`;

  return `<article class="courbe">
  <h4>${esc(titre)} <span class="courbe__resume courbe__resume--${t.direction ?? 'seule'}">${esc(resume)}</span></h4>
  <svg viewBox="0 0 ${W} ${H}" class="courbe__trace" role="img" aria-label="${esc(libelle)} : ${esc(resume)}">
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
      ? `Pas encore de tendance : ${tCouv.valeurs.length} collecte(s) mesurée(s) sur les 7 derniers jours, il en faut deux.`
      : tCouv.direction === 'stable'
        ? 'Stable sur 7 jours.'
        : `En ${tCouv.direction === 'monte' ? 'hausse' : 'baisse'} de ${Math.abs(tCouv.delta)} point(s) sur 7 jours.`;
  const couvert = pct(r.couvertureLignes);
  const partMesuree = r.paquets > 0 ? Math.round((r.paquetsMesures / r.paquets) * 100) : 0;
  const partJouee = r.specsE2e > 0 ? Math.round((r.specsE2eJoueesParLaCi / r.specsE2e) * 100) : 0;

  return `
<section id="vue" class="vue">
  ${entete('vue', "Tests — vue d'ensemble")}
  <p class="chapo">Ce que le dépôt sait de ses propres tests, mesuré — et ce qu'il ne sait pas encore, dit comme tel.</p>

  ${repere('vue', 'cartes')}
  <div class="cartes">
    <article class="carte carte--phare">
      <h3>Couverture réelle des lignes</h3>
      <p class="chiffre">${couvert ?? '—'}</p>
      <p class="sous">${n(r.lignesCouvertes)} lignes couvertes sur ${n(r.lignesTotal)}<br>
        <b>sur ${r.paquetsMesures} paquets mesurés / ${r.paquets}</b></p>
      ${barre(r.couvertureLignes, 'couverture des lignes')}
      <p class="tendance tendance--${tCouv.direction ?? 'seule'}">${esc(phraseCouv)}</p>
      <p class="avertissement">Ce chiffre ne vaut que pour la part mesurée. ${r.paquets - r.paquetsMesures} paquets n'ont jamais été instrumentés — ils ne sont ni comptés dans le numérateur ni dans le dénominateur.</p>
    </article>

    <article class="carte">
      <h3>Cas de test</h3>
      <p class="chiffre">${n(r.casDeTest)}</p>
      <p class="sous">dans ${n(r.fichiersDeTest)} fichiers, hors bout en bout</p>
    </article>

    <article class="carte ${partJouee < 50 ? 'carte--alerte' : ''}">
      <h3>Parcours joués par la CI</h3>
      <p class="chiffre">${r.specsE2eJoueesParLaCi} <span class="sur">/ ${r.specsE2e}</span></p>
      <p class="sous">${n(r.casE2e)} cas écrits · <b>${r.specsE2e - r.specsE2eJoueesParLaCi} parcours jamais exécutés</b></p>
      ${barre(partJouee, 'parcours joués')}
    </article>

    <article class="carte">
      <h3>Sections du banc</h3>
      <p class="chiffre">${s.banc.sections.length}</p>
      <p class="sous">${s.ci.some((w) => w.lanceBanc) ? 'lancé par la CI' : '<b>jamais lancé par la CI</b>'}</p>
    </article>
  </div>

  <h3 class="sous-titre">Couverture par paquet</h3>
  ${repere('vue', 'paquets')}
  <p class="note-section">Trié par nombre de lignes non couvertes : ce qui est en haut est ce qui coûte le plus à ignorer. Un paquet non mesuré est hachuré — il n'a pas zéro, il n'a rien.</p>
  <div class="tableau">
    <table>
      <thead><tr><th>Paquet</th><th>Cas</th><th class="num">Lignes</th><th style="min-width:180px">Couverture des lignes</th><th class="num">Branches</th></tr></thead>
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
              <td class="num dim">${p.couverture ? `${n(p.couverture.lignesCouvertes)}/${n(p.couverture.lignesTotal)}` : '—'}</td>
              <td>${barre(p.couverture?.lignes ?? null, p.nom)}</td>
              <td class="num dim">${p.couverture ? pct(p.couverture.branches) : '—'}</td>
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
    const c = p.cadence ?? 'jamais joué';
    parCadence.set(c, [...(parCadence.get(c) ?? []), p]);
  }
  const ORDRE = ['chaque PR', 'chaque push sur main', 'chaque nuit', 'à la main', 'jamais joué'];

  const ligne = (p) => {
    const r = p.resultat;
    let etat;
    if (!r) {
      etat = '<span class="pastille pastille--inconnu">jamais exécuté ici</span>';
    } else {
      // Quatre sorts, montrés SÉPARÉMENT. Un cas ignoré n'est pas un cas rouge :
      // les confondre, c'est le défaut que ce portail dénonce ailleurs.
      const bouts = [];
      if (r.vert)
        bouts.push(
          `<span class="pastille pastille--ok">${r.vert} vert${r.vert > 1 ? 's' : ''}</span>`,
        );
      if (r.rouge)
        bouts.push(
          `<span class="pastille pastille--ko">${r.rouge} rouge${r.rouge > 1 ? 's' : ''}</span>`,
        );
      if (r.instable)
        bouts.push(
          `<span class="pastille pastille--moyen">${r.instable} instable${r.instable > 1 ? 's' : ''}</span>`,
        );
      if (r['ignoré'])
        bouts.push(
          `<span class="pastille pastille--inconnu">${r['ignoré']} non exécuté${r['ignoré'] > 1 ? 's' : ''}</span>`,
        );
      etat = bouts.join(' ') || '<span class="pastille pastille--inconnu">rien à dire</span>';
    }
    return `<tr>
      <td><span class="mono">${esc(p.nom)}</span>${p.intention ? `<br><span class="intention">${esc(p.intention)}</span>` : ''}</td>
      <td class="num">${p.cas}</td>
      <td>${etat}</td>
      <td class="num dim">${r?.dureeMs ? `${(r.dureeMs / 1000).toFixed(1)} s` : '—'}</td>
    </tr>`;
  };

  const bloc = (cadence) => {
    const dedans = parCadence.get(cadence);
    if (!dedans || dedans.length === 0) return '';
    const note =
      cadence === 'chaque PR'
        ? 'Ceux-là BLOQUENT une régression avant le merge.'
        : cadence === 'chaque nuit'
          ? 'Ceux-là la CONSTATENT le lendemain. Ils ne gardent aucune PR.'
          : cadence === 'jamais joué'
            ? 'Écrits, versionnés, et qu’aucune intégration continue n’exécute.'
            : '';
    return `<h3 class="sous-titre">${esc(cadence)} <span class="compte">${dedans.length}</span></h3>
      ${note ? `<p class="note-section">${note}</p>` : ''}
      <div class="tableau"><table>
        <thead><tr><th>Parcours</th><th class="num">Cas</th><th style="min-width:230px">Dernier résultat</th><th class="num">Durée</th></tr></thead>
        <tbody>${dedans.map(ligne).join('\n')}</tbody>
      </table></div>`;
  };

  const bloque = (parCadence.get('chaque PR') ?? []).length;
  return `
<section id="parcours" class="vue">
  ${entete('parcours', 'Parcours')}
  <p class="chapo">Les scénarios bout en bout : ce qu'un utilisateur fait réellement. ${s.parcours.length} versionnés, et <b>${bloque} seulement gardent une PR</b> — les autres constatent après coup, ou jamais.</p>
  ${repere('parcours', 'cadence')}
  ${ORDRE.map(bloc).join('\n')}
</section>`;
}

function vueBanc() {
  return `
<section id="banc" class="vue">
  ${entete('banc', "Banc d'essai")}
  <p class="chapo">Le banc ne répond pas « est-ce cassé ? » mais « qu'est-ce qui a CHANGÉ, et de combien ». Chaque section porte une baseline acceptée ; un écart fait sortir la commande en erreur.</p>
  ${
    s.ci.some((w) => w.lanceBanc)
      ? ''
      : `<div class="alerte"><b>Aucun workflow ne le lance.</b> Le banc peut détecter une régression et le dire ; il reste muet tant que rien ne l'exécute.</div>`
  }
  ${(() => {
    // Le verdict du DERNIER passage, et pas seulement les baselines acceptées.
    // Le banc détectait les régressions, les écrivait, et personne ne les lisait
    // — la vue ne montrait que ce qui avait été validé un jour.
    const v = verdictDuBanc(s.banc?.dernierRun);
    if (v.absent) {
      return `<div class="alerte"><b>Aucun passage enregistré.</b> Les valeurs ci-dessous sont les baselines ACCEPTÉES, pas une mesure du jour. Absent n'est pas « rien n'a bougé ».</div>`;
    }
    if (v.regressions.length === 0 && v.erreurs.length === 0) {
      return `<p class="note-section">Dernier passage le ${esc(dateFr(v.mesureLe))} — aucune régression, aucune section en panne.</p>`;
    }
    const bouts = [];
    if (v.regressions.length > 0) {
      bouts.push(
        `<b>${v.regressions.length} section(s) ont régressé :</b> ${v.regressions.map(esc).join(', ')}`,
      );
    }
    if (v.erreurs.length > 0) {
      bouts.push(
        `<b>${v.erreurs.length} section(s) n'ont pas pu tourner :</b> ${v.erreurs.map(esc).join(', ')} — une panne, pas un ralentissement`,
      );
    }
    return `<div class="alerte">${bouts.join('<br>')}<br><span class="dim">Passage du ${esc(dateFr(v.mesureLe))}.</span></div>`;
  })()}
  ${repere('banc', 'sections')}
  <div class="grille-banc">
    ${s.banc.sections
      .map(
        (b) => `<article class="bloc-banc">
        <header><h3 class="mono">${esc(b.id)}</h3><span class="dim mono">réf. ${esc((b.gitSha ?? '').slice(0, 7))}</span></header>
        <dl>${b.metriques
          .map(
            (m) =>
              `<div><dt>${esc(m.label)}</dt><dd>${n(m.valeur)} <span class="unite">${esc(m.unite ?? '')}</span></dd></div>`,
          )
          .join('')}</dl>
        <p class="dim">acceptée le ${dateFr(b.accepteeLe)}</p>
      </article>`,
      )
      .join('\n')}
  </div>
</section>`;
}

function vueCi() {
  return `
<section id="ci" class="vue">
  ${entete('ci', 'Ce qui déclenche quoi')}
  <p class="chapo">Lu dans les fichiers de workflow, pas dans une intention. C'est la réponse à « qu'est-ce qui lance les tests, et quand ».</p>
  <div class="grille-ci">
    ${s.ci
      .map(
        (w) => `<article class="bloc-ci">
      <header><h3>${esc(w.nom)}</h3><span class="dim mono">${esc(w.fichier)}</span></header>
      <p class="ligne-meta"><b>Déclencheurs</b> ${w.declencheurs.length ? w.declencheurs.map((d) => `<span class="jeton">${esc(d)}</span>`).join(' ') : '<span class="dim">aucun</span>'}</p>
      <p class="ligne-meta"><b>Jobs</b> ${w.jobs.map((j) => `<span class="jeton">${esc(j)}</span>`).join(' ')}</p>
      <p class="ligne-meta"><b>Banc</b> ${w.lanceBanc ? '<span class="pastille pastille--ok">lancé</span>' : '<span class="pastille pastille--ko">non lancé</span>'}
         &nbsp;<b>Couverture</b> ${w.lanceCouverture ? '<span class="pastille pastille--ok">mesurée</span>' : '<span class="pastille pastille--ko">non mesurée</span>'}</p>
      ${w.specsNommees.length ? `<p class="ligne-meta"><b>Parcours joués</b> ${w.specsNommees.map((x) => `<span class="jeton mono">${esc(x)}</span>`).join(' ')}</p>` : ''}
    </article>`,
      )
      .join('\n')}
  </div>
</section>`;
}

// La seule vue qui parle du PRODUIT. Toutes les autres parlent du dépôt :
// « @nodal-agents/web à 78 % » ne dit rien à personne. Ici la ligne est une
// phrase qu'un humain reconnaît, et la colonne qui compte est la dernière —
// celle de ce que personne n'a jamais prouvé.
const PASTILLE_CAPACITE = {
  prouvée: 'ok',
  rouge: 'ko',
  instable: 'moyen',
  'non jouée': 'moyen',
  'jamais prouvée': 'inconnu',
};

function vueCapacites() {
  const reg = s.capacites?.registre ?? [];
  if (reg.length === 0) {
    return `<section id="capacites" class="vue">${entete('capacites', 'Ce que le produit sait faire')}
      <p class="chapo">Aucun registre dans cette collecte.</p></section>`;
  }

  const prouvees = reg.filter((c) => c.etat === 'prouvée').length;
  const jamais = reg.filter((c) => c.etat === 'jamais prouvée');
  const dorment = reg.filter((c) => c.etat === 'non jouée');
  const cassees = reg.filter((c) => c.etat === 'rouge' || c.etat === 'instable');

  const domaines = [];
  for (const c of reg) {
    const d = domaines.find((x) => x.nom === c.domaine);
    if (d) d.capacites.push(c);
    else domaines.push({ nom: c.domaine, capacites: [c] });
  }

  const lignes = (caps) =>
    caps
      .map((c) => {
        const cls = PASTILLE_CAPACITE[c.etat] ?? 'inconnu';
        const preuves =
          c.preuves.length === 0
            ? '<span class="dim">personne</span>'
            : [...new Set(c.preuves.map((p) => p.origine.split('/').pop()))]
                .map((f) => `<span class="jeton">${esc(f)}</span>`)
                .join(' ');
        return `<tr>
        <td><b>${esc(c.nom)}</b>${c.exigee ? ' <span class="jeton">exigée</span>' : ''}<br>
          <span class="intention">${esc(c.question)}</span></td>
        <td><span class="pastille pastille--${cls}">${esc(c.etat)}</span></td>
        <td>${preuves}</td>
      </tr>`;
      })
      .join('');

  return `
<section id="capacites" class="vue">
  ${entete('capacites', 'Ce que le produit sait faire')}
  <p class="chapo">Une ligne par capacité, et ce qui la prouve. La question n'est pas « quel pourcentage de <code>apps/web</code> est couvert » mais « un utilisateur peut-il connecter Notion ce matin, et qu'est-ce qui le montre ».</p>

  ${repere('capacites', 'compteurs')}
  <div class="cartes">
    <article class="carte carte--phare ${jamais.length > 0 ? 'carte--alerte' : ''}">
      <h3>Jamais prouvées</h3>
      <p class="chiffre">${jamais.length}</p>
      <p class="sous">sur ${reg.length} capacités nommées</p>
      <p class="avertissement">Aucun test ne les revendique. C'est la liste de ce qu'on croit livré.</p>
    </article>

    <article class="carte">
      <h3>Prouvées</h3>
      <p class="chiffre">${prouvees}</p>
      <p class="sous">un test vert les tient</p>
    </article>

    <article class="carte ${dorment.length > 0 ? 'carte--alerte' : ''}">
      <h3>La preuve dort</h3>
      <p class="chiffre">${dorment.length}</p>
      <p class="sous">un test les revendique, il n'a pas tourné</p>
    </article>

    <article class="carte ${cassees.length > 0 ? 'carte--alerte' : ''}">
      <h3>Cassées</h3>
      <p class="chiffre">${cassees.length}</p>
      <p class="sous">le test qui les tient échoue</p>
    </article>
  </div>
  ${repere('capacites', 'registre')}

  ${domaines
    .map(
      (d) => `
  <h3 class="sous-titre">${esc(d.nom)} <span class="compte">${d.capacites.length}</span></h3>
  <table class="tableau">
    <thead><tr><th>Capacité</th><th>État</th><th>Ce qui la prouve</th></tr></thead>
    <tbody>${lignes(d.capacites)}</tbody>
  </table>`,
    )
    .join('')}

  <p class="note-section">L'étiquette <code>@cap:</code> se pose dans le titre d'un <code>describe</code> ou d'un test, et vaut pour tous les cas qu'il contient. <code>node apps/qa/porte.mjs</code> refuse une étiquette qui ne désigne rien, et une capacité exigée que plus aucun test ne revendique.</p>
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
    return `<section id="memoire" class="vue">${entete('memoire', 'Mémoire des tests')}
      <p class="chapo">Aucun test suivi pour l'instant. La mémoire se remplit à chaque mesure ; elle a besoin de plusieurs passages avant de savoir dire quoi que ce soit d'utile.</p></section>`;
  }

  // `colonneJours` n'est posée que sur les cassés : l'âge d'un rouge ne veut
  // rien dire pour un test instable, qui est vert une fois sur deux.
  const lignes = (liste, colonneAge, colonneJours = false) =>
    liste
      .map((e) => {
        const jours = joursDepuis(e.rougeDepuis);
        return `<tr>
      <td><span class="intention">${esc(e.fichier ?? '')}</span><br><b>${esc(e.titre ?? e.cle)}</b></td>
      <td class="mono">${ruban(e.recents)}</td>
      <td class="num">${e.echecs}/${e.tours}</td>
      <td class="num">${e.tauxEchec != null ? e.tauxEchec + ' %' : '—'}</td>
      <td>${esc(dateFr(colonneAge ? e.rougeDepuis : e.dernierTourLe))}</td>
      ${colonneJours ? `<td class="num ${jours != null && jours > 14 ? 'dette' : ''}">${jours != null ? `${jours} j` : '<span class="dim">bascule jamais vue</span>'}</td>` : ''}
    </tr>`;
      })
      .join('');

  const casses = (m.casses ?? 0) > 0 ? (m.listeCasses ?? []) : [];
  // Écrit par la collecte, pas recalculé ici : le portail ne juge rien, il rend.
  const rep = m.reparations ?? { durees: [], mediane: null };

  return `
<section id="memoire" class="vue">
  ${entete('memoire', 'Mémoire des tests')}
  <p class="chapo">Un enregistrement par test, pas par exécution. C'est la seule forme qui sache répondre « combien de fois ça tourne, et combien de fois ça tombe ».</p>

  <div class="cartes">
    <article class="carte carte--phare ${m.instables > 0 ? 'carte--alerte' : ''}">
      <h3>Tests instables</h3>
      <p class="chiffre">${m.instables}</p>
      <p class="sous">verts ET rouges dans leur fenêtre</p>
      <p class="avertissement">Un test cassé se répare. Un test instable se subit : aucune exécution isolée ne le dénonce, il passe pour vert chaque fois qu'il passe.</p>
    </article>

    <article class="carte ${m.casses > 0 ? 'carte--alerte' : ''}">
      <h3>Tests cassés</h3>
      <p class="chiffre">${m.casses}</p>
      <p class="sous">rouges à chaque tour connu</p>
    </article>

    <article class="carte">
      <h3>Tests suivis</h3>
      <p class="chiffre">${n(m.total)}</p>
      <p class="sous">${n(m.joues)} joués lors de la dernière mesure</p>
    </article>

    <article class="carte">
      <h3>Réparé en (médiane)</h3>
      <p class="chiffre">${rep.mediane != null ? `${rep.mediane} <span class="sur">j</span>` : '—'}</p>
      <p class="sous">${
        rep.mediane != null
          ? `sur ${rep.durees.length} réparation(s) observée(s) de bout en bout`
          : "aucune réparation observée pour l'instant"
      }</p>
      ${
        rep.mediane == null
          ? `<p class="avertissement">Il faut avoir vu un test tomber PUIS repasser au vert pour mesurer une durée. Aucun des ${n(m.total)} tests suivis n'a encore fait ce chemin sous nos yeux.</p>`
          : ''
      }
    </article>
  </div>

  ${
    (m.pires ?? []).length > 0
      ? `<h3 class="sous-titre">Les plus nuisibles <span class="compte">${m.pires.length}</span></h3>
  ${repere('memoire', 'nuisibles')}
  <p class="note-section">Triés par taux d'échec. Le ruban se lit de gauche à droite, du plus ancien au plus récent.</p>
  <table class="tableau">
    <thead><tr><th>Test</th><th>Derniers tours</th><th>Échecs</th><th>Taux</th><th>Rouge depuis</th></tr></thead>
    <tbody>${lignes(m.pires, true)}</tbody>
  </table>`
      : `<p class="note-section">Aucun test instable détecté. C'est peut-être vrai — ou la mémoire est encore trop courte pour le voir : l'instabilité demande plusieurs passages avant d'apparaître, et elle en compte ${(m.pires ?? []).length === 0 && m.total > 0 ? 'peu' : 'aucun'} pour l'instant.</p>`
  }
  ${casses.length > 0 ? `<h3 class="sous-titre">Cassés</h3>${repere('memoire', 'casses')}<table class="tableau"><thead><tr><th>Test</th><th>Derniers tours</th><th>Échecs</th><th>Taux</th><th>Rouge depuis</th><th class="num">Âge</th></tr></thead><tbody>${lignes(casses, true, true)}</tbody></table>` : ''}
</section>`;
}

function vueEcarts() {
  const list = ecarts();
  return `
<section id="ecarts" class="vue">
  ${entete('ecarts', 'Écarts')}
  <p class="chapo">Ce que la mesure d'aujourd'hui reproche au dépôt, classé par ce que ça coûte de l'ignorer. Cette liste est calculée, pas rédigée : elle change quand le dépôt change.</p>
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
const COLONNES = ['À faire', 'En cours', 'En review', 'À tester', 'Fait', 'Abandonné'];

const TONS_ETIQUETTE = {
  décision: 'violet',
  sécurité: 'rouge',
  test: 'bleu',
  dette: 'ambre',
  coût: 'vert',
  produit: 'rose',
};

function vueChantiers() {
  const cartes = s.chantiers?.cartes ?? null;
  if (!cartes) {
    return `<section id="chantiers" class="vue actif">${entete('chantiers', 'Chantiers')}
      <div class="alerte">GitHub n'a pas répondu — le portail ne montre rien plutôt qu'une liste périmée.</div></section>`;
  }

  const carte = (c) => {
    const etiquettes = (c.etiquettes ?? [])
      .map((e) => `<span class="etiq etiq--${TONS_ETIQUETTE[e] ?? 'gris'}">${esc(e)}</span>`)
      .join('');
    const ci =
      c.ci === 'vert'
        ? '<span class="pastille pastille--ok">CI verte</span>'
        : c.ci === 'rouge'
          ? '<span class="pastille pastille--ko">CI rouge</span>'
          : c.ci === 'en cours'
            ? '<span class="pastille pastille--inconnu">CI en cours</span>'
            : '';
    return `<a class="ticket ticket--${c.type}" href="${esc(c.url)}" target="_blank" rel="noopener">
      <span class="ticket__tete"><span class="num-ticket">${c.type === 'pr' ? 'PR ' : ''}#${c.numero}</span>${c.brouillon ? '<span class="etiq etiq--gris">brouillon</span>' : ''}${ci}</span>
      <span class="ticket__titre">${esc(c.titre)}</span>
      ${etiquettes ? `<span class="ticket__pied">${etiquettes}</span>` : ''}
    </a>`;
  };

  // « Fait » est borné : une colonne qui empile tout l'historique noie les
  // quatre autres, et ce n'est pas là qu'on regarde.
  const colonnes = COLONNES.map((nom) => {
    const dedans = cartes.filter((c) => c.colonne === nom);
    const montrees = nom === 'Fait' || nom === 'Abandonné' ? dedans.slice(0, 8) : dedans;
    return `<section class="colonne">
      <header><h3>${esc(nom)}</h3><span class="compte">${dedans.length}</span></header>
      <div class="pile">
        ${montrees.length ? montrees.map(carte).join('') : '<p class="vide">Rien ici.</p>'}
        ${dedans.length > montrees.length ? `<p class="vide">+ ${dedans.length - montrees.length} de plus</p>` : ''}
      </div>
    </section>`;
  }).join('');

  const aFaire = cartes.filter((c) => c.colonne === 'À faire').length;
  const enReview = cartes.filter((c) => c.colonne === 'En review').length;

  return `
<section id="chantiers" class="vue actif">
  ${entete('chantiers', 'Chantiers')}
  <p class="chapo">Le travail en cours, lu depuis GitHub. Les colonnes sont DÉDUITES — une PR ouverte est en review, une issue fermée est faite, une décision attend Quentin. Rien ne se range à la main, donc rien ne peut mentir par oubli.</p>
  ${aFaire > 0 ? `<div class="rappel"><b>${aFaire} décision${aFaire > 1 ? 's' : ''} t'attend${aFaire > 1 ? 'ent' : ''}</b> — elles bloquent le reste tant qu'elles ne sont pas tranchées.${enReview > 0 ? ` Et ${enReview} PR ${enReview > 1 ? 'attendent' : 'attend'} ton merge.` : ''}</div>` : ''}
  <div class="kanban">${colonnes}</div>
</section>`;
}

function vueHistorique() {
  if (historique.length === 0) {
    return `<section id="historique" class="vue">${entete('historique', 'Historique')}
      <div class="alerte">Aucune collecte enregistrée.</div></section>`;
  }
  const derniers = historique.slice(-40);
  const max = Math.max(...derniers.map((h) => h.casDeTest ?? 0), 1);
  // Trente jours : assez pour voir une dérive, assez court pour qu'un chiffre
  // d'il y a trois mois ne fasse pas passer une baisse récente pour une hausse.
  const f = { jours: 30 };
  return `
<section id="historique" class="vue">
  ${entete('historique', 'Historique')}
  <p class="chapo">Une ligne par collecte. C'est cet historique — et lui seul — qui rendra répondables « combien de fois ça tourne » et « à quelle régularité ». Il commence aujourd'hui.</p>

  <h3 class="sous-titre">Ce qui bouge</h3>
  ${repere('historique', 'courbes')}
  <div class="courbes">
    ${courbe(tendance(historique, 'couvertureLignes', f), {
      titre: 'Couverture des lignes',
      libelle: 'couverture des lignes en pourcentage',
      fmt: (v) => `${v.toFixed(1)} %`,
    })}
    ${courbe(tendance(historique, 'capacitesProuvees', f), {
      titre: 'Capacités prouvées',
      libelle: 'capacités du produit prouvées par un test joué',
      fmt: (v) => `${Math.round(v)}`,
    })}
    ${courbe(tendance(historique, 'testsCasses', f), {
      titre: 'Tests cassés',
      libelle: 'nombre de tests rouges à chacun de leurs derniers passages',
      fmt: (v) => `${Math.round(v)}`,
    })}
  </div>

  <h3 class="sous-titre">Chaque collecte</h3>
  <div class="sparkline" role="img" aria-label="évolution du nombre de cas de test">
    ${derniers.map((h) => `<i style="height:${Math.max(4, ((h.casDeTest ?? 0) / max) * 100).toFixed(1)}%" title="${esc(dateFr(h.le))} — ${n(h.casDeTest)} cas"></i>`).join('')}
  </div>
  <div class="tableau"><table>
    <thead><tr><th>Quand</th><th>Déclencheur</th><th>Commit</th><th class="num">Cas</th><th class="num">Parcours en CI</th><th class="num">Couverture</th></tr></thead>
    <tbody>${[...derniers]
      .reverse()
      .map(
        (
          h,
        ) => `<tr><td>${esc(dateFr(h.le))}</td><td><span class="jeton">${esc(h.declencheur)}</span></td>
        <td class="mono dim">${esc(h.commit ?? '—')}</td><td class="num">${n(h.casDeTest)}</td>
        <td class="num">${h.specsE2eJoueesParLaCi ?? '—'}/${h.specsE2e ?? '—'}</td>
        <td class="num">${pct(h.couvertureLignes) ?? '—'}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>
</section>`;
}

// ─── Le document ──────────────────────────────────────────────────────────────

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nodal-Agents — Qualité</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{
  --fond:#f1f2f0; --panneau:#ffffff; --panneau2:#e9ebe8; --barre:#16191c;
  --encre:#14181b; --encre2:#4b5459; --encre3:#7b858a; --regle:#dcdfdb;
  --accent:#1c6b5e; --accent-doux:rgba(28,107,94,.12);
  --ok:#2c7a4b; --ok-doux:rgba(44,122,75,.14);
  --ko:#a8372f; --ko-doux:rgba(168,55,47,.13);
  --moyen:#a8701c; --moyen-doux:rgba(168,112,28,.14);
  --inconnu:#8b9599;
  --ombre:0 1px 2px rgba(20,24,27,.05), 0 10px 30px -18px rgba(20,24,27,.3);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --fond:#101315; --panneau:#181c1f; --panneau2:#212629; --barre:#0b0d0f;
  --encre:#e9ecea; --encre2:#a9b2b6; --encre3:#778085; --regle:#2a3033;
  --accent:#5cbfae; --accent-doux:rgba(92,191,174,.16);
  --ok:#6fc08c; --ok-doux:rgba(111,192,140,.15);
  --ko:#e08278; --ko-doux:rgba(224,130,120,.15);
  --moyen:#dfa85c; --moyen-doux:rgba(223,168,92,.15);
  --inconnu:#6b7478;
  --ombre:0 1px 2px rgba(0,0,0,.4), 0 10px 30px -18px rgba(0,0,0,.8);
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --fond:#101315; --panneau:#181c1f; --panneau2:#212629; --barre:#0b0d0f;
  --encre:#e9ecea; --encre2:#a9b2b6; --encre3:#778085; --regle:#2a3033;
  --accent:#5cbfae; --accent-doux:rgba(92,191,174,.16);
  --ok:#6fc08c; --ok-doux:rgba(111,192,140,.15);
  --ko:#e08278; --ko-doux:rgba(224,130,120,.15);
  --moyen:#dfa85c; --moyen-doux:rgba(223,168,92,.15);
  --inconnu:#6b7478;
  --ombre:0 1px 2px rgba(0,0,0,.4), 0 10px 30px -18px rgba(0,0,0,.8);
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--fond);color:var(--encre2);
  font-family:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:14.5px;line-height:1.6;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:Archivo,system-ui,sans-serif;color:var(--encre);letter-spacing:-.015em;text-wrap:balance;margin:0}
.mono,td.num,.chiffre{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
.grain{display:inline-block;width:7px;height:14px;margin-right:2px;border-radius:2px;vertical-align:middle}
.grain--ok{background:var(--ok)}
.grain--ko{background:var(--ko)}
.grain--moyen{background:var(--moyen)}
.grain--inconnu{background:var(--regle)}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* ── Charpente ── */
.app{display:grid;grid-template-columns:236px 1fr;min-height:100vh}
.rail{background:var(--barre);color:#c9d1d4;padding:22px 16px;position:sticky;top:0;height:100vh;
  display:flex;flex-direction:column;gap:26px;overflow-y:auto}
.marque{display:flex;flex-direction:column;gap:2px}
.marque b{font-family:Archivo,sans-serif;font-size:15px;color:#fff;font-weight:700;letter-spacing:-.01em}
.marque span{font-family:"JetBrains Mono",monospace;font-size:10.5px;color:#7d878b;letter-spacing:.04em}
nav{display:flex;flex-direction:column;gap:2px}
nav a{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 11px;border-radius:7px;color:#c9d1d4;text-decoration:none;font-size:13.5px}
nav a:hover{background:rgba(255,255,255,.06);color:#fff}
nav a.actif{background:var(--accent);color:#fff;font-weight:600}
nav a b{font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:500;opacity:.8}
.rail footer{margin-top:auto;font-family:"JetBrains Mono",monospace;font-size:10.5px;color:#6d7679;line-height:1.7}
.contenu{padding:34px 34px 90px;max-width:1220px}

/* ── Vues ── */
.vue{display:none}
.vue.actif{display:block}
.titre-vue{font-size:27px;font-weight:700;margin-bottom:6px}
.chapo{color:var(--encre3);max-width:74ch;margin:0 0 26px;font-size:15px}
.sous-titre{font-size:14px;font-weight:600;margin:34px 0 6px;display:flex;align-items:center;gap:10px}
.compte{font-family:"JetBrains Mono",monospace;font-size:11.5px;color:var(--encre3);
  background:var(--panneau2);padding:1px 8px;border-radius:99px}
.note-section{color:var(--encre3);font-size:13px;margin:0 0 12px;max-width:80ch}
.entete-page{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.btn-comprendre{background:var(--panneau);color:var(--accent);border:1px solid var(--regle);border-radius:999px;padding:6px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.btn-comprendre:hover{border-color:var(--accent)}
.btn-comprendre:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.pourquoi{color:var(--encre2);font-size:14.5px;line-height:1.55;max-width:80ch;margin:0 0 10px;padding:10px 14px;border-left:3px solid var(--accent);background:var(--accent-doux);border-radius:0 8px 8px 0}
.repere{color:var(--encre3);font-size:13px;margin:0 0 10px;max-width:80ch}
.modale{border:0;padding:0;background:transparent;max-width:none;max-height:none;width:100vw;height:100vh}
.modale::backdrop{background:rgba(0,0,0,.45)}
.modale__cadre{background:var(--panneau);color:var(--encre);border:1px solid var(--regle);border-radius:14px;width:min(860px,calc(100vw - 32px));max-height:calc(100vh - 48px);margin:24px auto;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.modale__tete{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 24px;border-bottom:1px solid var(--regle)}
.modale__tete h2{font-size:22px;margin:0}
.modale__fermer{background:transparent;color:var(--encre2);border:1px solid var(--regle);border-radius:999px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}
.modale__corps{overflow:auto;padding:8px 24px 24px;font-size:15px;line-height:1.6}
.modale__partie{padding:16px 0;border-bottom:1px solid var(--regle)}
.modale__partie:last-child{border-bottom:0}
.modale__partie h3{font-size:12.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--encre3);margin:0 0 8px}
.modale__partie p,.modale__partie li{color:var(--encre2);max-width:76ch}
.modale__partie ul{padding-left:20px;margin:8px 0}
.modale__partie li{margin:4px 0}
.modale__partie code{font-size:.92em}

/* ── Cartes ── */
/* 200px et non 215 : la Mémoire porte quatre cartes plus une en double largeur,
   soit cinq colonnes — à 215 la dernière tombait seule sur une deuxième ligne. */
.cartes{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:8px}
.carte{background:var(--panneau);border:1px solid var(--regle);border-radius:12px;padding:16px 18px;
  box-shadow:var(--ombre);display:flex;flex-direction:column;gap:6px}
.carte--phare{grid-column:span 2;border-top:3px solid var(--accent)}
.carte--alerte{border-top:3px solid var(--ko)}
.carte h3{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--encre3);font-weight:600}
.chiffre{margin:0;font-size:34px;line-height:1.05;color:var(--encre);font-weight:500}
.chiffre .sur{font-size:19px;color:var(--encre3)}
.sous{margin:0;font-size:12.5px;color:var(--encre3)}
.avertissement{margin:6px 0 0;font-size:12px;color:var(--encre3);border-top:1px solid var(--regle);padding-top:8px}
@media(max-width:760px){.carte--phare{grid-column:span 1}}

/* ── Jauge : trois états, dont « inconnu » ── */
.jauge{position:relative;height:20px;border-radius:5px;background:var(--panneau2);overflow:hidden;
  display:flex;align-items:center;min-width:120px}
.jauge i{position:absolute;inset:0 auto 0 0;display:block;border-radius:5px}
.jauge span{position:relative;z-index:1;font-family:"JetBrains Mono",monospace;font-size:10.5px;
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
.tableau{overflow-x:auto;border:1px solid var(--regle);border-radius:12px;background:var(--panneau);box-shadow:var(--ombre)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--encre3);
  font-weight:600;padding:10px 14px;border-bottom:1px solid var(--regle);background:var(--panneau);
  position:sticky;top:0;z-index:1}
td{padding:9px 14px;border-bottom:1px solid var(--regle);vertical-align:middle}
tr:last-child td{border-bottom:0}
.num{text-align:right}
.dim{color:var(--encre3)}
.intention{font-size:11.5px;color:var(--encre3);display:inline-block;margin-top:2px;max-width:62ch}

/* ── Pastilles et jetons ── */
.pastille{display:inline-block;font-family:"JetBrains Mono",monospace;font-size:10.5px;
  padding:2px 8px;border-radius:99px;white-space:nowrap}
.pastille--ok{background:var(--ok-doux);color:var(--ok)}
.pastille--ko{background:var(--ko-doux);color:var(--ko)}
.pastille--inconnu{background:var(--panneau2);color:var(--inconnu)}
.pastille--moyen{background:var(--moyen-doux);color:var(--moyen)}
.jeton{display:inline-block;font-size:11px;padding:1px 7px;border:1px solid var(--regle);
  border-radius:99px;color:var(--encre3);white-space:nowrap}

/* ── Écarts ── */
.ecarts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.ecart{display:grid;grid-template-columns:44px 1fr;gap:14px;background:var(--panneau);
  border:1px solid var(--regle);border-left:3px solid var(--regle);border-radius:12px;
  padding:15px 18px;box-shadow:var(--ombre)}
.ecart--haute{border-left-color:var(--ko)}
.ecart--moyenne{border-left-color:var(--moyen)}
.ecart--basse{border-left-color:var(--inconnu)}
.rang{font-family:"JetBrains Mono",monospace;font-size:14px;color:var(--encre3);padding-top:2px}
.ecart--haute .rang{color:var(--ko)}
.ecart--moyenne .rang{color:var(--moyen)}
.ecart h3{font-size:15.5px;margin-bottom:4px}
.ecart p{margin:0;font-size:13.5px;max-width:82ch}
.quoi{margin-top:9px !important;display:flex;flex-wrap:wrap;gap:5px}

/* ── Banc et CI ── */
.grille-banc,.grille-ci{display:grid;grid-template-columns:repeat(auto-fit,minmax(275px,1fr));gap:14px}
.bloc-banc,.bloc-ci{background:var(--panneau);border:1px solid var(--regle);border-radius:12px;
  padding:15px 17px;box-shadow:var(--ombre)}
.bloc-banc header,.bloc-ci header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  border-bottom:1px solid var(--regle);padding-bottom:9px;margin-bottom:11px}
.bloc-banc h3,.bloc-ci h3{font-size:13.5px}
.bloc-banc dl{margin:0;display:grid;gap:5px}
.bloc-banc dl>div{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.bloc-banc dt{font-size:12.5px;color:var(--encre3)}
.bloc-banc dd{margin:0;font-family:"JetBrains Mono",monospace;font-size:12.5px;color:var(--encre);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.unite{color:var(--encre3);font-size:10.5px}
.ligne-meta{margin:0 0 7px;font-size:12.5px;display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.ligne-meta b{color:var(--encre3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin-right:3px}

/* ── Kanban ── */
.rappel{background:var(--accent-doux);border:1px solid var(--accent);border-radius:10px;
  padding:11px 15px;margin:0 0 18px;font-size:13.5px;color:var(--encre2)}
.rappel b{color:var(--accent)}
.kanban{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;align-items:start}
@media(max-width:1200px){.kanban{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:820px){.kanban{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.kanban{grid-template-columns:1fr}}
.colonne{background:var(--panneau2);border-radius:12px;padding:11px;min-width:0}
.colonne header{display:flex;justify-content:space-between;align-items:center;
  gap:8px;margin-bottom:10px;padding:0 3px}
.colonne h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--encre3)}
.pile{display:flex;flex-direction:column;gap:7px}
.ticket{display:flex;flex-direction:column;gap:6px;background:var(--panneau);
  border:1px solid var(--regle);border-left:3px solid var(--regle);border-radius:9px;
  padding:10px 11px;text-decoration:none;color:var(--encre2);box-shadow:var(--ombre)}
.ticket:hover{border-color:var(--accent);border-left-color:var(--accent)}
.ticket--pr{border-left-color:var(--accent)}
.ticket__tete{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ticket__titre{font-size:12.5px;line-height:1.4;color:var(--encre)}
.ticket__pied{display:flex;flex-wrap:wrap;gap:4px}
.num-ticket{font-family:"JetBrains Mono",monospace;font-size:10.5px;color:var(--encre3)}
.vide{font-size:12px;color:var(--encre3);margin:0;padding:3px 4px}
.etiq{display:inline-block;font-size:10px;padding:1px 7px;border-radius:99px;
  border:1px solid transparent;white-space:nowrap}
.etiq--violet{background:rgba(124,92,220,.14);color:#7c5cdc;border-color:rgba(124,92,220,.3)}
.etiq--rouge{background:var(--ko-doux);color:var(--ko);border-color:var(--ko)}
.etiq--bleu{background:rgba(37,120,190,.14);color:#2578be;border-color:rgba(37,120,190,.3)}
.etiq--ambre{background:var(--moyen-doux);color:var(--moyen);border-color:var(--moyen)}
.etiq--vert{background:var(--ok-doux);color:var(--ok);border-color:var(--ok)}
.etiq--rose{background:rgba(198,70,140,.14);color:#c6468c;border-color:rgba(198,70,140,.3)}
.etiq--gris{background:var(--panneau2);color:var(--encre3);border-color:var(--regle)}

/* ── Divers ── */
.alerte{background:var(--ko-doux);border:1px solid var(--ko);border-radius:10px;padding:12px 15px;
  color:var(--encre2);font-size:13.5px;margin:0 0 18px}
.alerte b{color:var(--ko)}
/* Les courbes : SVG écrit à la main, couleurs par variables pour que les deux
   thèmes restent lisibles sans une seconde feuille de style. */
.courbes{display:grid;gap:14px;margin:0 0 18px}
@media (min-width:1100px){.courbes{grid-template-columns:repeat(3,1fr)}}
.courbe{background:var(--panneau);border:1px solid var(--regle);border-radius:10px;padding:12px 14px}
.courbe h4{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--encre);
  display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.courbe__resume{font-weight:500;font-size:12px;color:var(--encre2)}
.courbe__resume--monte{color:var(--ok)}
.courbe__resume--descend{color:var(--ko)}
.courbe__resume--seule{color:var(--encre3);font-style:italic}
.courbe__vide{margin:0;font-size:12.5px;color:var(--encre3)}
.courbe__trace{display:block;width:100%;height:auto;overflow:visible}
.courbe__axe{stroke:var(--regle);stroke-width:1}
.courbe__ligne{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.courbe__aire{fill:var(--accent-doux);stroke:none}
.courbe__point{fill:var(--accent);stroke:var(--panneau);stroke-width:2}
.courbe__graduation,.courbe__date{fill:var(--encre3);font-size:12px;font-family:inherit}
.courbe__valeur{fill:var(--encre);font-size:13px;font-weight:600;font-family:inherit}
.tendance{margin:6px 0 0;font-size:12.5px;color:var(--encre2)}
.tendance--monte{color:var(--ok)}
.tendance--descend{color:var(--ko)}
.tendance--seule{color:var(--encre3);font-style:italic}
/* Un rouge de plus de deux semaines : ce n'est plus une régression, c'est une dette. */
td.dette{color:var(--ko);font-weight:600}
.sparkline{display:flex;align-items:flex-end;gap:3px;height:70px;background:var(--panneau);
  border:1px solid var(--regle);border-radius:12px;padding:12px;margin-bottom:16px}
.sparkline i{flex:1;min-width:3px;background:var(--accent-doux);border-top:2px solid var(--accent);border-radius:2px 2px 0 0}
@media(max-width:900px){.app{grid-template-columns:1fr}.rail{position:static;height:auto}.contenu{padding:22px 16px 70px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<div class="app">
  <aside class="rail">
    <div class="marque">
      <b>Qualité</b>
      <span>NODAL-AGENTS</span>
    </div>
    <nav id="nav">
      <a href="#chantiers" class="actif">Chantiers <b>${(s.chantiers?.cartes ?? []).filter((c) => c.colonne !== 'Fait').length}</b></a>
      <a href="#capacites">Capacités <b>${(s.capacites?.registre ?? []).filter((c) => c.etat === 'jamais prouvée').length}</b></a>
      <a href="#vue">Tests — vue d'ensemble</a>
      <a href="#ecarts">Écarts <b>${ecarts().length}</b></a>
      <a href="#parcours">Parcours <b>${s.resume.specsE2eJoueesParLaCi}/${s.resume.specsE2e}</b></a>
      <a href="#banc">Banc d'essai <b>${s.banc.sections.length}</b></a>
      <a href="#ci">Déclencheurs <b>${s.ci.length}</b></a>
      <a href="#memoire">Mémoire des tests <b>${(s.memoire?.instables ?? 0) + (s.memoire?.casses ?? 0)}</b></a>
      <a href="#historique">Historique <b>${historique.length}</b></a>
    </nav>
    <footer>
      ${esc(s.branche ?? '')}<br>
      ${esc(s.commit ?? '')}<br>
      ${esc(dateFr(s.genereLe))}
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
console.log(`portail rendu → apps/qa/dist/index.html (${(html.length / 1024).toFixed(0)} Ko)`);
