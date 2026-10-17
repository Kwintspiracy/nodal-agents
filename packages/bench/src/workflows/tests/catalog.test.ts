// catalog.test.ts — le catalogue que lit le portail est celui du code.
//
// Le portail range la matrice par activité et montre les scénarios jamais
// joués à partir de apps/qa/data/workflow-catalog.json. Un scénario ajouté sans
// réécrire ce fichier serait absent du portail, en silence : ce test le refuse.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENAMED_IDS, buildCatalog, catalogText } from '../catalog';
import { FIXTURES_DIR } from '../fixtures';
import { NEED_IDS } from '../needs';
import { SCENARIOS } from '../scenarios';
import { ACTIVITIES } from '../types';

const FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'apps',
  'qa',
  'data',
  'workflow-catalog.json',
);

describe('the workflow catalog', () => {
  it('apps/qa/data/workflow-catalog.json is exactly what the code builds (rewrite it with --catalog)', () => {
    expect(readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(catalogText());
  });

  it('every scenario has a known activity, known needs, a one-line green and a French request', () => {
    const c = buildCatalog();
    expect(c.scenarios).toHaveLength(SCENARIOS.length);
    for (const s of c.scenarios) {
      expect(ACTIVITIES).toContain(s.activity);
      for (const n of s.needs) expect(NEED_IDS).toContain(n);
      expect(s.green.length).toBeGreaterThan(20);
      expect(s.green).not.toMatch(/\n/);
      // Une demande française porte au moins un mot ou un signe que l'anglais n'a pas.
      expect(s.instruction).toMatch(/[éèêàçùœ«»]|\b(le|la|les|du|des|dans|une?)\b/i);
    }
  });

  it('every scenario says how it is judged, and every fixture it declares exists', () => {
    for (const s of SCENARIOS) {
      expect({ id: s.id, judged: s.judgedBy.length > 0 }).toEqual({ id: s.id, judged: true });
      for (const j of s.judgedBy) expect(j.trim().length).toBeGreaterThan(10);
      for (const f of s.fixtures ?? []) {
        expect(existsSync(join(FIXTURES_DIR, f.from))).toBe(true);
        expect(f.to.startsWith('nodal-bench/')).toBe(true);
      }
      for (const o of s.outputs ?? []) expect(o.startsWith('nodal-bench/')).toBe(true);
    }
  });

  // Le catalogue validé par Quentin le 17/10 (page « Refonte du catalogue du
  // banc ») : un scénario par façon d'échouer, rangé par activité, dans cet
  // ordre. Le scénario mémoire attend que le banc sache enchaîner deux
  // conversations (une demande en plusieurs étapes) : il n'est pas dans ce lot.
  const CATALOG_OF_2026_10_17: Record<string, string[]> = {
    question: ['question', 'question-weekday'],
    research: ['research'],
    'deep-research': ['deep-research-report', 'deep-research-obsidian'],
    code: ['code-bugfix', 'code-http-server', 'code-install-dep', 'code'],
    excel: ['file', 'excel-edit-column', 'excel-read-answer', 'excel-csv-import'],
    word: ['word-create', 'word-replace', 'word-append', 'word-read-answer'],
    powerpoint: ['ppt-create', 'ppt-append', 'ppt-replace', 'ppt-read-answer'],
    pdf: ['pdf-read-total', 'pdf-from-markdown'],
    'html-page': ['html-landing', 'html-table-csv', 'html-edit'],
    'image-comfyui': ['comfy-exact-size', 'comfy-variants', 'comfyui-telegram'],
    print: ['print', 'print-file', 'recipe'],
    orchestration: [
      'mcp-answer',
      'undoable-action',
      'undoable-action-delegated',
      'delegate-fails',
      'ask-before-acting',
    ],
  };
  const DROPPED = [
    'question-percent',
    'question-seconds',
    'question-river',
    'research-penicillin',
    'research-transistor',
    'research-rabies',
    'research-voyager',
    'deep-research-gps',
    'deep-research-gutenberg',
    'deep-research-apollo',
    'excel-new-sheet',
    'word-table',
    'pdf-read-pages',
    'pdf-create',
    'html-svg-chart',
    'comfy-square',
    'comfy-landscape',
    'print-list',
    'code-data',
  ];

  it('is the catalogue of 2026-10-17: these scenarios, in this order, by activity', () => {
    const got: Record<string, string[]> = {};
    for (const s of SCENARIOS) (got[s.activity] ??= []).push(s.id);
    expect(got).toEqual(CATALOG_OF_2026_10_17);
    expect(SCENARIOS).toHaveLength(37);
    expect(SCENARIOS.map((s) => s.id).filter((id) => DROPPED.includes(id))).toEqual([]);
  });

  it('a renamed id points to a scenario of the catalogue, and its old id is gone from it (a closed series)', () => {
    const ids = SCENARIOS.map((s) => s.id);
    for (const [old, now] of Object.entries(RENAMED_IDS)) {
      expect({ old, inCatalogue: ids.includes(old) }).toEqual({ old, inCatalogue: false });
      expect({ now, inCatalogue: ids.includes(now) }).toEqual({ now, inCatalogue: true });
    }
    expect(buildCatalog().renamed).toEqual({
      'deep-research-dna': 'deep-research-report',
      'comfy-portrait': 'comfy-exact-size',
    });
  });

  it('every card says its path and its deliverable; a subject scenario carries the {subject} slot', () => {
    for (const s of buildCatalog().scenarios) {
      expect({ id: s.id, path: s.path.length > 15, deliverable: s.deliverable.length > 5 }).toEqual(
        {
          id: s.id,
          path: true,
          deliverable: true,
        },
      );
      expect({ id: s.id, slot: s.instruction.includes('{subject}') }).toEqual({
        id: s.id,
        slot: s.subject !== null,
      });
    }
    expect(buildCatalog().measured.length).toBeGreaterThan(3);
  });

  it('no new scenario names a real recipient: no e-mail address but the reserved .invalid one', () => {
    for (const s of SCENARIOS) {
      const mails = s.instruction.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
      for (const m of mails) expect(m).toMatch(/\.invalid$/);
    }
  });
});
