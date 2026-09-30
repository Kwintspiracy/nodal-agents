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
