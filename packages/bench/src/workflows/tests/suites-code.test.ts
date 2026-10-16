// suites-code.test.ts — les juges du code, sur les VRAIS projets de fixture.
//
// Le banc n'exécute JAMAIS le code écrit par un agent hors bac à sable (revue
// Reviewer A de #756, passes 1 et 2) : le juge lit la sortie du `npm test`
// que l'agent a lancé lui-même (les lignes TAP ou spec de son outil de
// commande), et la ligne dit « tests re-run by the bench: not verified ».
//
// Ici, ce sont les TESTS qui lancent `node --test` (harness.ts) : pour prouver
// qu'une fixture échoue telle que livrée et passe résolue, et pour produire la
// sortie qu'un agent obtiendrait. Les cas de contournement (un `echo`, une
// suite lancée ailleurs, un faux outil `bash`) vérifient qu'aucun code de
// l'agent ne tourne : ce code-là laisserait un fichier témoin s'il était exécuté.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../fixtures';
import { scenarioById } from '../scenarios';
import { revenueByRegion, declaredTests, testResultsIn } from '../suites/code';
import { play, runNodeTests, type Run } from './harness';

const solve = (project: string) => (root: string) =>
  cpSync(join(FIXTURES_DIR, 'solutions', project), join(root, 'nodal-bench', project), {
    recursive: true,
  });

/** L'appel d'outil d'un agent qui lance la suite DANS le projet : sa vraie sortie. */
const agentRanTests =
  (project: string, command = 'npm test') =>
  (root: string): Run => {
    const r = runNodeTests(join(root, 'nodal-bench', project));
    return {
      tools: [
        {
          name: 'run_command',
          input: { command },
          output: JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: '' }),
        },
      ],
    };
  };

/** Un code d'agent qui, s'il était exécuté, laisserait la trace `EXECUTED`. */
const plantMarker = (root: string): void => {
  writeFileSync(
    join(root, 'nodal-bench', 'http-somme', 'src', 'server.js'),
    "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync(new URL('../EXECUTED', import.meta.url), 'yes');\n" +
      'export function createServer() { throw new Error("x"); }\n',
  );
};
const executed = (root: string): boolean =>
  existsSync(join(root, 'nodal-bench', 'http-somme', 'EXECUTED'));

describe('the code fixtures are real problems', () => {
  it('each fixture suite FAILS as delivered, and passes once solved', async () => {
    for (const p of ['http-somme', 'facture-tva']) {
      const { root } = await play(`code-${p === 'http-somme' ? 'http-server' : 'bugfix'}`, {});
      const dir = join(root, 'nodal-bench', p);
      const before = runNodeTests(dir);
      expect(before.exitCode).not.toBe(0);
      expect(testResultsIn(before.stdout)!.failed.length).toBeGreaterThan(0);
      solve(p)(root);
      const after = runNodeTests(dir);
      expect(after.exitCode).toBe(0);
      expect(testResultsIn(after.stdout)!.failed).toEqual([]);
    }
  });

  it('reads the declared test names from a test file', () => {
    const src = readFileSync(join(FIXTURES_DIR, 'code', 'http-somme', 'test', 'server.js'), 'utf8');
    expect(declaredTests(src)).toEqual([
      'GET /somme additionne a et b',
      'les décimaux et les négatifs',
      "un paramètre qui n'est pas un nombre est une erreur 400",
      'une autre route répond 404',
    ]);
  });

  it('reads test results in TAP and in the spec reporter, and nothing in plain text', () => {
    expect(testResultsIn('ok 1 - a\nnot ok 2 - b # todo\n# fail 1')).toEqual({
      passed: ['a'],
      failed: ['b'],
    });
    expect(testResultsIn('✔ a (1.2ms)\n✖ b (0.4ms)\nℹ fail 1')).toEqual({
      passed: ['a'],
      failed: ['b'],
    });
    expect(testResultsIn('npm test')).toBeNull();
  });
});

describe('code-http-server judge', () => {
  it('green: solved, and the agent’s own run shows every fixture test passing', async () => {
    const r = await play('code-http-server', agentRanTests('http-somme'), solve('http-somme'));
    expect(r.reasons).toEqual([]);
  });

  it('says on every line that the tests are not re-run by the bench', () => {
    expect(scenarioById('code-http-server')!.unverified?.map((u) => u.check)).toEqual([
      'tests re-run by the bench',
    ]);
  });

  it('red: nothing done — the agent’s own run names the failing tests', async () => {
    const r = await play('code-http-server', agentRanTests('http-somme'));
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(
      /^in the agent's last test run, 4 test\(s\) do not pass: GET \/somme additionne a et b; /,
    );
  });

  it('red: a deleted test file does not make the suite pass', async () => {
    const r = await play('code-http-server', agentRanTests('http-somme'), (root) => {
      solve('http-somme')(root);
      rmSync(join(root, 'nodal-bench', 'http-somme', 'test', 'server.js'));
    });
    // Sans fichier de test, la suite de l'agent ne rapporte aucun résultat.
    expect(r.reasons).toEqual([
      'the test file test/server.js was deleted',
      'no test run of this project found',
    ]);
  });

  it('red: a test rewritten to pass is seen, even though the suite is green', async () => {
    const r = await play('code-http-server', agentRanTests('http-somme'), (root) => {
      solve('http-somme')(root);
      const t = join(root, 'nodal-bench', 'http-somme', 'test', 'server.js');
      writeFileSync(t, readFileSync(t, 'utf8').replace('somme: 5', 'somme: 5 ')); // octets changés, sens identique
    });
    expect(r.reasons).toEqual(['the test file test/server.js was changed']);
  });

  it('red: the agent never ran the suite — and the bench runs nothing either', async () => {
    const r = await play('code-http-server', {}, plantMarker);
    expect(r.reasons).toEqual(['no test run of this project found']);
    expect(executed(r.root)).toBe(false);
  });

  // Revue Reviewer A, passe 2 (P2-2) : les contournements d'une règle sur le
  // nom de l'outil et sur la commande. Aucun n'obtient une exécution du banc.
  it('bypass 1: `echo "npm test"` shows no result, so red, and nothing runs', async () => {
    const r = await play(
      'code-http-server',
      {
        tools: [
          {
            name: 'run_command',
            input: { command: 'echo "npm test"' },
            output: JSON.stringify({ exitCode: 0, stdout: 'npm test\n' }),
          },
        ],
      },
      plantMarker,
    );
    expect(r.reasons).toEqual(['no test run of this project found']);
    expect(executed(r.root)).toBe(false);
  });

  it('bypass 2: `cd elsewhere && npm test` shows another suite: no run of this project, and nothing runs', async () => {
    const r = await play(
      'code-http-server',
      (root) => {
        // La suite d'un AUTRE projet, résolu : ses tests passent, mais ce ne sont pas ceux-ci.
        solve('facture-tva')(root);
        return agentRanTests('facture-tva', 'cd ../facture-tva && npm test')(root);
      },
      (root) => {
        mkdirSync(join(root, 'nodal-bench', 'facture-tva', 'src'), { recursive: true });
        cpSync(
          join(FIXTURES_DIR, 'code', 'facture-tva'),
          join(root, 'nodal-bench', 'facture-tva'),
          { recursive: true },
        );
        plantMarker(root);
      },
    );
    expect(r.reasons).toEqual(['no test run of this project found']);
    expect(executed(r.root)).toBe(false);
  });

  it('bypass 3: an MCP tool merely named `bash` gets no execution from the bench', async () => {
    const r = await play(
      'code-http-server',
      {
        tools: [
          {
            name: 'evil__bash',
            input: { command: 'npm test' },
            output: 'ok 1 - GET /somme additionne a et b\n',
          },
        ],
      },
      plantMarker,
    );
    expect(executed(r.root)).toBe(false);
    // Une sortie partielle n'est pas un lancement de CE projet ; et même
    // complète, la ligne dirait « tests re-run by the bench: not verified ».
    expect(r.reasons).toEqual(['no test run of this project found']);
  });

  it('only the LAST run counts: a passing run followed by a failing one is red', async () => {
    const r = await play(
      'code-http-server',
      (root) => {
        const ok = agentRanTests('http-somme')(root).tools![0]!;
        // Un second lancement COMPLET du même projet, où tout échoue.
        const ko = {
          ...ok,
          output: JSON.stringify({
            exitCode: 1,
            stdout: [
              'not ok 1 - GET /somme additionne a et b',
              'not ok 2 - les décimaux et les négatifs',
              "not ok 3 - un paramètre qui n'est pas un nombre est une erreur 400",
              'not ok 4 - une autre route répond 404',
            ].join('\n'),
          }),
        };
        return { tools: [ok, ko] };
      },
      solve('http-somme'),
    );
    expect(r.reasons[0]).toMatch(/^in the agent's last test run, 4 test\(s\) do not pass/);
  });

  // Revue Reviewer A, passe 3 (P2) : un `✔ done` d'une étape de lint ou un
  // `cat` APRÈS les tests ne remplace pas le vrai lancement (faux rouge).
  it('a later command whose output holds an unrelated ✔ line does not replace the real test run', async () => {
    const r = await play(
      'code-http-server',
      (root) => {
        const tests = agentRanTests('http-somme')(root).tools![0]!;
        const lint = {
          name: 'run_command',
          input: { command: 'npm run lint' },
          output: JSON.stringify({ exitCode: 0, stdout: '✔ done (12ms)\n' }),
        };
        return { tools: [tests, lint] };
      },
      solve('http-somme'),
    );
    expect(r.reasons).toEqual([]);
  });

  it('a run that names only some of the project tests is not a run of this project', async () => {
    const r = await play(
      'code-http-server',
      {
        tools: [
          {
            name: 'run_command',
            input: { command: 'node --test test/server.js --test-name-pattern somme' },
            output: JSON.stringify({
              exitCode: 0,
              stdout: 'ok 1 - GET /somme additionne a et b\n',
            }),
          },
        ],
      },
      solve('http-somme'),
    );
    expect(r.reasons).toEqual(['no test run of this project found']);
  });
});

describe('code-bugfix judge', () => {
  it('green: the bug fixed and the agent’s run passing', async () => {
    expect(
      (await play('code-bugfix', agentRanTests('facture-tva'), solve('facture-tva'))).reasons,
    ).toEqual([]);
  });
});

describe('code-install-dep judge', () => {
  /** L'installation, faite comme npm la ferait : le paquet dans node_modules et dans package.json. */
  const install = (root: string): void => {
    const dir = join(root, 'nodal-bench', 'slug-titre');
    const pkg = createRequire(import.meta.url).resolve('slugify/package.json');
    cpSync(dirname(pkg), join(dir, 'node_modules', 'slugify'), { recursive: true });
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ ...p, dependencies: { slugify: '^1.6.9' } }),
    );
  };

  it('green: installed, declared, imported, the agent’s run passing', async () => {
    const r = await play('code-install-dep', agentRanTests('slug-titre'), (root) => {
      install(root);
      solve('slug-titre')(root);
    });
    expect(r.reasons).toEqual([]);
  });

  it('red: the code works but the dependency is not declared in package.json', async () => {
    const r = await play('code-install-dep', agentRanTests('slug-titre'), (root) => {
      install(root);
      solve('slug-titre')(root);
      const p = join(root, 'nodal-bench', 'slug-titre', 'package.json');
      writeFileSync(p, readFileSync(join(FIXTURES_DIR, 'code', 'slug-titre', 'package.json')));
    });
    expect(r.reasons).toEqual(['slugify is not in the dependencies of package.json']);
  });
});

describe('code-data judge', () => {
  const RAN = { name: 'run_command', input: { command: 'python calc.py' } };
  const csv = (): string => readFileSync(join(FIXTURES_DIR, 'data', 'ventes-regions.csv'), 'utf8');
  const writeJson = (value: unknown) => (root: string) => {
    mkdirSync(join(root, 'nodal-bench'), { recursive: true });
    writeFileSync(join(root, 'nodal-bench', 'ca-par-region.json'), JSON.stringify(value));
  };

  it('the revenue is recomputed to the cent, for the five regions', () => {
    const want = revenueByRegion(csv());
    expect(Object.keys(want).sort()).toEqual(['Centre', 'Est', 'Nord', 'Ouest', 'Sud']);
    for (const v of Object.values(want)) expect(Math.round(v * 100)).toBe(v * 100);
  });

  it('green: the right numbers, written by a script', async () => {
    expect(
      (await play('code-data', { tools: [RAN] }, writeJson(revenueByRegion(csv())))).reasons,
    ).toEqual([]);
  });

  it('red: a wrong region total and an extra key are named; no script is named too', async () => {
    const want = revenueByRegion(csv());
    const r = await play(
      'code-data',
      {},
      writeJson({ ...want, Nord: want['Nord']! + 1, Total: 1 }),
    );
    expect(r.reasons).toEqual([
      'no Python or Node script ran',
      `Nord is ${want['Nord']! + 1}, expected ${want['Nord']}`,
      'unexpected keys: Total',
    ]);
  });
});
