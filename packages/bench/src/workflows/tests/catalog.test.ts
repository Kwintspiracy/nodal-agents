// catalog.test.ts — le catalogue que lit le portail est celui du code.
//
// Le portail range la matrice par activité et montre les scénarios jamais
// joués à partir de apps/qa/data/workflow-catalog.json. Un scénario ajouté sans
// réécrire ce fichier serait absent du portail, en silence : ce test le refuse.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, catalogText } from '../catalog';
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

  it('the activities asked for phase 1 have at least four scenarios each', () => {
    const per = (a: string): number => SCENARIOS.filter((s) => s.activity === a).length;
    const short = [
      'question',
      'research',
      'deep-research',
      'code',
      'excel',
      'word',
      'powerpoint',
      'pdf',
      'html-page',
      'image-comfyui',
      'print',
      'orchestration',
    ]
      .map((a) => ({ activity: a, scenarios: per(a) }))
      .filter((x) => x.scenarios < 4);
    expect(short).toEqual([]);
  });

  it('no new scenario names a real recipient: no e-mail address but the reserved .invalid one', () => {
    for (const s of SCENARIOS) {
      const mails = s.instruction.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
      for (const m of mails) expect(m).toMatch(/\.invalid$/);
    }
  });
});
