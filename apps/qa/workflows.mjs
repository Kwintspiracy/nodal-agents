// apps/qa/workflows.mjs — la page « Workflows » : de vraies demandes, jouées la nuit.
//
// Les tests du dépôt n'envoient jamais une vraie demande à un vrai modèle. Le
// banc des workflows (`pnpm bench:workflows`, packages/bench/src/workflows) le
// fait, toujours avec les mêmes demandes, et laisse une ligne par essai dans
// data/workflows.ndjson. Cette page les rend lisibles par quelqu'un qui ne code
// pas : pour chaque scénario, ses cinq derniers verdicts, puis la médiane du
// temps et des jetons par version de Nodal-Agents, et un drapeau quand la
// version courante est nettement plus lente (plus de 1,5 fois) que la
// précédente.
//
// Module À PART de build.mjs (qui ne fait que l'appeler) : le rendu vit ici,
// sous test (workflows.test.mjs).

import { echapperHtml as esc } from './lib.mjs';

// Les calculs (séries, matrice, résumés) vivent dans le banc lui-même,
// packages/bench/src/workflows/results.ts, que Bench Studio lit aussi : une
// seule implémentation (règle 11). Node le charge tel quel (suppression des
// types) ; ce module ne garde que le rendu HTML du portail.
import {
  AVANT_LA_MATRICE,
  DERNIERS,
  aideDeColonne,
  SEUIL_RALENTI,
  aRegarder,
  cheminDe,
  colonneDe,
  comparerVersions,
  construireMatrice,
  duree,
  lireCatalogue,
  lireWorkflows,
  mediane,
  nombreJetons,
  resumerColonne,
  resumerSerie,
  resumerWorkflows,
  workflowsARegarder,
} from '../../packages/bench/src/workflows/results.ts';

export {
  AVANT_LA_MATRICE,
  DERNIERS,
  SEUIL_RALENTI,
  colonneDe,
  comparerVersions,
  construireMatrice,
  duree,
  lireCatalogue,
  lireWorkflows,
  mediane,
  nombreJetons,
  resumerColonne,
  resumerSerie,
  resumerWorkflows,
  workflowsARegarder,
};

const MOT_VERDICT = { green: 'Green', red: 'Red', skipped: 'Skipped', error: 'Bench error' };

/**
 * Les contrôles qu'un scénario promet mais que le banc ne vérifie pas encore
 * (`unverified` de la ligne, packages/bench/src/workflows/types.ts). Ni verts
 * ni rouges : dits en gris, avec leur raison et le ticket qui les rétablira.
 * Une ligne plus ancienne qui n'en porte pas n'en affiche aucun.
 */
function nonVerifiesDe(l) {
  return (Array.isArray(l.unverified) ? l.unverified : []).filter(
    (c) => c && typeof c.check === 'string',
  );
}

function controlesNonVerifies(l) {
  const cs = nonVerifiesDe(l);
  if (cs.length === 0) return '';
  const items = cs.map(
    (c) =>
      `<li><span class="pastille pastille--inconnu">${esc(c.check)}: not verified</span> ${esc(c.reason ?? '')}${c.ticket ? ` <span class="mono">${esc(c.ticket)}</span>` : ''}</li>`,
  );
  return `<ul class="wf-controles">${items.join('')}</ul>`;
}

function pastille(l) {
  const v = MOT_VERDICT[l.verdict] ? l.verdict : 'error';
  const quand = String(l.startedAt ?? '')
    .replace('T', ' ')
    .slice(0, 16);
  const pourquoi = (l.reasons ?? []).join('; ');
  const nonVerifies = nonVerifiesDe(l)
    .map((c) => `${c.check}: not verified`)
    .join('; ');
  const titre = `${MOT_VERDICT[v]} · ${quand} UTC · ${l.nodalVersion ?? '?'}${pourquoi ? ` · ${pourquoi}` : ''}${nonVerifies ? ` · ${nonVerifies}` : ''}`;
  return `<li class="wf-pastille wf-pastille--${v}" title="${esc(titre)}"><span class="wf-point"></span><span class="wf-pastille__mot">${MOT_VERDICT[v]}</span><span class="wf-pastille__quand">${esc(quand.slice(5))}</span></li>`;
}

function drapeau(r) {
  if (!r) return '';
  const phrases = r.motifs.map((m) =>
    m.quoi === 'time'
      ? `takes ${m.rapport.toFixed(1)}× as long (median ${duree(m.avant)} → ${duree(m.apres)})`
      : `uses ${m.rapport.toFixed(1)}× as many tokens (median ${nombreJetons(m.avant)} → ${nombreJetons(m.apres)})`,
  );
  return `<p class="wf-drapeau" role="status"><b>Slower since ${esc(r.a)}.</b> Over its last ${DERNIERS} green runs, this workflow ${esc(phrases.join(' and '))} compared with ${esc(r.de)}.</p>`;
}

const MOT_VIA = { api: 'API', cli: 'CLI' };

/** Une somme en dollars, ou un trait quand elle n'est pas mesurée (jamais un zéro inventé). */
function dollars(n) {
  return typeof n === 'number' ? `$${n.toFixed(3)}` : '<span class="wf-nd">not measured</span>';
}

/**
 * Le chemin d'un essai (`cheminDe`, results.ts) : les outils de chaque job dans
 * l'ordre, puis les liens cités, vus ou non dans une sortie d'outil web. Une
 * ligne d'avant le catalogue du 17/10 le dit : non enregistré, jamais « aucun
 * outil ».
 */
function cheminHtml(c) {
  if (!c.enregistre)
    return '<p class="wf-nd">Not recorded on this run (written before the catalogue of 2026-10-17).</p>';
  const jobs = c.jobs
    .map(
      (j) =>
        `<li><span class="mono">${esc(j.job)}</span> ${esc(j.agent ?? '?')}${j.parent ? ` <span class="wf-nd">(delegated by ${esc(j.parent)})</span>` : ''}: ${
          j.outils.length === 0
            ? '<span class="wf-nd">no tool</span>'
            : `<span class="mono">${j.outils.map(esc).join(' → ')}</span>`
        }</li>`,
    )
    .join('');
  const vus = (c.liens ?? []).filter((x) => x.vu).length;
  const nonVus = (c.liens ?? []).filter((x) => !x.vu);
  const liens =
    c.liens === null
      ? ''
      : c.liens.length === 0
        ? '<p class="wf-nd">No link cited.</p>'
        : `<p>${c.liens.length} link${c.liens.length > 1 ? 's' : ''} cited: ${vus} seen in a web tool output, ${nonVus.length} not${nonVus.length > 0 ? ` (<span class="mono">${nonVus.map((x) => esc(x.url)).join(', ')}</span>)` : ''}.</p>`;
  return `<ul class="wf-livrables">${jobs}</ul>${liens}`;
}

/**
 * Le détail du dernier essai : les modèles de chaque job (demandé et effectif,
 * fournisseur, effort, secours, jetons de cache à part), les livrables et la
 * réponse. Une ligne écrite avant le banc v2 ne porte rien de cela : la carte
 * le dit, sans inventer.
 */
function dernierEssai(l) {
  const avantV2 = !Array.isArray(l.modelUse);
  if (avantV2) {
    return `<p class="wf-sous">Models per job, deliverables and answer are not recorded on this run (written before bench v2).</p>`;
  }
  const modeles =
    l.modelUse.length === 0
      ? '<p class="wf-sous">No model call on this run.</p>'
      : `<div class="wf-defile"><table class="wf-table wf-table--fine">
    <thead><tr><th>Job</th><th>Agent</th><th>Requested → answered</th><th>Provider</th><th>Effort</th><th>Calls</th><th>Tokens in (cached) / out</th><th>Cost</th></tr></thead>
    <tbody>${l.modelUse
      .map(
        (u) => `<tr>
      <td class="mono">${esc(u.job)}</td>
      <td>${esc(u.agent ?? '?')}</td>
      <td class="mono">${u.requested && u.requested !== u.effective ? `${esc(u.requested)} → ` : ''}${esc(u.effective)}${u.failover === true ? ' <span class="pastille pastille--inconnu">fallback</span>' : ''}</td>
      <td>${esc(u.provider ?? '?')} · ${MOT_VIA[u.via] ?? esc(u.via)}</td>
      <td>${esc(u.reasoningEffort ?? 'auto')}</td>
      <td>${u.calls}</td>
      <td>${nombreJetons(u.inputTokens)} (${nombreJetons(u.cachedTokens)}) / ${nombreJetons(u.outputTokens)}</td>
      <td>${dollars(u.costUsd)}</td>
    </tr>`,
      )
      .join('')}</tbody></table></div>`;
  const livrables =
    (l.deliverables ?? []).length === 0
      ? '<p class="wf-sous">No file left under nodal-bench/.</p>'
      : `<ul class="wf-livrables">${l.deliverables.map((d) => `<li class="mono">${esc(d.path)}${d.bytes ? ` <span class="wf-nd">${nombreJetons(d.bytes)}B</span>` : ''}</li>`).join('')}</ul>`;
  return `<details class="wf-detail">
    <summary>Last run, ${esc(String(l.startedAt).slice(0, 16).replace('T', ' '))} UTC: models, path, deliverables, answer</summary>
    ${modeles}
    <p class="wf-sous">Path</p>${cheminHtml(cheminDe(l))}
    <p class="wf-sous">Deliverables</p>${livrables}
    <p class="wf-sous">Answer</p>${l.answer ? `<blockquote class="wf-reponse">${esc(l.answer)}</blockquote>` : '<p class="wf-nd">No answer text.</p>'}
  </details>`;
}

function carte(serie) {
  const dernier = serie.derniers[serie.derniers.length - 1];
  const rouge = [...serie.derniers].reverse().find((l) => l.verdict !== 'green');
  const lignesVersion = [...serie.parVersion]
    .reverse()
    .map(
      (p) => `<tr>
        <td class="mono">${esc(p.version)}</td>
        <td>${p.verts}/${p.essais}${p.sautes > 0 ? ` <span class="wf-nd">· ${p.sautes} skipped</span>` : ''}</td>
        <td>${p.verts > 0 ? duree(p.dureeMs) : '<span class="wf-nd">none green</span>'}</td>
        <td>${p.verts > 0 ? nombreJetons(p.jetons) : '<span class="wf-nd">none green</span>'}</td>
        <td>${p.verts > 0 && typeof p.coutUsd === 'number' ? `$${p.coutUsd.toFixed(3)}` : '<span class="wf-nd">·</span>'}</td>
      </tr>`,
    )
    .join('');
  return `<article class="wf-carte wf-carte--${esc(dernier.verdict)}" id="wf-${esc(serie.scenario)}">
  <header class="wf-carte__tete">
    <h3>${esc(serie.titre)}</h3>
    <span class="mono wf-id">${esc(serie.scenario)} · v${esc(serie.version ?? '?')}${serie.jeu === 'on-demand' ? ' · on demand' : ''}</span>
  </header>
  ${serie.vert ? `<p class="wf-vert"><b>Green means:</b> ${esc(serie.vert)}</p>` : ''}
  ${controlesNonVerifies(dernier)}
  <p class="wf-sous">Last ${serie.derniers.length} run${serie.derniers.length > 1 ? 's' : ''}, oldest first</p>
  <ol class="wf-pastilles">${serie.derniers.map(pastille).join('')}</ol>
  ${
    rouge
      ? `<p class="wf-raison wf-raison--${esc(rouge.verdict)}"><b>${esc(MOT_VERDICT[rouge.verdict] ?? rouge.verdict)} on ${esc(String(rouge.startedAt).slice(0, 10))}:</b> ${esc((rouge.reasons ?? []).join('; ') || 'no reason recorded')}</p>`
      : ''
  }
  ${drapeau(serie.ralenti)}
  <table class="wf-table">
    <thead><tr><th>Version</th><th>Green</th><th>Median time</th><th>Median tokens</th><th>Median cost</th></tr></thead>
    <tbody>${lignesVersion}</tbody>
  </table>
  ${
    serie.anciennes.length > 0
      ? `<p class="wf-sous">Earlier series of this workflow, not compared with this one: ${serie.anciennes.map((a) => `v${a.version} (${a.essais} run${a.essais > 1 ? 's' : ''})`).join(', ')}.</p>`
      : ''
  }
  ${dernierEssai(dernier)}
</article>`;
}

// ─── La matrice ──────────────────────────────────────────────────────────────

/** Le nom lisible d'une activité (la liste fermée du banc, packages/bench/src/workflows/types.ts). */
export const ACTIVITES = {
  question: 'Question',
  research: 'Research',
  'deep-research': 'Deep research',
  code: 'Code',
  excel: 'Excel',
  word: 'Word',
  powerpoint: 'PowerPoint',
  pdf: 'PDF',
  'image-comfyui': 'Images (ComfyUI)',
  'html-page': 'HTML page',
  email: 'E-mail',
  airtable: 'Airtable',
  notion: 'Notion',
  'google-workspace': 'Google Workspace',
  delivery: 'Delivery',
  print: 'Print',
  orchestration: 'Orchestration',
  memory: 'Memory',
  unclassified: 'Unclassified',
};

function barre(l) {
  const v = MOT_VERDICT[l.verdict] ? l.verdict : 'error';
  const quand = String(l.startedAt ?? '')
    .replace('T', ' ')
    .slice(0, 16);
  const pourquoi = (l.reasons ?? []).join('; ');
  return `<i class="wf-b wf-b--${v}" title="${esc(`${MOT_VERDICT[v]} · ${quand} UTC${pourquoi ? ` · ${pourquoi}` : ''}`)}"></i>`;
}

/** Une cellule scénario × modèle : les barres des derniers essais, le compte des verts, les médianes. */
function cellule(c) {
  if (!c)
    return '<div class="wf-c wf-c--vide" role="cell"><span class="wf-nd">not run</span></div>';
  const dernier = c.derniers[c.derniers.length - 1];
  const barres = `<span class="wf-barres" aria-hidden="true">${c.derniers.map(barre).join('')}</span>`;
  if (dernier.verdict === 'skipped') {
    const raison = (dernier.reasons ?? [])[0] ?? 'no reason recorded';
    return `<div class="wf-c wf-c--skipped" role="cell">${barres}<span class="wf-c__mot">Skipped</span><span class="wf-c__raison" title="${esc(raison)}">${esc(raison)}</span></div>`;
  }
  const chiffres =
    c.verts > 0
      ? `${duree(c.dureeMs)} · ${typeof c.coutUsd === 'number' ? `$${c.coutUsd.toFixed(3)}` : 'cost not measured'}`
      : 'none green';
  return `<div class="wf-c wf-c--${esc(dernier.verdict)}" role="cell">${barres}<span class="wf-c__mot">${c.verts}/${c.essais} green</span>${c.sautes > 0 ? `<span class="wf-c__saute">${c.sautes} skipped</span>` : ''}<span class="wf-c__chiffres">${esc(chiffres)}</span></div>`;
}

/** La cellule d'une activité : le dernier verdict de chacun de ses scénarios dans cette colonne. */
function celluleActivite(scenarios, col) {
  const derniers = scenarios.map((s) => {
    const c = s.cellules.get(col);
    return c ? c.derniers[c.derniers.length - 1].verdict : null;
  });
  const n = (v) => derniers.filter((d) => d === v).length;
  // Aucun essai de cette activité sur ce modèle : un tiret, rien à compter.
  if (n(null) === derniers.length)
    return '<div class="wf-c wf-c--vide" role="cell"><span class="wf-nd">–</span></div>';
  const joues = derniers.filter((d) => d !== null);
  const carres = joues.map((d) => `<i class="wf-q wf-q--${d}"></i>`).join('');
  const tentes = joues.length - n('skipped');
  const morceaux = [tentes > 0 ? `${n('green')}/${tentes} green` : 'nothing tried'];
  if (n('skipped') > 0) morceaux.push(`${n('skipped')} skipped`);
  return `<div class="wf-c wf-c--activite" role="cell"><span class="wf-carres" aria-hidden="true">${carres}</span><span class="wf-c__mot">${esc(morceaux.join(' · '))}</span></div>`;
}

/** La ligne de résumé d'une colonne : ce qui se compare d'un modèle à l'autre. */
function celluleResume(r) {
  if (!r || r.tentes === 0) {
    return `<div class="wf-c wf-c--resume" role="cell"><span class="wf-c__mot">nothing tried</span>${r?.sautes ? `<span class="wf-nd">${r.sautes} skipped</span>` : ''}</div>`;
  }
  const taux = Math.round((100 * r.verts) / r.tentes);
  const medianes =
    r.verts > 0
      ? `median ${duree(r.dureeMs)} · ${typeof r.coutMedianUsd === 'number' ? `$${r.coutMedianUsd.toFixed(3)}` : 'cost not measured'}`
      : 'no green run: no median';
  const total = `total $${r.coutTotalUsd.toFixed(3)} for ${r.tentes} run${r.tentes > 1 ? 's' : ''}${r.coutInconnu > 0 ? `, ${r.coutInconnu} without a cost` : ''}`;
  return `<div class="wf-c wf-c--resume" role="cell"><span class="wf-c__taux">${taux} % green <span class="wf-nd">(${r.verts}/${r.tentes})</span></span><span class="wf-c__chiffres">${esc(medianes)}</span><span class="wf-c__chiffres">${esc(total)}</span>${r.sautes > 0 ? `<span class="wf-nd">${r.sautes} skipped, not counted</span>` : ''}</div>`;
}

/**
 * Ce que la matrice compare, en une phrase : les modèles, combien d'essais par
 * cellule, la période. C'est la première ligne de la page.
 */
export function phraseComparaison(m) {
  if (!m.periode) return '<p class="wf-compare">No trial yet: nothing is compared.</p>';
  const modeles = m.colonnes.filter((c) => c !== AVANT_LA_MATRICE);
  const avant = m.colonnes.includes(AVANT_LA_MATRICE);
  const periode =
    m.periode.de === m.periode.a ? `on ${m.periode.de}` : `from ${m.periode.de} to ${m.periode.a}`;
  const quoi = [
    ...(modeles.length > 0
      ? [
          `<b>${modeles.length} model${modeles.length > 1 ? 's' : ''}</b> (${modeles.map((c) => `<span class="mono">${esc(c)}</span>`).join(', ')})`,
        ]
      : []),
    ...(avant ? ['the earlier runs, whose model was not recorded'] : []),
  ].join(' and ');
  return `<p class="wf-compare">Comparing ${quoi}, on the last ${DERNIERS} trials at most of each scenario, run ${esc(periode)}.</p>`;
}

/** La matrice activités × modèles, avec le détail de chaque activité à déplier. */
export function htmlMatrice(m) {
  const cols = m.colonnes.length > 0 ? m.colonnes : ['no model yet'];
  const grille = `style="--wf-cols:${cols.length}"`;
  const tete = `<div class="wf-l wf-l--tete" role="row"><div role="columnheader">Activity</div>${cols
    .map((c) =>
      aideDeColonne(c) === null
        ? `<div role="columnheader" class="mono">${esc(c)}</div>`
        : `<div role="columnheader" title="${esc(aideDeColonne(c))}">${esc(c)}</div>`,
    )
    .join(
      '',
    )}</div><div class="wf-l wf-l--resume" role="row"><div role="rowheader"><b>All activities</b> <span class="wf-nd">trials shown below</span></div>${cols
    .map((c) => celluleResume(m.resumes?.get(c)))
    .join('')}</div>`;
  const blocs = m.activites.map(({ activite, scenarios }) => {
    const nom = ACTIVITES[activite] ?? activite;
    if (scenarios.length === 0) {
      return `<div class="wf-l wf-l--sans" role="row"><div role="rowheader"><b>${esc(nom)}</b> <span class="wf-nd">no scenario yet</span></div>${cols.map(() => '<div class="wf-c wf-c--vide" role="cell"></div>').join('')}</div>`;
    }
    const lignes = scenarios
      .map(
        (s) =>
          `<div class="wf-l wf-l--scen" role="row"><div role="rowheader"><a href="#wf-${esc(s.id)}" class="mono">${esc(s.id)}</a><span class="wf-titre">${esc(s.titre)}</span>${s.besoins.length > 0 ? `<span class="wf-besoins">needs ${esc(s.besoins.join(', '))}</span>` : ''}</div>${cols.map((c) => cellule(s.cellules.get(c))).join('')}</div>`,
      )
      .join('');
    return `<details class="wf-act" id="wf-act-${esc(activite)}"><summary class="wf-l wf-l--act" role="row"><div role="rowheader"><b>${esc(nom)}</b> <span class="wf-nd">${scenarios.length} scenario${scenarios.length > 1 ? 's' : ''}</span></div>${cols.map((c) => celluleActivite(scenarios, c)).join('')}</summary>${lignes}</details>`;
  });
  return `<div class="wf-matrice-defile"><div class="wf-matrice" role="table" ${grille}>${tete}${blocs.join('')}</div></div>`;
}

const STYLE = `<style>
.wf-grille{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));margin:0 0 18px}
.wf-carte{border:1px solid var(--regle);border-left:3px solid var(--encre3);background:var(--panneau);padding:16px 18px;border-radius:6px;min-width:0}
.wf-carte--green{border-left-color:var(--ok)}
.wf-carte--red{border-left-color:var(--ko)}
.wf-carte--error{border-left-color:var(--moyen)}
.wf-carte__tete{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px}
.wf-carte__tete h3{margin:0;font-size:16px;color:var(--encre)}
.wf-id{font-size:12px;color:var(--encre3)}
.wf-vert{margin:8px 0 0;font-size:13px;color:var(--encre2)}
.wf-controles{list-style:none;margin:8px 0 0;padding:0;font-size:12px;color:var(--encre3)}
.wf-controles li{margin:4px 0;overflow-wrap:anywhere}
.wf-sous{margin:12px 0 6px;font-size:12px;color:var(--encre3)}
.wf-pastilles{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0}
.wf-pastille{display:flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:var(--panneau2);font-size:12px;color:var(--encre2)}
.wf-point{width:9px;height:9px;border-radius:50%;background:var(--inconnu)}
.wf-pastille--green .wf-point{background:var(--ok)}
.wf-pastille--red .wf-point{background:var(--ko)}
.wf-pastille--error .wf-point{background:var(--moyen)}
.wf-pastille--red{background:var(--ko-doux)}
.wf-pastille__mot{font-weight:600;color:var(--encre)}
.wf-raison{margin:10px 0 0;font-size:13px;color:var(--encre2);overflow-wrap:anywhere}
.wf-drapeau{margin:10px 0 0;padding:8px 10px;border-radius:4px;background:var(--ko-doux);color:var(--encre);font-size:13px}
.wf-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
.wf-table th{text-align:left;font-weight:600;color:var(--encre3);font-size:12px;border-bottom:1px solid var(--regle);padding:4px 6px 4px 0}
.wf-table td{padding:5px 6px 5px 0;border-bottom:1px solid var(--regle);font-variant-numeric:tabular-nums;color:var(--encre)}
.wf-table--fine{font-size:12px}
.wf-defile{overflow-x:auto}
.wf-nd{color:var(--encre3);font-style:italic}
.wf-vide{padding:16px 18px;border:1px dashed var(--regle);border-radius:6px;color:var(--encre2);font-size:14px}
.wf-detail{margin-top:12px;font-size:13px}
.wf-detail summary{cursor:pointer;color:var(--accent);font-size:12px}
.wf-livrables{margin:0;padding-left:18px;font-size:12px;color:var(--encre2);overflow-wrap:anywhere}
.wf-reponse{margin:0;padding:8px 10px;border-left:2px solid var(--regle);background:var(--panneau2);white-space:pre-wrap;font-size:12px;color:var(--encre2);max-height:220px;overflow:auto}
.wf-h{margin:22px 0 10px;font-size:15px;color:var(--encre)}
/* La matrice : une grille, une colonne d'intitulés puis une par modèle. */
/* Le cadre de la matrice : la phrase de comparaison et les comptes y ont la même gouttière que la colonne Activity. */
.wf-panneau{border:1px solid var(--regle);border-radius:6px;background:var(--panneau);margin:0 0 6px;overflow:hidden}
.wf-panneau__tete{padding:12px 12px 10px;border-bottom:1px solid var(--regle)}
.wf-panneau__tete .chapo{margin:4px 0 0}
.wf-matrice-defile{overflow-x:auto}
.wf-matrice{min-width:calc(220px + var(--wf-cols) * 190px)}
.wf-l{display:grid;grid-template-columns:minmax(220px,1.3fr) repeat(var(--wf-cols),minmax(190px,1fr));border-bottom:1px solid var(--regle)}
.wf-l > div{padding:9px 12px;min-width:0}
.wf-l--tete{font-size:12px;font-weight:600;color:var(--encre3);background:var(--panneau2)}
.wf-act > summary{list-style:none;cursor:pointer}
.wf-act > summary::-webkit-details-marker{display:none}
.wf-act > summary > div:first-child::before{content:"▸";display:inline-block;width:14px;color:var(--encre3)}
.wf-act[open] > summary > div:first-child::before{content:"▾"}
.wf-l--act b,.wf-l--sans b{color:var(--encre);font-size:14px}
.wf-l--act:hover{background:var(--panneau2)}
.wf-l--sans{color:var(--encre3)}
.wf-l--scen{background:var(--fond);font-size:12px}
.wf-l--scen > div:first-child{padding-left:28px;display:flex;flex-direction:column;gap:2px}
.wf-l--scen a{color:var(--accent);text-decoration:none}
.wf-titre{color:var(--encre2)}
.wf-besoins{color:var(--encre3);font-size:11px}
.wf-c{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--encre2)}
.wf-c__mot{font-weight:600;color:var(--encre)}
.wf-c--skipped .wf-c__mot,.wf-c--skipped .wf-c__raison{color:var(--encre3)}
.wf-c__raison{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px}
.wf-c__chiffres{font-variant-numeric:tabular-nums}
.wf-c__saute{color:var(--encre3);font-size:11px}
.wf-barres{display:flex;gap:3px;align-items:flex-end;height:16px}
.wf-b{display:inline-block;width:7px;height:16px;border-radius:2px;background:var(--inconnu);opacity:.55}
.wf-b--green{background:var(--ok);opacity:1}
.wf-b--red{background:var(--ko);opacity:1}
.wf-b--error{background:var(--moyen);opacity:1}
.wf-carres{display:flex;flex-wrap:wrap;gap:3px}
.wf-q{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--inconnu);opacity:.55}
.wf-q--green{background:var(--ok);opacity:1}
.wf-q--red{background:var(--ko);opacity:1}
.wf-q--error{background:var(--moyen);opacity:1}
.wf-q--vide{background:transparent;border:1px dashed var(--regle);opacity:1}
.wf-legende{font-size:12px;color:var(--encre3);margin:6px 0 18px}
.wf-compare{margin:0;font-size:14px;color:var(--encre)}
.wf-l--resume{background:var(--panneau2);border-bottom:2px solid var(--regle)}
.wf-l--resume b{color:var(--encre)}
.wf-c__taux{font-size:16px;font-weight:700;color:var(--encre);font-variant-numeric:tabular-nums}
.wf-legende .wf-b{height:10px;vertical-align:baseline;margin:0 2px 0 8px}
</style>`;

/** Ce que les couleurs et les chiffres de la matrice veulent dire. */
function legendeMatrice() {
  return `<p class="wf-legende"><i class="wf-b wf-b--green"></i> green <i class="wf-b wf-b--red"></i> red <i class="wf-b wf-b--error"></i> bench error <i class="wf-b wf-b--skipped"></i> skipped (a need is missing, or the stack was busy: nothing was tried). Bars are the last ${DERNIERS} runs, oldest first; times and costs are medians of green runs. Open an activity to see its scenarios; a scenario name leads to its details.</p>`;
}

/**
 * Le cadre de la matrice : la phrase de comparaison et les comptes en tête,
 * avec la gouttière de la colonne Activity, puis la grille ; la légende dessous.
 */
function panneau(phrase, chapo, matrice) {
  return `<div class="wf-panneau"><div class="wf-panneau__tete">${phrase}${chapo}</div>${matrice}</div>${legendeMatrice()}`;
}

/**
 * Le corps de la page (sans son en-tête, que build.mjs pose). Rien de mesuré :
 * la page le DIT, elle n'affiche ni zéro ni vert. `catalogue` (facultatif) :
 * data/workflow-catalog.json, pour ranger la matrice et montrer ce qui n'a
 * jamais été joué.
 */
export function htmlWorkflows({ lignes, illisibles }, catalogue = null) {
  const series = resumerWorkflows(lignes);
  const alerte =
    illisibles > 0
      ? `<div class="alerte"><b>${illisibles} line${illisibles > 1 ? 's' : ''} of data/workflows.ndjson could not be read.</b> They are left out of every number below.</div>`
      : '';
  const m = catalogue ? construireMatrice(lignes, catalogue) : null;
  const phrase = m ? phraseComparaison(m) : '';
  const matrice = m ? htmlMatrice(m) : '';
  if (series.length === 0) {
    const vide = `<p class="wf-vide">No workflow run is recorded yet, so nothing here is measured. The runs are recorded on the machine that hosts the stack, by <code>pnpm bench:workflows</code>.</p>`;
    return `${STYLE}${alerte}${vide}${m ? panneau(phrase, '', matrice) : ''}`;
  }
  const ralentis = series.filter((x) => x.ralenti).length;
  const derniersVerdicts = series.map((x) => x.derniers[x.derniers.length - 1]?.verdict);
  const rouges = derniersVerdicts.filter(aRegarder).length;
  const sautes = derniersVerdicts.filter((v) => v === 'skipped').length;
  const jamais = catalogue
    ? catalogue.scenarios.filter((s) => !series.some((x) => x.scenario === s.id)).length
    : 0;
  const chapo = `<p class="chapo">${series.length} workflow${series.length > 1 ? 's' : ''}: <b>${rouges} not green on their last run</b>${sautes > 0 ? `, ${sautes} skipped` : ''}${ralentis > 0 ? `, <b>${ralentis} slower than on the previous version</b>` : ''}${jamais > 0 ? `; ${jamais} more never run` : ''}.</p>`;
  return `${STYLE}${alerte}${m ? panneau(phrase, chapo, matrice) : chapo}<h3 class="wf-h">Scenario details</h3><div class="wf-grille">${series.map(carte).join('\n')}</div>`;
}
