// cli.ts — `pnpm bench`
//
//   pnpm bench                       toutes les sections hors-ligne, diff vs baseline
//   pnpm bench --section gate        une seule section
//   pnpm bench --online              ajoute les sections qui appellent un tiers
//   pnpm bench --update              accepte les mesures courantes comme baseline
//   pnpm bench --list                les sections, ce qu'elles gardent, leurs tests
//   pnpm bench --json <fichier>      écrit le run complet
//
// Exit code 1 dès qu'une section régresse — utilisable en CI telle quelle.

import { writeFileSync } from 'node:fs';
import { ALL_SECTIONS, OFFLINE_SECTIONS, ONLINE_SECTIONS, sectionById } from './sections/index';
import { runSections, gitSha } from './run';
import { saveBaseline, loadBaseline } from './baseline';
import type { BenchRun, MetricDiff, SectionDiff } from './types';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const SIGN: Record<MetricDiff['verdict'], string> = {
  new: '·',
  unchanged: ' ',
  improved: '↑',
  regressed: '⚠',
  gone: '✖',
};

function fmtDiff(d: MetricDiff): string {
  const before = d.before === null ? '—' : String(d.before);
  const after = d.after === null ? '—' : String(d.after);
  const move = d.delta === null || d.delta === 0 ? '' : ` (${d.delta > 0 ? '+' : ''}${d.delta})`;
  return `  ${SIGN[d.verdict]} ${d.label}: ${before} → ${after}${move} ${d.unit}`;
}

function printSection(s: SectionDiff): void {
  const head = s.regressed ? `✖ ${s.label}` : `✔ ${s.label}`;
  console.log(`\n${head}`);
  if (s.error) {
    console.log(`  ERREUR: ${s.error}`);
    return;
  }
  for (const d of s.diffs) {
    console.log(fmtDiff(d));
    // Details only where they change a decision: a regression, or a metric
    // seen for the first time. Printing them always buries the signal.
    if (d.detail?.length && (d.verdict === 'regressed' || d.verdict === 'new')) {
      for (const line of d.detail.slice(0, 10)) console.log(`      ${line}`);
      if (d.detail.length > 10) console.log(`      … ${d.detail.length - 10} de plus`);
    }
  }
}

function listSections(): void {
  console.log('Sections du banc\n');
  for (const s of ALL_SECTIONS) {
    const online = ONLINE_SECTIONS.includes(s) ? '  [--online]' : '';
    const base = loadBaseline(s.id);
    console.log(`${s.id}${online}`);
    console.log(`  ${s.label}`);
    console.log(`  Garde: ${s.why}`);
    console.log(
      `  Baseline: ${base ? `${base.gitSha} (${base.acceptedAt.slice(0, 10)})` : 'aucune'}`,
    );
    if (s.tests.length > 0) {
      console.log('  Tests couvrant cette section:');
      for (const t of s.tests) {
        const [filter, path] = t.split(':');
        console.log(`    pnpm --filter ${filter} exec vitest run ${path}`);
      }
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  if (flag('list')) {
    listSections();
    return;
  }

  const only = arg('section');
  let sections = flag('online') ? [...OFFLINE_SECTIONS, ...ONLINE_SECTIONS] : [...OFFLINE_SECTIONS];
  if (only) {
    const s = sectionById(only);
    if (!s) {
      console.error(
        `Section inconnue: ${only}\nConnues: ${ALL_SECTIONS.map((x) => x.id).join(', ')}`,
      );
      process.exit(2);
    }
    sections = [s];
  }

  const startedAt = new Date().toISOString();
  const sha = gitSha();
  console.log(`Banc d'essai — ${sections.length} section(s) · ${sha}`);

  const { results, diffs } = await runSections(sections);

  for (const d of diffs) printSection(d);

  if (flag('update')) {
    // Refuse to bless a section that errored: its metrics are empty, and
    // writing them would erase the previous good numbers.
    let written = 0;
    for (const r of results) {
      if (r.error) {
        console.log(`\n(baseline NON mise à jour pour ${r.sectionId} — la section a échoué)`);
        continue;
      }
      saveBaseline(r, sha, startedAt);
      written++;
    }
    console.log(`\n${written} baseline(s) acceptée(s) à ${sha}.`);
  }

  const json = arg('json');
  if (json) {
    const run: BenchRun = { startedAt, gitSha: sha, sections: results };
    writeFileSync(json, `${JSON.stringify({ run, diffs }, null, 2)}\n`, 'utf-8');
    console.log(`\nRun écrit: ${json}`);
  }

  const regressed = diffs.filter((d) => d.regressed);
  if (regressed.length > 0 && !flag('update')) {
    console.log(
      `\n${regressed.length} section(s) en régression: ${regressed.map((d) => d.sectionId).join(', ')}`,
    );
    console.log("Si c'est voulu, relance avec --update pour accepter les nouvelles valeurs.");
    process.exit(1);
  }
  console.log('\nAucune régression.');
}

void main();
