// workflows.test.mjs — la page « Workflows » dit ce qui casse et ce qui ralentit.
//
// Les lignes de base sont de VRAIS essais du 30/09 (data/workflows.ndjson, la
// preuve de la PR du banc). Les séries sur plusieurs versions en dérivent :
// même scénario, même forme, seules la version et la durée changent, pour
// éprouver le calcul du drapeau « Slower since ».

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  lireWorkflows,
  resumerWorkflows,
  htmlWorkflows,
  workflowsARegarder,
  comparerVersions,
  mediane,
  duree,
  SEUIL_RALENTI,
  AVANT_LA_MATRICE,
  colonneDe,
  phraseComparaison,
  resumerColonne,
  construireMatrice,
  htmlMatrice,
  lireCatalogue,
} from './workflows.mjs';

/** Un vrai essai `question` vert (job 7042900c, 30/09). */
const QUESTION_VERTE = {
  scenario: 'question',
  scenarioVersion: 1,
  title: 'A factual question, answered directly',
  green:
    'The answer names Canberra, the root answered itself (no delegation), and nobody was asked anything.',
  set: 'nightly',
  nodalVersion: '0.9.3',
  stackCommit: 'ebef7ed7e02b',
  trigger: 'manual',
  startedAt: '2026-09-30T05:02:34.551Z',
  durationMs: 20952,
  firstModelReplyMs: 2404,
  jobs: 1,
  agents: ['alfred'],
  models: ['z-ai/glm-5.3'],
  toolCalls: 0,
  llmCalls: 2,
  inputTokens: 33722,
  outputTokens: 70,
  costUsd: 0.0358,
  approvals: 0,
  rootJobId: '7042900c-4c9e-4725-83a1-816a27d594ae',
  cancelled: false,
  verdict: 'green',
  reasons: [],
};

/** Un vrai essai `file` rouge : arrêté sur une demande d'approbation (job 75bbf3d0, 30/09). */
const FICHIER_ROUGE = {
  ...QUESTION_VERTE,
  scenario: 'file',
  title: 'An Excel file written in the workspace',
  green: 'The file nodal-bench/ventes-bench.xlsx was written during the run.',
  startedAt: '2026-09-30T05:03:26.267Z',
  durationMs: 141178,
  jobs: 2,
  agents: ['alfred', 'researcher'],
  inputTokens: 196200,
  outputTokens: 6202,
  costUsd: 0.0342,
  approvals: 1,
  rootJobId: '75bbf3d0-3479-42bd-8463-a07e15c5ac73',
  cancelled: true,
  verdict: 'red',
  reasons: ['root ended cancelled', 'asked an approval (run_command)'],
};

const ndjson = (lignes) => lignes.map((l) => JSON.stringify(l)).join('\n');

/** Cinq essais verts d'une version, à une durée donnée, un par nuit. */
function nuits(version, dureeMs, depuis, n = 5, jetons = 33792) {
  return Array.from({ length: n }, (_, i) => ({
    ...QUESTION_VERTE,
    nodalVersion: version,
    durationMs: dureeMs,
    inputTokens: jetons - 70,
    startedAt: new Date(Date.parse(depuis) + i * 86_400_000).toISOString(),
  }));
}

describe('la page Workflows', () => {
  it('rend une carte par workflow, avec son critère du vert et ses derniers verdicts', () => {
    const html = htmlWorkflows(lireWorkflows(ndjson([QUESTION_VERTE, FICHIER_ROUGE])));
    expect(html).toContain('A factual question, answered directly');
    expect(html).toContain('<b>Green means:</b> The answer names Canberra');
    expect(html).toContain('wf-pastille--green');
    expect(html).toContain('wf-pastille--red');
    // Le rouge dit POURQUOI, en clair, sous les pastilles.
    expect(html).toContain(
      '<b>Red on 2026-09-30:</b> root ended cancelled; asked an approval (run_command)',
    );
    expect(html).toContain('2 workflows: <b>1 not green on their last run</b>');
  });

  it('donne la médiane des essais VERTS par version, jamais celle des rouges', () => {
    const rougeCourt = { ...FICHIER_ROUGE, durationMs: 4000, startedAt: '2026-10-01T03:00:00Z' };
    const [serie] = resumerWorkflows([FICHIER_ROUGE, rougeCourt]);
    expect(serie.parVersion).toEqual([
      {
        version: '0.9.3',
        essais: 2,
        sautes: 0,
        verts: 0,
        rouges: 2,
        dureeMs: null,
        jetons: null,
        coutUsd: null,
      },
    ]);
    const html = htmlWorkflows({ lignes: [FICHIER_ROUGE, rougeCourt], illisibles: 0 });
    expect(html).toContain('none green');
  });

  it(`lève « Slower since » quand les 5 derniers verts dépassent ${SEUIL_RALENTI}× la version précédente`, () => {
    const lignes = [
      ...nuits('0.9.3', 20_000, '2026-10-01T03:00:00Z'),
      ...nuits('0.9.4', 45_000, '2026-10-10T03:00:00Z'),
    ];
    const [serie] = resumerWorkflows(lignes);
    expect(serie.ralenti).toEqual({
      de: '0.9.3',
      a: '0.9.4',
      motifs: [{ quoi: 'time', rapport: 2.25, avant: 20_000, apres: 45_000 }],
    });
    const html = htmlWorkflows({ lignes, illisibles: 0 });
    expect(html).toContain('<b>Slower since 0.9.4.</b>');
    expect(html).toContain('takes 2.3× as long (median 20 s → 45 s) compared with 0.9.3');
    expect(workflowsARegarder({ lignes })).toBe(1);
  });

  it('ne lève rien à 1,5× tout juste, ni pour une version seule', () => {
    const egal = [
      ...nuits('0.9.3', 20_000, '2026-10-01T03:00:00Z'),
      ...nuits('0.9.4', 30_000, '2026-10-10T03:00:00Z'),
    ];
    expect(resumerWorkflows(egal)[0].ralenti).toBeNull();
    expect(resumerWorkflows(nuits('0.9.4', 90_000, '2026-10-10T03:00:00Z'))[0].ralenti).toBeNull();
    expect(workflowsARegarder({ lignes: egal })).toBe(0);
  });

  it('compare les jetons aussi : un workflow qui consomme deux fois plus est signalé', () => {
    const lignes = [
      ...nuits('0.9.3', 20_000, '2026-10-01T03:00:00Z', 5, 30_000),
      ...nuits('0.9.4', 20_000, '2026-10-10T03:00:00Z', 5, 61_000),
    ];
    const r = resumerWorkflows(lignes)[0].ralenti;
    expect(r.motifs.map((m) => m.quoi)).toEqual(['tokens']);
    expect(htmlWorkflows({ lignes, illisibles: 0 })).toContain(
      'uses 2.0× as many tokens (median 30 k → 61 k)',
    );
  });

  it('ne compare que les 5 DERNIERS verts de la version courante', () => {
    // Trois nuits lentes puis cinq rapides sur 0.9.4 : le ralentissement est réparé, pas de drapeau.
    const lignes = [
      ...nuits('0.9.3', 20_000, '2026-10-01T03:00:00Z'),
      ...nuits('0.9.4', 90_000, '2026-10-10T03:00:00Z', 3),
      ...nuits('0.9.4', 21_000, '2026-10-20T03:00:00Z', 5),
    ];
    expect(resumerWorkflows(lignes)[0].ralenti).toBeNull();
  });

  it('une nouvelle version du scénario ouvre une nouvelle série, et nomme l’ancienne', () => {
    const v2 = { ...QUESTION_VERTE, scenarioVersion: 2, startedAt: '2026-10-02T03:00:00Z' };
    const [serie] = resumerWorkflows([QUESTION_VERTE, QUESTION_VERTE, v2]);
    expect(serie.version).toBe(2);
    expect(serie.derniers).toHaveLength(1);
    expect(serie.anciennes).toEqual([{ version: 1, essais: 2 }]);
    expect(htmlWorkflows({ lignes: [QUESTION_VERTE, v2], illisibles: 0 })).toContain(
      'Earlier series of this workflow, not compared with this one: v1 (1 run).',
    );
  });

  it('sans aucune mesure, la page le dit : ni zéro, ni vert', () => {
    const html = htmlWorkflows(lireWorkflows(''));
    expect(html).toContain('No workflow run is recorded yet, so nothing here is measured.');
    expect(html).not.toContain('<li class="wf-pastille');
  });

  it('une ligne illisible est comptée et dite, jamais avalée', () => {
    const lu = lireWorkflows(`${JSON.stringify(QUESTION_VERTE)}\n{pas du json\n{"autre":1}\n`);
    expect(lu.lignes).toHaveLength(1);
    expect(lu.illisibles).toBe(2);
    expect(htmlWorkflows(lu)).toContain('2 lines of data/workflows.ndjson could not be read.');
  });

  it('échappe ce qui vient du fichier', () => {
    const html = htmlWorkflows({
      lignes: [{ ...FICHIER_ROUGE, reasons: ['<script>x</script>'] }],
      illisibles: 0,
    });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('lit les vrais essais versionnés du dépôt', () => {
    const lu = lireWorkflows(
      readFileSync(new URL('./data/workflows.ndjson', import.meta.url), 'utf8'),
    );
    expect(lu.illisibles).toBe(0);
    expect(lu.lignes.length).toBeGreaterThan(0);
    for (const l of lu.lignes) expect(['green', 'red', 'skipped', 'error']).toContain(l.verdict);
  });
});

describe('les calculs de la page', () => {
  it('trie les versions comme des nombres', () => {
    expect(['0.9.10', '0.9.4', '0.10.0', '0.9.4'].sort(comparerVersions)).toEqual([
      '0.9.4',
      '0.9.4',
      '0.9.10',
      '0.10.0',
    ]);
  });
  it('prend la médiane, pas la moyenne', () => {
    expect(mediane([1, 100, 3])).toBe(3);
    expect(mediane([1, 2, 3, 4])).toBe(2.5);
    expect(mediane([null, undefined])).toBeNull();
  });
  it('écrit une durée lisible', () => {
    expect(duree(20952)).toBe('21 s');
    expect(duree(141178)).toBe('2 min 21 s');
    expect(duree(null)).toBe('not measured');
  });
});

// Décision de Quentin (30/09, PR #634) : « sources read » n'est plus jugé par le
// banc tant que la plateforme ne l'enregistre pas (#648). Chaque ligne des
// scénarios concernés le porte ; la page le montre en GRIS, ni vert ni rouge.
describe('un contrôle non vérifié', () => {
  const SOURCES = {
    check: 'sources read',
    state: 'not verified',
    reason:
      'Nothing in the database records which web addresses a run really read; guessing it from tool outputs leaked four times.',
    ticket: '#648',
  };
  const RECHERCHE_VERTE = {
    ...QUESTION_VERTE,
    scenario: 'research',
    scenarioVersion: 3,
    title: 'A research request, handed to the research specialty',
    green:
      'The root delegated, the delegate called a web search or page-read tool, the report came back with at least one source link, and nobody was asked anything. Whether the cited sources were really read is not verified yet (#648).',
    unverified: [SOURCES],
  };
  const carteDe = (html, id) => {
    const debut = html.indexOf(`id="wf-${id}"`);
    return html.slice(debut, html.indexOf('</article>', debut));
  };

  it('se montre en gris sur la carte, avec sa raison et son ticket, même quand tout le reste est vert', () => {
    const html = htmlWorkflows(lireWorkflows(ndjson([RECHERCHE_VERTE])));
    const carte = carteDe(html, 'research');
    expect(carte).toContain(
      '<span class="pastille pastille--inconnu">sources read: not verified</span>',
    );
    expect(carte).toContain('#648');
    expect(carte).toContain('guessing it from tool outputs leaked four times');
    // Jamais présenté comme vérifié, jamais en vert.
    expect(carte).not.toContain('sources verified');
    expect(carte).not.toMatch(/pastille--ok[^>]*>sources/);
  });

  it('la pastille verte de l’essai dit elle-même que ce contrôle n’est pas vérifié', () => {
    const html = htmlWorkflows(lireWorkflows(ndjson([RECHERCHE_VERTE])));
    const pastille = carteDe(html, 'research').match(
      /<li class="wf-pastille[^"]*" title="([^"]*)"/,
    );
    expect(pastille?.[1]).toContain('sources read: not verified');
  });

  it('une ligne sans contrôle non vérifié n’en affiche aucun', () => {
    const html = htmlWorkflows(lireWorkflows(ndjson([QUESTION_VERTE])));
    expect(carteDe(html, 'question')).not.toContain('not verified');
  });
});

// ─── La matrice activités × modèles (banc v2) ───────────────────────────────

/** Un catalogue minimal, de la forme que le banc écrit (`--catalog`). */
const CATALOGUE = {
  activities: ['question', 'excel', 'email', 'print'],
  needs: ['printer'],
  scenarios: [
    {
      id: 'question',
      version: 1,
      activity: 'question',
      title: 'A factual question, answered directly',
      green: 'x',
      set: 'nightly',
      needs: [],
      instruction: 'Quelle est la capitale ?',
    },
    {
      id: 'file',
      version: 1,
      activity: 'excel',
      title: 'An Excel file written in the workspace',
      green: 'x',
      set: 'nightly',
      needs: [],
      instruction: 'Crée un fichier',
    },
    {
      id: 'excel-new-sheet',
      version: 1,
      activity: 'excel',
      title: 'Add a sheet of averages',
      green: 'x',
      set: 'on-demand',
      needs: [],
      instruction: 'Ajoute une feuille',
    },
    {
      id: 'print',
      version: 1,
      activity: 'print',
      title: 'Print a short note',
      green: 'x',
      set: 'nightly',
      needs: ['printer'],
      instruction: 'Imprime',
    },
  ],
};

/** Une ligne du banc v2 : le modèle du root, les modèles par job, les livrables, la réponse. */
const QUESTION_V2 = {
  ...QUESTION_VERTE,
  startedAt: '2026-10-16T01:00:00.000Z',
  activity: 'question',
  needs: [],
  modelUnderTest: null,
  rootModel: 'z-ai/glm-5.3',
  cachedTokens: 20000,
  cacheWriteTokens: null,
  modelUse: [
    {
      job: '7042900c',
      agent: 'alfred',
      via: 'api',
      requested: 'z-ai/glm-5.3',
      effective: 'deepseek/deepseek-chat',
      provider: 'openrouter',
      reasoningEffort: 'high',
      failover: true,
      calls: 2,
      inputTokens: 33722,
      cachedTokens: 20000,
      outputTokens: 70,
      costUsd: 0.0358,
    },
  ],
  deliverables: [{ path: 'nodal-bench/x.txt', bytes: 12 }],
  answer: 'Canberra <b>',
};

/** Un essai sauté parce qu'un besoin manque : aucun modèle n'a tourné. */
const PRINT_SAUTE = {
  ...QUESTION_VERTE,
  scenario: 'print',
  title: 'Print a short note',
  startedAt: '2026-10-16T02:00:00.000Z',
  verdict: 'skipped',
  reasons: ['no agent of this workspace has request_print (no printer connector configured)'],
  models: [],
  rootModel: null,
  jobs: 0,
};

describe('la matrice activités × modèles', () => {
  const carteDe = (html, id) => {
    const debut = html.indexOf(`id="wf-${id}"`);
    return html.slice(debut, html.indexOf('</article>', debut));
  };

  it('suit l’ordre du catalogue, montre les scénarios jamais joués et les activités sans scénario', () => {
    const m = construireMatrice([QUESTION_VERTE, FICHIER_ROUGE], CATALOGUE);
    expect(m.activites.map((a) => a.activite)).toEqual(['question', 'excel', 'email', 'print']);
    expect(m.activites[1].scenarios.map((s) => s.id)).toEqual(['file', 'excel-new-sheet']);
    expect(m.activites[1].scenarios[1].cellules.size).toBe(0);
    expect(m.activites[2].scenarios).toEqual([]);
  });

  it('une ligne écrite avant la v2 prend son activité dans le catalogue', () => {
    const m = construireMatrice([FICHIER_ROUGE], CATALOGUE);
    expect(m.activites.find((a) => a.activite === 'excel').scenarios[0].cellules.size).toBe(1);
  });

  it('range une ligne dans la colonne du modèle RÉGLÉ : imposé par la matrice, sinon celui du root', () => {
    expect(colonneDe({ modelUnderTest: 'a', rootModel: 'b', models: ['c'] })).toBe('a');
    expect(colonneDe({ modelUnderTest: null, rootModel: 'b', models: ['c'] })).toBe('b');
  });

  it('une ligne d’avant la v2 va dans UNE colonne « Earlier runs (model not recorded) », jamais dans les modèles qui ont répondu', () => {
    expect(AVANT_LA_MATRICE).toBe('Earlier runs (model not recorded)');
    expect(colonneDe({ models: ['z-ai/glm-5.3', 'xiaomi/mimo-v2.6-pro'] })).toBe(AVANT_LA_MATRICE);
    expect(colonneDe({ models: [] })).toBe(AVANT_LA_MATRICE);
    const melange = { ...FICHIER_ROUGE, models: ['z-ai/glm-5.3', 'xiaomi/mimo-v2.6-pro'] };
    const m = construireMatrice([QUESTION_V2, QUESTION_VERTE, melange, PRINT_SAUTE], CATALOGUE);
    expect(m.colonnes).toEqual(['z-ai/glm-5.3', AVANT_LA_MATRICE]);
    // L'en-tête de cette colonne dit pourquoi elle existe ; celui d'un modèle n'a pas d'infobulle.
    const html = htmlMatrice(m);
    expect(html).toContain(
      '<div role="columnheader" title="Trials from before the model comparison: the model the run was set to was not recorded, so they cannot sit in a model&#39;s column.">Earlier runs (model not recorded)</div>',
    );
    expect(html).toContain('<div role="columnheader" class="mono">z-ai/glm-5.3</div>');
  });

  it('un sauté s’affiche en GRIS avec sa raison, jamais en rouge', () => {
    const html = htmlMatrice(construireMatrice([PRINT_SAUTE], CATALOGUE));
    expect(html).toContain('wf-c wf-c--skipped');
    // La raison est DITE dans la cellule, pas seulement au survol d'une barre.
    expect(html).toContain('<span class="wf-c__mot">Skipped</span>');
    expect(html).toMatch(
      /<span class="wf-c__raison"[^>]*>no agent of this workspace has request_print/,
    );
    expect(html).not.toContain('<span class="wf-c__mot">0/1 green</span>');
    expect(html).not.toContain('wf-c--red');
  });

  it('une activité sans essai sur un modèle est un tiret, pas « 0/n green · n not run »', () => {
    const html = htmlMatrice(construireMatrice([QUESTION_V2], CATALOGUE));
    const excel = html.slice(
      html.indexOf('id="wf-act-excel"'),
      html.indexOf('</summary>', html.indexOf('id="wf-act-excel"')),
    );
    expect(excel).toContain('<span class="wf-nd">–</span>');
    expect(excel).not.toContain('not run');
    expect(excel).not.toContain('green');
    // « not run » reste dit dans les lignes de scénario dépliées.
    expect(html).toContain('<span class="wf-nd">not run</span>');
  });

  it('résume chaque colonne : part de verts parmi les essais TENTÉS, médianes vertes, coût total', () => {
    const rouge = {
      ...QUESTION_V2,
      startedAt: '2026-10-16T03:00:00.000Z',
      verdict: 'red',
      costUsd: 0.1,
      durationMs: 90000,
    };
    const sansCout = { ...QUESTION_V2, startedAt: '2026-10-16T04:00:00.000Z', costUsd: null };
    const saute = { ...PRINT_SAUTE, rootModel: 'z-ai/glm-5.3' };
    const r = resumerColonne([QUESTION_V2, rouge, sansCout, saute]);
    expect(r).toEqual({
      tentes: 3,
      sautes: 1,
      verts: 2,
      dureeMs: 20952,
      coutMedianUsd: 0.0358,
      coutTotalUsd: 0.0358 + 0.1,
      coutInconnu: 1,
    });
    const html = htmlMatrice(construireMatrice([QUESTION_V2, rouge, sansCout, saute], CATALOGUE));
    expect(html).toContain(
      '<span class="wf-c__taux">67 % green <span class="wf-nd">(2/3)</span></span>',
    );
    expect(html).toContain('median 21 s · $0.036');
    expect(html).toContain('total $0.136 for 3 runs, 1 without a cost');
    expect(html).toContain('1 skipped, not counted');
  });

  it('dit en une phrase ce qui est comparé : les modèles, les essais par cellule, la période', () => {
    const plus = {
      ...QUESTION_V2,
      startedAt: '2026-10-18T03:00:00.000Z',
      rootModel: 'deepseek-chat',
    };
    const m = construireMatrice([QUESTION_V2, plus], CATALOGUE);
    expect(phraseComparaison(m)).toBe(
      '<p class="wf-compare">Comparing <b>2 models</b> (<span class="mono">z-ai/glm-5.3</span>, <span class="mono">deepseek-chat</span>), on the last 5 trials at most of each scenario, run from 2026-10-16 to 2026-10-18.</p>',
    );
    const html = htmlWorkflows({ lignes: [QUESTION_V2, plus], illisibles: 0 }, CATALOGUE);
    expect(html.indexOf('wf-compare')).toBeLessThan(html.indexOf('class="chapo"'));
    expect(phraseComparaison(construireMatrice([], CATALOGUE))).toContain('No trial yet');
    // La colonne des essais d'avant n'est pas un modèle : la phrase le dit à part.
    expect(
      phraseComparaison(construireMatrice([QUESTION_V2, QUESTION_VERTE], CATALOGUE)),
    ).toContain(
      'Comparing <b>1 model</b> (<span class="mono">z-ai/glm-5.3</span>) and the earlier runs, whose model was not recorded,',
    );
  });

  it('la phrase de comparaison et les comptes sont en tête du cadre de la matrice, avec sa gouttière', () => {
    const html = htmlWorkflows({ lignes: [QUESTION_V2], illisibles: 0 }, CATALOGUE);
    const tete = html.slice(
      html.indexOf('<div class="wf-panneau__tete">'),
      html.indexOf('<div class="wf-matrice-defile">'),
    );
    expect(tete).toContain('<p class="wf-compare">');
    expect(tete).toContain('<p class="chapo">');
    expect(html.indexOf('<div class="wf-panneau">')).toBeLessThan(
      html.indexOf('<div class="wf-panneau__tete">'),
    );
    expect(html.indexOf('<p class="wf-legende">')).toBeGreaterThan(
      html.indexOf('<div class="wf-matrice-defile">'),
    );
  });

  // Revue Reviewer A, passe 1 (P2-3) : une seule règle sur toute la page. Un
  // essai sauté n'a rien tenté : il n'entre dans aucun dénominateur, il est dit à part.
  it('un sauté n’entre dans aucun dénominateur : ni la cellule, ni la carte, ni le résumé', () => {
    const vert = QUESTION_V2;
    const rouge = { ...QUESTION_V2, startedAt: '2026-10-16T02:00:00.000Z', verdict: 'red' };
    const saute = {
      ...QUESTION_V2,
      startedAt: '2026-10-16T03:00:00.000Z',
      verdict: 'skipped',
      reasons: ['the stack was busy for 30 min'],
    };
    const vertApres = { ...QUESTION_V2, startedAt: '2026-10-16T04:00:00.000Z' };
    const lignes = [vert, rouge, saute, vertApres];
    const html = htmlWorkflows({ lignes, illisibles: 0 }, CATALOGUE);
    // La cellule du scénario.
    expect(html).toContain('<span class="wf-c__mot">2/3 green</span>');
    expect(html).toContain('<span class="wf-c__saute">1 skipped</span>');
    expect(html).not.toContain('2/4 green');
    // La carte, version par version.
    const c = carteDe(html, 'question');
    expect(c).toContain('<td>2/3 <span class="wf-nd">· 1 skipped</span></td>');
    expect(c).not.toContain('<td>2/4');
    // Le résumé de colonne, même règle.
    expect(html).toContain('(2/3)');
  });

  it('une cellule donne les derniers essais, le compte des verts et les médianes vertes', () => {
    const html = htmlMatrice(construireMatrice([QUESTION_VERTE], CATALOGUE));
    expect(html).toContain('<span class="wf-c__mot">1/1 green</span>');
    expect(html).toContain('21 s · $0.036');
    expect(html).toContain('href="#wf-question"');
    expect(html).toContain('<b>E-mail</b> <span class="wf-nd">no scenario yet</span>');
  });

  it('un sauté n’est pas « à regarder », un rouge l’est', () => {
    expect(workflowsARegarder({ lignes: [PRINT_SAUTE] })).toBe(0);
    expect(workflowsARegarder({ lignes: [FICHIER_ROUGE] })).toBe(1);
  });

  it('la carte d’une ligne v2 dit le modèle demandé → effectif, le secours, les livrables, la réponse échappée', () => {
    const html = htmlWorkflows({ lignes: [QUESTION_V2], illisibles: 0 }, CATALOGUE);
    const c = carteDe(html, 'question');
    expect(c).toContain('z-ai/glm-5.3 → deepseek/deepseek-chat');
    expect(c).toContain('fallback');
    expect(c).toContain('34 k (20 k) / 70');
    expect(c).toContain('nodal-bench/x.txt');
    expect(c).toContain('Canberra &lt;b&gt;');
  });

  it('le chemin d’une ligne d’avant le catalogue du 17/10 est « non enregistré », jamais « aucun outil »', () => {
    const c = carteDe(
      htmlWorkflows({ lignes: [QUESTION_V2], illisibles: 0 }, CATALOGUE),
      'question',
    );
    expect(c).toContain('Not recorded on this run (written before the catalogue of 2026-10-17).');
    expect(c).not.toContain('no tool');
  });

  it('le chemin d’une ligne qui le garde : les outils de chaque job dans l’ordre, la délégation, les liens vus et non vus', () => {
    const avecChemin = {
      ...QUESTION_V2,
      path: [
        { job: '41466740', agent: 'alfred', parent: null, tools: [] },
        {
          job: 'eee6c3ed',
          agent: 'researcher',
          parent: '41466740',
          tools: ['web_search', 'tavily_extract'],
        },
      ],
      delegatedTo: ['researcher'],
      links: [
        { url: 'arxiv.org/abs/1411.0172', seen: true },
        { url: 'nobelprize.org/prizes/physics/1978/summary', seen: false },
      ],
    };
    const c = carteDe(
      htmlWorkflows({ lignes: [avecChemin], illisibles: 0 }, CATALOGUE),
      'question',
    );
    expect(c).toContain('<span class="wf-nd">no tool</span>');
    expect(c).toContain(
      'researcher <span class="wf-nd">(delegated by 41466740)</span>: <span class="mono">web_search → tavily_extract</span>',
    );
    expect(c).toContain(
      '2 links cited: 1 seen in a web tool output, 1 not (<span class="mono">nobelprize.org/prizes/physics/1978/summary</span>).',
    );
  });

  it('la carte d’une ligne d’avant la v2 le dit, sans inventer', () => {
    const c = carteDe(htmlWorkflows({ lignes: [QUESTION_VERTE], illisibles: 0 }), 'question');
    expect(c).toContain('not recorded on this run (written before bench v2)');
  });

  it('lit le vrai catalogue du dépôt, et refuse un catalogue mal formé', () => {
    const c = lireCatalogue(
      readFileSync(new URL('./data/workflow-catalog.json', import.meta.url), 'utf8'),
    );
    expect(c.activities).toContain('orchestration');
    expect(c.scenarios.length).toBe(37);
    expect(c.renamed).toEqual({
      'deep-research-dna': 'deep-research-report',
      'comfy-portrait': 'comfy-exact-size',
    });
    expect(() => lireCatalogue('{"activities":[]}')).toThrow('does not have the shape');
    expect(() => lireCatalogue('pas du json')).toThrow('is not JSON');
  });
});

// Un identifiant qui nommait un sujet que le scénario ne teste plus est renommé
// (catalogue du 17/10 : deep-research-dna → deep-research-report). Ses lignes
// restent sous l'ancien identifiant, une série CLOSE : jamais rangée sous le
// nouveau, jamais comptée dans les résumés ni dans les « à regarder ».
describe('une série close (identifiant renommé ou retiré)', () => {
  const carteDe = (html, id) => {
    const debut = html.indexOf(`id="wf-${id}"`);
    return html.slice(debut, html.indexOf('</article>', debut));
  };
  const CAT_RENOMME = {
    activities: ['deep-research'],
    needs: [],
    renamed: { 'deep-research-dna': 'deep-research-report' },
    scenarios: [
      {
        id: 'deep-research-report',
        version: 1,
        activity: 'deep-research',
        title: 'In-depth research delivered as a Markdown report',
        green: 'x',
        set: 'on-demand',
        needs: [],
      },
    ],
  };
  const base = { ...QUESTION_V2, activity: 'deep-research', rootModel: 'z-ai/glm-5.3' };
  const ANCIENNE = {
    ...base,
    scenario: 'deep-research-dna',
    scenarioVersion: 2,
    title: 'An in-depth report on the discovery of the DNA double helix',
    startedAt: '2026-10-10T01:00:00.000Z',
    verdict: 'red',
    reasons: ['the report does not name Photo 51'],
  };
  const NOUVELLE = {
    ...base,
    scenario: 'deep-research-report',
    scenarioVersion: 1,
    title: 'In-depth research delivered as a Markdown report',
    startedAt: '2026-10-18T01:00:00.000Z',
    verdict: 'green',
    reasons: [],
  };

  it('les lignes de l’ancien identifiant restent sous lui, marquées close et renommée ; la nouvelle série ne porte que les siennes', () => {
    const m = construireMatrice([ANCIENNE, NOUVELLE], CAT_RENOMME);
    const scen = m.activites[0].scenarios;
    expect(scen.map((s) => [s.id, s.close])).toEqual([
      ['deep-research-report', null],
      ['deep-research-dna', { renommeEn: 'deep-research-report' }],
    ]);
    const cell = (id) => scen.find((s) => s.id === id).cellules.get('z-ai/glm-5.3');
    expect(cell('deep-research-report').derniers.map((l) => l.verdict)).toEqual(['green']);
    expect(cell('deep-research-dna').derniers.map((l) => l.verdict)).toEqual(['red']);
  });

  it('une série close n’entre dans aucun résumé : la colonne et l’activité ne comptent que la série ouverte', () => {
    const m = construireMatrice([ANCIENNE, NOUVELLE], CAT_RENOMME);
    expect(m.resumes.get('z-ai/glm-5.3')).toMatchObject({ tentes: 1, verts: 1 });
    expect(m.activites[0].resumes.get('z-ai/glm-5.3')).toMatchObject({ tentes: 1, verts: 1 });
  });

  it('son dernier rouge n’est pas « à regarder » ; sans catalogue, rien n’est dit clos', () => {
    expect(workflowsARegarder({ lignes: [ANCIENNE, NOUVELLE] }, CAT_RENOMME)).toBe(0);
    expect(workflowsARegarder({ lignes: [ANCIENNE, NOUVELLE] })).toBe(1);
  });

  it('la page le dit : la carte de la série close, et le chapô qui la compte à part', () => {
    const html = htmlWorkflows({ lignes: [ANCIENNE, NOUVELLE], illisibles: 0 }, CAT_RENOMME);
    expect(carteDe(html, 'deep-research-dna')).toContain(
      'closed series</span> <span class="wf-nd">renamed <span class="mono">deep-research-report</span>',
    );
    expect(carteDe(html, 'deep-research-report')).not.toContain('closed series');
    expect(html).toContain('<b>0 not green on their last run</b>');
    expect(html).toContain('1 closed series (retired or renamed), counted in none of these');
  });

  it('un identifiant retiré sans successeur est dit retiré', () => {
    const retire = { ...ANCIENNE, scenario: 'research-penicillin' };
    const html = htmlWorkflows({ lignes: [retire, NOUVELLE], illisibles: 0 }, CAT_RENOMME);
    expect(carteDe(html, 'research-penicillin')).toContain('retired from the catalogue');
  });
});
