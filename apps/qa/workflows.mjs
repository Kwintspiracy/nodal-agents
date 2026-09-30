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
// Module À PART de build.mjs (qui ne fait que l'appeler) : le rendu et ses
// calculs vivent ici, sous test (workflows.test.mjs).

import { echapperHtml as esc } from './lib.mjs';

/** Au-delà de ce rapport entre deux versions, la page lève un drapeau. */
export const SEUIL_RALENTI = 1.5;
/** Combien d'essais récents la médiane courante regarde. */
export const DERNIERS = 5;

/**
 * Lit le fichier ndjson. Une ligne illisible n'est pas ignorée en silence :
 * elle est comptée, et la page le dit.
 */
export function lireWorkflows(texte) {
  const lignes = [];
  let illisibles = 0;
  for (const brute of String(texte ?? '').split('\n')) {
    if (!brute.trim()) continue;
    try {
      const l = JSON.parse(brute);
      if (l && typeof l.scenario === 'string' && typeof l.verdict === 'string') lignes.push(l);
      else illisibles++;
    } catch {
      illisibles++;
    }
  }
  return { lignes, illisibles };
}

/** Compare deux versions « 0.9.10 » > « 0.9.4 », partie par partie. */
export function comparerVersions(a, b) {
  const pa = String(a)
    .split(/[.-]/)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b)
    .split(/[.-]/)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function mediane(nombres) {
  const v = nombres
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const jetons = (l) =>
  typeof l.inputTokens === 'number' && typeof l.outputTokens === 'number'
    ? l.inputTokens + l.outputTokens
    : null;

/**
 * Le résumé d'une série (un scénario à une version donnée) : les derniers
 * verdicts, les médianes par version de Nodal, et le drapeau de ralentissement.
 *
 * Les médianes ne comptent que les essais VERTS : un essai rouge peut avoir été
 * coupé au bout de dix secondes (une approbation), et le compter ferait passer
 * une panne pour une accélération.
 */
export function resumerSerie(lignes) {
  const tri = [...lignes].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const derniere = tri[tri.length - 1];
  const versions = [...new Set(tri.map((l) => l.nodalVersion ?? 'unknown'))].sort(comparerVersions);
  const parVersion = versions.map((v) => {
    const de = tri.filter((l) => (l.nodalVersion ?? 'unknown') === v);
    const verts = de.filter((l) => l.verdict === 'green');
    return {
      version: v,
      essais: de.length,
      verts: verts.length,
      rouges: de.filter((l) => l.verdict === 'red').length,
      dureeMs: mediane(verts.map((l) => l.durationMs)),
      jetons: mediane(verts.map(jetons)),
      coutUsd: mediane(verts.map((l) => l.costUsd)),
    };
  });

  // Le drapeau : les DERNIERS essais verts de la version courante contre la
  // version précédente qui a au moins un vert.
  let ralenti = null;
  const courante = parVersion[parVersion.length - 1];
  const avant = [...parVersion.slice(0, -1)].reverse().find((p) => p.verts > 0);
  if (courante && avant) {
    const recents = tri
      .filter((l) => (l.nodalVersion ?? 'unknown') === courante.version && l.verdict === 'green')
      .slice(-DERNIERS);
    const d = mediane(recents.map((l) => l.durationMs));
    const t = mediane(recents.map(jetons));
    const motifs = [];
    if (d !== null && avant.dureeMs && d > SEUIL_RALENTI * avant.dureeMs) {
      motifs.push({ quoi: 'time', rapport: d / avant.dureeMs, avant: avant.dureeMs, apres: d });
    }
    if (t !== null && avant.jetons && t > SEUIL_RALENTI * avant.jetons) {
      motifs.push({ quoi: 'tokens', rapport: t / avant.jetons, avant: avant.jetons, apres: t });
    }
    if (motifs.length > 0) ralenti = { de: avant.version, a: courante.version, motifs };
  }

  return {
    scenario: derniere.scenario,
    version: derniere.scenarioVersion ?? null,
    titre: derniere.title ?? derniere.scenario,
    vert: derniere.green ?? null,
    jeu: derniere.set ?? null,
    derniers: tri.slice(-DERNIERS),
    parVersion,
    ralenti,
  };
}

/**
 * Toutes les séries, dans l'ordre d'apparition des scénarios. Une nouvelle
 * version d'un scénario ouvre une nouvelle série ; seule la plus récente est
 * détaillée, les anciennes sont dites (leur nombre d'essais).
 */
export function resumerWorkflows(lignes) {
  const ordre = [];
  const parScenario = new Map();
  for (const l of lignes) {
    if (!parScenario.has(l.scenario)) {
      parScenario.set(l.scenario, []);
      ordre.push(l.scenario);
    }
    parScenario.get(l.scenario).push(l);
  }
  return ordre.map((id) => {
    const toutes = parScenario.get(id);
    const versions = [...new Set(toutes.map((l) => l.scenarioVersion ?? 0))].sort((a, b) => a - b);
    const actuelle = versions[versions.length - 1];
    const serie = resumerSerie(toutes.filter((l) => (l.scenarioVersion ?? 0) === actuelle));
    const anciennes = versions.slice(0, -1).map((v) => ({
      version: v,
      essais: toutes.filter((l) => (l.scenarioVersion ?? 0) === v).length,
    }));
    return { ...serie, anciennes };
  });
}

/** Le chiffre de la barre de gauche : les workflows à regarder (pas verts au dernier essai, ou ralentis). */
export function workflowsARegarder({ lignes }) {
  return resumerWorkflows(lignes).filter(
    (x) => x.derniers[x.derniers.length - 1]?.verdict !== 'green' || x.ralenti !== null,
  ).length;
}

// ─── Rendu ───────────────────────────────────────────────────────────────────

export function duree(ms) {
  if (typeof ms !== 'number') return 'not measured';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${min} min` : `${min} min ${s} s`;
}

export function nombreJetons(n) {
  if (typeof n !== 'number') return 'not measured';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}

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

function carte(serie) {
  const dernier = serie.derniers[serie.derniers.length - 1];
  const rouge = [...serie.derniers].reverse().find((l) => l.verdict !== 'green');
  const lignesVersion = [...serie.parVersion]
    .reverse()
    .map(
      (p) => `<tr>
        <td class="mono">${esc(p.version)}</td>
        <td>${p.verts}/${p.essais}</td>
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
      ? `<p class="wf-raison"><b>${esc(MOT_VERDICT[rouge.verdict] ?? rouge.verdict)} on ${esc(String(rouge.startedAt).slice(0, 10))}:</b> ${esc((rouge.reasons ?? []).join('; ') || 'no reason recorded')}</p>`
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
</article>`;
}

const STYLE = `<style>
.wf-grille{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));margin:0 0 18px}
.wf-carte{border:1px solid var(--regle);border-left:3px solid var(--encre3);background:var(--panneau);padding:16px 18px;border-radius:6px;min-width:0}
.wf-carte--green{border-left-color:var(--ok)}
.wf-carte--red,.wf-carte--error{border-left-color:var(--ko)}
.wf-carte__tete{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px}
.wf-carte__tete h3{margin:0;font-size:16px;color:var(--encre)}
.wf-id{font-size:12px;color:var(--encre3)}
.wf-vert{margin:8px 0 0;font-size:13px;color:var(--encre2)}
.wf-controles{list-style:none;margin:8px 0 0;padding:0;font-size:12px;color:var(--encre3)}
.wf-controles li{margin:4px 0;overflow-wrap:anywhere}
.wf-sous{margin:12px 0 6px;font-size:12px;color:var(--encre3)}
.wf-pastilles{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0}
.wf-pastille{display:flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:var(--panneau2);font-size:12px;color:var(--encre2)}
.wf-point{width:9px;height:9px;border-radius:50%;background:var(--encre3)}
.wf-pastille--green .wf-point{background:var(--ok)}
.wf-pastille--red .wf-point,.wf-pastille--error .wf-point{background:var(--ko)}
.wf-pastille--red{background:var(--ko-doux)}
.wf-pastille__mot{font-weight:600;color:var(--encre)}
.wf-raison{margin:10px 0 0;font-size:13px;color:var(--encre2);overflow-wrap:anywhere}
.wf-drapeau{margin:10px 0 0;padding:8px 10px;border-radius:4px;background:var(--ko-doux);color:var(--encre);font-size:13px}
.wf-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
.wf-table th{text-align:left;font-weight:600;color:var(--encre3);font-size:12px;border-bottom:1px solid var(--regle);padding:4px 6px 4px 0}
.wf-table td{padding:5px 6px 5px 0;border-bottom:1px solid var(--regle);font-variant-numeric:tabular-nums;color:var(--encre)}
.wf-nd{color:var(--encre3);font-style:italic}
.wf-vide{padding:16px 18px;border:1px dashed var(--regle);border-radius:6px;color:var(--encre2);font-size:14px}
</style>`;

/**
 * Le corps de la page (sans son en-tête, que build.mjs pose). Rien de mesuré :
 * la page le DIT, elle n'affiche ni zéro ni vert.
 */
export function htmlWorkflows({ lignes, illisibles }) {
  const series = resumerWorkflows(lignes);
  const alerte =
    illisibles > 0
      ? `<div class="alerte"><b>${illisibles} line${illisibles > 1 ? 's' : ''} of data/workflows.ndjson could not be read.</b> They are left out of every number below.</div>`
      : '';
  if (series.length === 0) {
    return `${STYLE}${alerte}<p class="wf-vide">No workflow run is recorded yet, so nothing here is measured. The runs are recorded on the machine that hosts the stack, by <code>pnpm bench:workflows</code>.</p>`;
  }
  const ralentis = series.filter((x) => x.ralenti).length;
  const rouges = series.filter(
    (x) => x.derniers[x.derniers.length - 1]?.verdict !== 'green',
  ).length;
  const chapo = `<p class="chapo">${series.length} workflow${series.length > 1 ? 's' : ''}: <b>${rouges} not green on their last run</b>${ralentis > 0 ? `, <b>${ralentis} slower than on the previous version</b>` : ''}.</p>`;
  return `${STYLE}${alerte}${chapo}<div class="wf-grille">${series.map(carte).join('\n')}</div>`;
}
