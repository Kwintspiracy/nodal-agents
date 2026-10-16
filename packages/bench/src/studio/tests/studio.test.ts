// studio.test.ts — la couche serveur de Bench Studio.
//
// Ce que ces cas prouvent : Bench Studio ne joue aucune session (son module
// n'expose que des lectures ; lancer attend #769), et ses lectures ne rendent
// que ce que les modules du banc calculent (catalogue, fixtures, plan,
// modèles, résultats, livrables).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readFixture,
  studioCatalog,
  studioModels,
  studioPlan,
  studioResults,
  studioTrial,
} from '../data';
import { createStudioRuntime, findDeliverable } from '../runtime';
import { SCENARIOS } from '../../workflows/scenarios';

describe('Bench Studio plays no session (launch waits for #769)', () => {
  it('the studio module exposes reads only: nothing that starts, gates or cancels a session', async () => {
    const studio = await import('../index');
    expect(Object.keys(studio).sort()).toEqual([
      'ACTIVITIES',
      'AVANT_LA_MATRICE',
      'FIXTURES_DIR',
      'LAUNCH_DISABLED_REASON',
      'aideDeColonne',
      'createStudioRuntime',
      'dollars',
      'duree',
      'findDeliverable',
      'nombreJetons',
      'readFixture',
      'readResultLines',
      'stackWebUrl',
      'studioCatalog',
      'studioModels',
      'studioNeeds',
      'studioPlan',
      'studioResults',
      'studioTrial',
    ]);
    expect(studio.LAUNCH_DISABLED_REASON).toBe(
      'Trials are not pinned to the bench space yet (#769).',
    );
  });

  it('the runtime reads the stack and has no way to run anything', () => {
    // Construire le runtime n'ouvre rien : seules ses lectures touchent la base.
    expect(Object.keys(createStudioRuntime()).sort()).toEqual(['deliverable', 'models', 'needs']);
  });
});

describe('studio reads', () => {
  it('the catalog carries every scenario, how it is judged, and its fixture files', () => {
    const c = studioCatalog();
    expect(c.scenarios).toHaveLength(SCENARIOS.length);
    const edit = c.scenarios.find((s) => s.id === 'excel-edit-column')!;
    expect(edit.judgedBy.length).toBeGreaterThan(2);
    expect(c.fixtureFiles['excel-edit-column']).toEqual([
      { path: 'office/stock.xlsx', bytes: expect.any(Number) as number },
    ]);
    expect(c.fixtureFiles['code-http-server']!.map((f) => f.path)).toContain(
      'code/http-somme/test/server.js',
    );
  });

  it('reads a fixture file, and nothing outside the fixtures folder', () => {
    expect(readFixture('office/meteo.csv')).toMatchObject({ kind: 'text' });
    expect(readFixture('office/stock.xlsx')).toMatchObject({ kind: 'binary', type: 'xlsx' });
    expect(() => readFixture('../package.json')).toThrow('studio_no_fixture');
    expect(() => readFixture('office/../../src/index.ts')).toThrow('studio_no_fixture');
  });

  it("plans with the bench selection rules: no models means the agents' own, owner scenarios never in a matrix", () => {
    const none = studioPlan({ selection: { activity: ['excel'] }, models: '', trials: 2 });
    expect(none.columns).toEqual(["the agents' own models"]);
    expect(none.plan.cells.map((c) => [c.scenario, c.model, c.trials])).toEqual([
      ['file', "the agents' own models", 2],
      ['excel-edit-column', "the agents' own models", 2],
      ['excel-new-sheet', "the agents' own models", 2],
      ['excel-read-answer', "the agents' own models", 2],
      ['excel-csv-import', "the agents' own models", 2],
    ]);
    expect(none.scenarios).toEqual([
      'file',
      'excel-edit-column',
      'excel-new-sheet',
      'excel-read-answer',
      'excel-csv-import',
    ]);
    const priced = studioPlan({
      selection: { only: ['question'] },
      models: 'deepseek-chat',
      trials: 1,
    });
    expect(priced.plan.cells).toHaveLength(1);
    expect(priced.columns).toEqual(['deepseek:deepseek-chat']);
    expect(() =>
      studioPlan({ selection: { only: ['comfyui-telegram'] }, models: 'deepseek-chat', trials: 1 }),
    ).toThrow('workflow_owner_sends_in_matrix');
  });

  it('results come from results.ts, each trial keeping its line number', () => {
    const d = mkdtempSync(join(tmpdir(), 'studio-res-'));
    const f = join(d, 'w.ndjson');
    const base = {
      scenario: 'question',
      scenarioVersion: 1,
      rootModel: 'm1',
      startedAt: '2026-10-16T01:00:00Z',
      durationMs: 10_000,
      costUsd: 0.01,
    };
    writeFileSync(
      f,
      [
        JSON.stringify({ ...base, verdict: 'green' }),
        'not json',
        JSON.stringify({
          ...base,
          verdict: 'red',
          startedAt: '2026-10-16T02:00:00Z',
          reasons: ['x'],
        }),
      ].join('\n'),
    );
    const r = studioResults(f);
    expect(r.unreadable).toBe(1);
    expect(r.columns).toEqual(['m1']);
    expect(r.summaries[0]).toMatchObject({ column: 'm1', tentes: 2, verts: 1 });
    // La cellule activité × modèle : le même résumé, restreint à l'activité.
    expect(r.activities.find((a) => a.activity === 'question')!.summaries).toEqual([
      expect.objectContaining({ column: 'm1', tentes: 2, verts: 1, dureeMs: 10_000 }),
    ]);
    expect(r.activities.find((a) => a.activity === 'excel')!.summaries).toEqual([
      expect.objectContaining({ column: 'm1', tentes: 0, verts: 0, dureeMs: null }),
    ]);
    const q = r.activities
      .find((a) => a.activity === 'question')!
      .scenarios.find((s) => s.id === 'question')!;
    expect(q.cells[0]!.last.map((l) => [l.n, l.verdict])).toEqual([
      [1, 'green'],
      [3, 'red'],
    ]);
    expect(studioTrial(3, f).line).toMatchObject({ verdict: 'red', reasons: ['x'] });
    expect(() => studioTrial(2, f)).toThrow('studio_no_trial');
  });
});

describe('findDeliverable', () => {
  function root(files: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), 'studio-ws-'));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(d, rel, '..'), { recursive: true });
      writeFileSync(join(d, rel), text);
    }
    return d;
  }

  it('opens a file the trial left under nodal-bench/, and says which folder holds it', () => {
    const a = root({ 'nodal-bench/file/v1/notes.md': '# Notes' });
    const b = root({});
    expect(findDeliverable([b, a], 'nodal-bench/file/v1/notes.md')).toEqual({
      kind: 'text',
      root: a,
      text: '# Notes',
    });
  });

  it('refuses anything outside nodal-bench/, a missing file, and the same path in two folders', () => {
    const a = root({ 'secret.txt': 'x', 'nodal-bench/s/v1/r.csv': 'a' });
    const b = root({ 'nodal-bench/s/v1/r.csv': 'b' });
    expect(() => findDeliverable([a], 'secret.txt')).toThrow('studio_no_deliverable');
    expect(() => findDeliverable([a], 'nodal-bench/../secret.txt')).toThrow(
      'studio_no_deliverable',
    );
    expect(() => findDeliverable([a], 'nodal-bench/s/v1/none.csv')).toThrow(
      'is in no workspace folder any more',
    );
    expect(() => findDeliverable([a, b], 'nodal-bench/s/v1/r.csv')).toThrow(
      'studio_ambiguous_deliverable: nodal-bench/s/v1/r.csv exists in 2 workspace folders',
    );
  });
});

describe('studioModels', () => {
  it('lists first the models the bench space holds a key for, OpenRouter first, with their catalog price', () => {
    const models = studioModels({ providers: ['openrouter', 'deepseek'] });
    const firstUnavailable = models.findIndex((m) => m.unavailable !== null);
    const available = models.slice(0, firstUnavailable);
    expect(available.length).toBeGreaterThan(0);
    expect(available.every((m) => m.provider === 'openrouter' || m.provider === 'deepseek')).toBe(
      true,
    );
    // OpenRouter d'abord, puis l'autre fournisseur qui a une clé.
    const lastOpenRouter = available.map((m) => m.provider).lastIndexOf('openrouter');
    expect(available.slice(0, lastOpenRouter + 1).every((m) => m.provider === 'openrouter')).toBe(
      true,
    );
    expect(available.find((m) => m.key === 'deepseek:deepseek-chat')).toMatchObject({
      unavailable: null,
    });
    const glm = models.find((m) => m.key === 'openrouter:z-ai/glm-5.3')!;
    expect(glm.pricing).toEqual({
      inputPerMillionUsd: expect.any(Number) as number,
      outputPerMillionUsd: expect.any(Number) as number,
    });
    // Tout le reste est rendu indisponible, avec la raison : jamais proposé comme appelable.
    const rest = models.slice(firstUnavailable);
    expect(rest.every((m) => m.provider !== 'openrouter' && m.provider !== 'deepseek')).toBe(true);
    expect(rest.find((m) => m.provider === 'minimax')!.unavailable).toBe(
      'the bench space has no minimax key',
    );
  });

  it('keys that could not be read make every model unavailable, and say why', () => {
    const models = studioModels({ why: 'workflow_no_stack: config.json is missing' });
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((m) => m.unavailable))).toEqual(
      new Set([
        'the bench space keys could not be read: workflow_no_stack: config.json is missing',
      ]),
    );
  });
});
