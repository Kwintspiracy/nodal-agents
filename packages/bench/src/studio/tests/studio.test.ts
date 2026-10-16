// studio.test.ts — la couche serveur de Bench Studio.
//
// Ce que ces cas prouvent : la porte de lancement est tenue CÔTÉ SERVEUR (une
// requête est refusée, pas seulement un bouton grisé), un scénario qui envoie
// au propriétaire exige l'interrupteur explicite, un lancement suit la session
// du banc étape par étape, et les lectures ne rendent que ce que les modules du
// banc calculent (catalogue, fixtures, plan, résultats).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { launchGate } from '../launch-gate';
import { readFixture, studioCatalog, studioPlan, studioResults, studioTrial } from '../data';
import { RunManager, type RunEvent, type SessionRunner } from '../runs';
import { findDeliverable } from '../runtime';
import { SCENARIOS } from '../../workflows/scenarios';

const OPEN = { enabled: true, reason: 'ok' };
const CLOSED = { enabled: false, reason: 'PR #758 not merged' };

function repoWith(scripts: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'studio-repo-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts }));
  return d;
}
const spawned = (status: number | null, stdout = ''): SpawnSyncReturns<string> =>
  ({ status, stdout, stderr: '', pid: 1, output: [], signal: null }) as SpawnSyncReturns<string>;

describe('launchGate', () => {
  it('without the bench space script, launch is disabled and says why', () => {
    const g = launchGate(repoWith({}), () => {
      throw new Error('must not run anything');
    });
    expect(g.enabled).toBe(false);
    expect(g.reason).toMatch(/bench space.*PR #758, not merged yet/);
  });

  it('with the script, it runs `pnpm bench:space check` and opens only on exit 0', () => {
    const calls: string[][] = [];
    const ok = launchGate(repoWith({ 'bench:space': 'x' }), (cmd, args) => {
      calls.push([cmd, ...args]);
      return spawned(0);
    });
    expect(calls).toEqual([['pnpm', 'bench:space', 'check']]);
    expect(ok.enabled).toBe(true);
    const ko = launchGate(repoWith({ 'bench:space': 'x' }), () =>
      spawned(1, 'the bench team has a send-capable tool: gmail_send_email\n'),
    );
    expect(ko).toEqual({
      enabled: false,
      reason:
        '`pnpm bench:space check` did not pass (exit 1): the bench team has a send-capable tool: gmail_send_email',
    });
  });
});

describe('RunManager', () => {
  const quiet: SessionRunner = async () => ({ lines: [], failed: 0, skipped: 0 });

  it('refuses to launch while the gate is closed, and plays nothing', () => {
    let played = 0;
    const m = new RunManager(
      () => CLOSED,
      async (...a) => {
        played++;
        return quiet(...a);
      },
      async () => undefined,
    );
    expect(() =>
      m.launch({ selection: { only: ['question'] }, trials: 1, allowOwnerSends: false }),
    ).toThrow('studio_launch_refused: PR #758 not merged');
    expect(played).toBe(0);
  });

  it('refuses a scenario that sends to the owner without the explicit toggle', () => {
    const m = new RunManager(
      () => OPEN,
      quiet,
      async () => undefined,
    );
    expect(() =>
      m.launch({ selection: { only: ['comfyui-telegram'] }, trials: 1, allowOwnerSends: false }),
    ).toThrow(/studio_owner_sends: comfyui-telegram sends to the owner/);
  });

  it('streams the session: trial start, progress, trial end, done — past events replayed to a late listener', async () => {
    const line = { scenario: 'question', verdict: 'green' } as never;
    let finish!: () => void;
    const runner: SessionRunner = async (run, _stop, hooks) => {
      expect(run.scenarios.map((s) => s.id)).toEqual(['question']);
      hooks.trialStart?.(run.scenarios[0]!, 1, 1);
      hooks.progress?.(run.scenarios[0]!, 1, { step: 'started', rootJobId: 'r1' });
      hooks.trialEnd?.(run.scenarios[0]!, 1, line);
      await new Promise<void>((r) => (finish = r));
      return { lines: [line], failed: 0, skipped: 0 };
    };
    let t = 1000;
    const m = new RunManager(
      () => OPEN,
      runner,
      async () => undefined,
      () => t++,
    );
    const state = m.launch({
      selection: { only: ['question'] },
      trials: 1,
      allowOwnerSends: false,
    });
    // Un second lancement pendant le premier est refusé.
    expect(() =>
      m.launch({ selection: { only: ['question'] }, trials: 1, allowOwnerSends: false }),
    ).toThrow('studio_busy');
    const seen: RunEvent['type'][] = [];
    m.subscribe(state.id, (e) => seen.push(e.type));
    expect(seen).toEqual(['trial-start', 'progress', 'trial-end']);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['trial-start', 'progress', 'trial-end', 'done']);
    expect(m.get(state.id)!.finished).toBe(true);
  });

  it('cancel goes through the shared stop', async () => {
    const cancelled: unknown[] = [];
    const m = new RunManager(
      () => OPEN,
      () => new Promise(() => undefined),
      async (stop) => {
        cancelled.push(stop);
      },
    );
    const state = m.launch({
      selection: { only: ['question'] },
      trials: 1,
      allowOwnerSends: false,
    });
    await m.cancel(state.id);
    expect(cancelled).toHaveLength(1);
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
