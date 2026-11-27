// wait-measure.test.ts — la mesure de #1071 lit ce qu'un essai a laissé, et le juge juste.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CAMPAIGN_CONFIG_FILE, loadCampaignConfig } from '../../campaign/config';
import { BENCH_DIR } from '../../workflows/paths';
import { TreeFactsSchema, type TreeFacts } from '../../workflows/facts';
import { writeRecord } from '../record';
import { measureCampaign, measureTrial, saysPrinted, summarise } from '../wait-measure';

const root = mkdtempSync(join(tmpdir(), 'wait-measure-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T0 = 1_800_000_000_000;
const PRINT_MS = 20_000;
const STATUS = 'bench_printer__get_print_request';

function facts(
  calls: Array<{ input: Record<string, unknown>; at: number }>,
  answer: string,
  answerMs: number,
): TreeFacts {
  return TreeFactsSchema.parse({
    rootId: 'job-1',
    entityId: 'e',
    jobs: [
      {
        id: 'job-1',
        parentJobId: null,
        agentSlug: 'chef',
        status: 'completed',
        channel: 'mcp',
        result: answer,
        error: null,
        createdMs: T0 - 5_000,
        updatedMs: answerMs,
      },
    ],
    toolCalls: [
      {
        jobId: 'job-1',
        toolName: 'bench_printer__request_print',
        input: '{}',
        output: null,
        createdMs: T0,
      },
      ...calls.map((c) => ({
        jobId: 'job-1',
        toolName: STATUS,
        input: JSON.stringify(c.input),
        output: null,
        createdMs: c.at,
      })),
    ],
    llmCalls: [],
    approvals: [],
  });
}

function job(dir: string) {
  mkdirSync(dir, { recursive: true });
  return writeRecord(
    dir,
    {
      source: { kind: 'content', contentFormat: 'html' },
      bytes: Buffer.from('<p>pain</p>'),
      pages: 1,
      pagesBasis: 'html-estimate',
      images: [],
      arguments: {},
      printMs: PRINT_MS,
    },
    T0,
  );
}

describe('the #1071 measurement', () => {
  it('a run that waited after the job was accepted, answered once it was completed', () => {
    const rec = job(join(root, 'a'));
    const r = measureTrial(
      '001-print',
      facts(
        [{ input: { id: rec.id, waitSeconds: 30 }, at: T0 + PRINT_MS + 100 }],
        'Imprimé : 1 page est sortie.',
        T0 + PRINT_MS + 2_000,
      ),
      [rec],
    );
    expect(r).toMatchObject({
      jobId: rec.id,
      waits: [30],
      waited: true,
      stateAtAnswer: 'completed',
      saysPrinted: true,
      saysPrintedTooEarly: false,
      problems: [],
    });
  });

  it('a run that answered at once, saying printed while the job was only accepted', () => {
    const rec = job(join(root, 'b'));
    const r = measureTrial(
      '002-print',
      facts([{ input: { id: rec.id }, at: T0 + 500 }], 'Your list was printed.', T0 + 1_000),
      [rec],
    );
    expect(r).toMatchObject({
      waits: [],
      waited: false,
      stateAtAnswer: 'accepted',
      saysPrinted: true,
      saysPrintedTooEarly: true,
    });
  });

  it('"not printed yet" and "still printing" are not "printed"', () => {
    expect(saysPrinted('The job was accepted, not printed yet.')).toBe(false);
    expect(saysPrinted("La demande est acceptée, elle n'a pas encore été imprimée.")).toBe(false);
    expect(saysPrinted('It is still printing.')).toBe(false);
    expect(saysPrinted('La page est imprimée.')).toBe(true);
  });

  it('reads a campaign evidence folder as export.ts writes it, and counts', () => {
    const campaign = join(root, 'campaign');
    const trial = join(campaign, '001-print');
    const rec = job(join(trial, 'files', '1-bench-printer-records'));
    writeFileSync(
      join(trial, 'facts.json'),
      JSON.stringify(
        facts(
          [{ input: { id: rec.id, waitSeconds: 10 }, at: T0 + 11_000 }],
          'Still printing.',
          T0 + 12_000,
        ),
      ),
    );
    mkdirSync(join(campaign, '002-print'));
    const runs = measureCampaign(campaign, 'print');
    expect(runs.map((r) => [r.trial, r.waited, r.stateAtAnswer])).toEqual([
      ['001-print', true, 'printing'],
      ['002-print', false, null],
    ]);
    expect(summarise(runs)).toEqual({ runs: 2, waited: 1, saysPrintedTooEarly: 0, unjudged: 1 });
  });

  it('its configuration loads, prints in 20 s, and banc.json does not print', () => {
    const c = loadCampaignConfig(join(BENCH_DIR, 'campaign', 'print-wait.json'));
    expect(c.agents.find((a) => a.slug === 'chef')!.printConnector).toMatchObject({
      printSeconds: 20,
    });
    const banc = loadCampaignConfig(CAMPAIGN_CONFIG_FILE);
    expect(
      banc.agents.every(
        (a) => a.printConnector === null || a.printConnector.printSeconds === undefined,
      ),
    ).toBe(true);
  });
});
