// job-status-sql-literals.test.ts — les statuts écrits EN DUR dans le SQL du
// déclencheur de fin de job (#531, migration 0141) sont ceux de l'énumération
// (revue de #642, passe 3).
//
// `liveJob()` / `LIVE_JOB_STATUSES` est LA définition de « vivant », et
// `TERMINAL_STATUSES` celle de « fini ». Une fonction plpgsql ne peut pas les
// importer : elle en porte une copie. Ce test lit la copie — dans le fichier
// de migration, et dans le SQL inline de la base de test (helpers.ts) — et la
// compare aux listes du code. Un statut ajouté à l'énumération, ou retiré d'une
// liste SQL, fait rougir ce test au lieu de dériver en silence.
//
// Chaque liste `status IN (…)` / `status NOT IN (…)` du déclencheur est l'une
// des deux : celle qui contient `pending` est la liste des vivants, les autres
// celle des terminaux. Il y en a exactement 5 par copie : la zéro-liste d'un
// déclencheur réécrit sans elles serait un autre test à écrire, pas un vert.
//
// Mutation vérifiée : `'cancelled'` retiré de la liste de la clause WHEN dans
// la migration → « the migration » rougit (la liste diffère des terminaux).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_JOB_STATUSES, TERMINAL_STATUSES } from '@nodal-agents/shared';

const DB = join(import.meta.dirname, '..', '..');

/** Les listes de statuts du déclencheur `agent_jobs_inbox_relaunch` dans `sql`. */
function statusLists(sql: string): string[][] {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION agent_jobs_inbox_relaunch()');
  const end = sql.indexOf('EXECUTE FUNCTION agent_jobs_inbox_relaunch()');
  expect(start, 'trigger function not found').toBeGreaterThanOrEqual(0);
  expect(end, 'trigger not found').toBeGreaterThan(start);
  const body = sql.slice(start, end);
  return [...body.matchAll(/status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/g)].map((m) =>
    [...m[1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]!).sort(),
  );
}

function expectListsMatchTheEnumeration(lists: string[][]): void {
  expect(lists).toHaveLength(5);
  const live = [...LIVE_JOB_STATUSES].sort();
  const terminal = [...TERMINAL_STATUSES].sort();
  for (const list of lists) {
    expect(list).toEqual(list.includes('pending') ? live : terminal);
  }
  // Les deux sortes y sont : un ancêtre vivant, et les fins.
  expect(lists.filter((l) => l.includes('pending'))).toHaveLength(1);
}

describe('the job statuses written in the SQL of the end-of-job trigger are the enumeration’s @cap:parler-par-canal-externe/moteur', () => {
  it('the migration (0141_job_inbox.sql)', () => {
    const sql = readFileSync(join(DB, 'migrations', '0141_job_inbox.sql'), 'utf8');
    expectListsMatchTheEnumeration(statusLists(sql));
  });

  it('the inline SQL of the test database (helpers.ts), which mirrors it', () => {
    const sql = readFileSync(join(DB, 'src', 'tests', 'helpers.ts'), 'utf8');
    expectListsMatchTheEnumeration(statusLists(sql));
  });
});
