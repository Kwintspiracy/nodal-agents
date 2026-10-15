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

/**
 * Lit data/workflow-catalog.json (écrit par `pnpm bench:workflows --catalog`).
 * Un catalogue mal formé arrête la construction, en le disant : une matrice
 * rangée sur un catalogue faux mentirait sur ce qui n'a jamais été joué.
 */
export function lireCatalogue(texte) {
  let c;
  try {
    c = JSON.parse(texte);
  } catch (e) {
    throw new Error(
      `data/workflow-catalog.json is not JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  const ok =
    c &&
    Array.isArray(c.activities) &&
    Array.isArray(c.scenarios) &&
    c.scenarios.every(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.activity === 'string' &&
        typeof s.title === 'string',
    );
  if (!ok) throw new Error('data/workflow-catalog.json does not have the shape the bench writes');
  return c;
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

/** Un dernier essai à regarder : rouge, ou une erreur du banc. Un essai SAUTÉ n'a rien essayé. */
const aRegarder = (verdict) => verdict === 'red' || verdict === 'error';

/**
 * Le chiffre de la barre de gauche : les workflows à regarder (rouges ou en
 * erreur au dernier essai, ou ralentis). Un dernier essai sauté (un besoin
 * absent, la stack occupée) n'y entre pas : il est gris, jamais rouge.
 */
export function workflowsARegarder({ lignes }) {
  return resumerWorkflows(lignes).filter(
    (x) => aRegarder(x.derniers[x.derniers.length - 1]?.verdict) || x.ralenti !== null,
  ).length;
}

// ─── La matrice : activités × modèles ────────────────────────────────────────

/** La colonne des essais dont on ne sait pas sur quel modèle ils étaient RÉGLÉS. */
export const AVANT_LA_MATRICE = 'before the matrix';

/**
 * La colonne d'un essai : le modèle sur lequel il était RÉGLÉ, jamais
 * l'ensemble des modèles qui ont répondu (un secours, un délégué sur un autre
 * modèle mêleraient les colonnes). C'est le modèle que la matrice a imposé,
 * sinon le modèle configuré de l'agent racine. Une ligne écrite avant le banc
 * v2 ne porte ni l'un ni l'autre : `models` dit qui a RÉPONDU, pas ce qui était
 * demandé. Elle va dans une seule colonne, « before the matrix ».
 */
export function colonneDe(l) {
  if (typeof l.modelUnderTest === 'string' && l.modelUnderTest) return l.modelUnderTest;
  if (typeof l.rootModel === 'string' && l.rootModel) return l.rootModel;
  return AVANT_LA_MATRICE;
}

/** Ce qu'une cellule (un scénario, un modèle) montre : ses derniers essais et ses médianes vertes. */
function resumerCellule(lignes) {
  const tri = [...lignes].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const verts = tri.filter((l) => l.verdict === 'green');
  return {
    derniers: tri.slice(-DERNIERS),
    essais: tri.length,
    verts: verts.length,
    dureeMs: mediane(verts.map((l) => l.durationMs)),
    coutUsd: mediane(verts.map((l) => l.costUsd)),
  };
}

/**
 * Le résumé d'une colonne, sur les essais MONTRÉS (les cinq derniers de chaque
 * scénario dans cette colonne) : la part de verts parmi les essais tentés (un
 * essai sauté n'a rien tenté : ni au numérateur ni au dénominateur), les
 * médianes de temps et de coût des verts, et le coût total des essais tentés.
 * Un coût que des essais n'ont pas rapporté est DIT (`coutInconnu`), jamais
 * compté zéro.
 */
export function resumerColonne(essais) {
  const tentes = essais.filter((l) => l.verdict !== 'skipped');
  const verts = tentes.filter((l) => l.verdict === 'green');
  const couts = tentes.map((l) => l.costUsd);
  return {
    tentes: tentes.length,
    sautes: essais.length - tentes.length,
    verts: verts.length,
    dureeMs: mediane(verts.map((l) => l.durationMs)),
    coutMedianUsd: mediane(verts.map((l) => l.costUsd)),
    coutTotalUsd: couts.filter((c) => typeof c === 'number').reduce((a, b) => a + b, 0),
    coutInconnu: couts.filter((c) => typeof c !== 'number').length,
  };
}

/**
 * La matrice du portail. Les lignes sont les activités (dans l'ordre du
 * catalogue), puis leurs scénarios ; les colonnes, les modèles. Seule la série
 * COURANTE d'un scénario (sa dernière version) remplit les cellules.
 *
 * `catalogue` (data/workflow-catalog.json, écrit par le banc) apporte l'ordre
 * des activités, les scénarios jamais joués et l'activité des lignes écrites
 * avant la v2. Sans lui, la matrice ne montre que ce qui a été joué.
 */
export function construireMatrice(lignes, catalogue = null) {
  const parScenario = new Map();
  for (const l of lignes) {
    if (!parScenario.has(l.scenario)) parScenario.set(l.scenario, []);
    parScenario.get(l.scenario).push(l);
  }
  const duCatalogue = new Map((catalogue?.scenarios ?? []).map((s) => [s.id, s]));
  const ids = [
    ...(catalogue?.scenarios ?? []).map((s) => s.id),
    ...[...parScenario.keys()].filter((id) => !duCatalogue.has(id)),
  ];

  // Les colonnes : les modèles réglés, les plus joués d'abord ; « before the matrix » en dernier.
  const compte = new Map();
  for (const l of lignes) {
    const c = colonneDe(l);
    compte.set(c, (compte.get(c) ?? 0) + 1);
  }
  const colonnes = [...compte.entries()]
    .sort((a, b) => (a[0] === AVANT_LA_MATRICE) - (b[0] === AVANT_LA_MATRICE) || b[1] - a[1])
    .map(([c]) => c);

  const scenarios = ids.map((id) => {
    const cat = duCatalogue.get(id) ?? null;
    const toutes = parScenario.get(id) ?? [];
    const versions = [...new Set(toutes.map((l) => l.scenarioVersion ?? 0))];
    const version = cat?.version ?? (versions.length > 0 ? Math.max(...versions) : null);
    const serie = toutes.filter((l) => (l.scenarioVersion ?? 0) === version);
    const derniere = [...serie]
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .pop();
    const parColonne = new Map();
    for (const l of serie) {
      const c = colonneDe(l);
      if (!parColonne.has(c)) parColonne.set(c, []);
      parColonne.get(c).push(l);
    }
    return {
      id,
      version,
      activite:
        cat?.activity ??
        derniere?.activity ??
        toutes[toutes.length - 1]?.activity ??
        'unclassified',
      titre: cat?.title ?? derniere?.title ?? id,
      vert: cat?.green ?? derniere?.green ?? null,
      besoins: cat?.needs ?? derniere?.needs ?? [],
      jeu: cat?.set ?? derniere?.set ?? null,
      anciens: toutes.length - serie.length,
      cellules: new Map([...parColonne.entries()].map(([c, ls]) => [c, resumerCellule(ls)])),
    };
  });

  const ordre = [
    ...(catalogue?.activities ?? []),
    ...[...new Set(scenarios.map((s) => s.activite))].filter(
      (a) => !(catalogue?.activities ?? []).includes(a),
    ),
  ];
  // Le résumé de chaque colonne : ce que Quentin compare d'un modèle à l'autre.
  const montres = (col) => scenarios.flatMap((s) => s.cellules.get(col)?.derniers ?? []);
  const resumes = new Map(colonnes.map((c) => [c, resumerColonne(montres(c))]));
  const dates = colonnes
    .flatMap(montres)
    .map((l) => String(l.startedAt ?? '').slice(0, 10))
    .filter(Boolean)
    .sort();
  return {
    colonnes,
    resumes,
    periode: dates.length > 0 ? { de: dates[0], a: dates[dates.length - 1] } : null,
    activites: ordre.map((a) => ({
      activite: a,
      scenarios: scenarios.filter((s) => s.activite === a),
    })),
  };
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

const MOT_VIA = { api: 'API', cli: 'CLI' };

/** Une somme en dollars, ou un trait quand elle n'est pas mesurée (jamais un zéro inventé). */
function dollars(n) {
  return typeof n === 'number' ? `$${n.toFixed(3)}` : '<span class="wf-nd">not measured</span>';
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
    <summary>Last run, ${esc(String(l.startedAt).slice(0, 16).replace('T', ' '))} UTC: models, deliverables, answer</summary>
    ${modeles}
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
  return `<div class="wf-c wf-c--${esc(dernier.verdict)}" role="cell">${barres}<span class="wf-c__mot">${c.verts}/${c.essais} green</span><span class="wf-c__chiffres">${esc(chiffres)}</span></div>`;
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
    ...(avant ? ['the runs from before the matrix, whose model was not recorded'] : []),
  ].join(' and ');
  return `<p class="wf-compare">Comparing ${quoi}, on the last ${DERNIERS} trials at most of each scenario, run ${esc(periode)}.</p>`;
}

/** La matrice activités × modèles, avec le détail de chaque activité à déplier. */
export function htmlMatrice(m) {
  const cols = m.colonnes.length > 0 ? m.colonnes : ['no model yet'];
  const grille = `style="--wf-cols:${cols.length}"`;
  const tete = `<div class="wf-l wf-l--tete" role="row"><div role="columnheader">Activity</div>${cols
    .map((c) => `<div role="columnheader" class="mono">${esc(c)}</div>`)
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
  return `<div class="wf-matrice-defile"><div class="wf-matrice" role="table" ${grille}>${tete}${blocs.join('')}</div></div>
<p class="wf-legende"><i class="wf-b wf-b--green"></i> green <i class="wf-b wf-b--red"></i> red <i class="wf-b wf-b--error"></i> bench error <i class="wf-b wf-b--skipped"></i> skipped (a need is missing, or the stack was busy: nothing was tried). Bars are the last ${DERNIERS} runs, oldest first; times and costs are medians of green runs. Open an activity to see its scenarios; a scenario name leads to its details.</p>`;
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
.wf-matrice-defile{overflow-x:auto;margin:0 0 6px;border:1px solid var(--regle);border-radius:6px;background:var(--panneau)}
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
.wf-compare{margin:0 0 6px;font-size:14px;color:var(--encre)}
.wf-l--resume{background:var(--panneau2);border-bottom:2px solid var(--regle)}
.wf-l--resume b{color:var(--encre)}
.wf-c__taux{font-size:16px;font-weight:700;color:var(--encre);font-variant-numeric:tabular-nums}
.wf-legende .wf-b{height:10px;vertical-align:baseline;margin:0 2px 0 8px}
</style>`;

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
    return `${STYLE}${alerte}${phrase}<p class="wf-vide">No workflow run is recorded yet, so nothing here is measured. The runs are recorded on the machine that hosts the stack, by <code>pnpm bench:workflows</code>.</p>${matrice}`;
  }
  const ralentis = series.filter((x) => x.ralenti).length;
  const derniersVerdicts = series.map((x) => x.derniers[x.derniers.length - 1]?.verdict);
  const rouges = derniersVerdicts.filter(aRegarder).length;
  const sautes = derniersVerdicts.filter((v) => v === 'skipped').length;
  const jamais = catalogue
    ? catalogue.scenarios.filter((s) => !series.some((x) => x.scenario === s.id)).length
    : 0;
  const chapo = `<p class="chapo">${series.length} workflow${series.length > 1 ? 's' : ''}: <b>${rouges} not green on their last run</b>${sautes > 0 ? `, ${sautes} skipped` : ''}${ralentis > 0 ? `, <b>${ralentis} slower than on the previous version</b>` : ''}${jamais > 0 ? `; ${jamais} more never run` : ''}.</p>`;
  return `${STYLE}${alerte}${phrase}${chapo}${matrice}<h3 class="wf-h">Scenario details</h3><div class="wf-grille">${series.map(carte).join('\n')}</div>`;
}
