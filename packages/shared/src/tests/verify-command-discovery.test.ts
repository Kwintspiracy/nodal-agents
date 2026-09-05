// verify-command-discovery.test.ts — ce qu'un projet propose de lui-même.
//
// Le défaut d'origine : l'écran affichait « Add a command » devant un champ
// vide, et le premier utilisateur à l'essayer n'a pas su quoi taper. Ces tests
// portent donc sur du CONTENU DE MANIFESTE RÉEL, pas sur des formes inventées :
// un `package.json` de ce dépôt, un `Cargo.toml`, un `deno.jsonc` avec ses
// commentaires.

import { describe, it, expect } from 'vitest';
import { discoverVerifyCommands, VERIFY_COMMANDS_MAX } from '../index';

const pkg = (o: unknown): string => JSON.stringify(o);

describe('discoverVerifyCommands — ce que le projet dit de lui-même', () => {
  it('les scripts npm reconnus, du MOINS CHER au plus cher', () => {
    // La séquence s'arrête au premier rouge : une erreur de typage doit tomber
    // en secondes, pas après huit minutes de tests.
    const out = discoverVerifyCommands({
      packageJson: pkg({
        scripts: { build: 'tsc -b', test: 'vitest', typecheck: 'tsc --noEmit', lint: 'eslint .' },
      }),
      lockfiles: ['pnpm-lock.yaml'],
    });
    expect(out.map((c) => c.command)).toEqual([
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run test',
      'pnpm run build',
    ]);
    expect(out.map((c) => c.rank)).toEqual([0, 1, 2, 3]);
  });

  it('le gestionnaire vient du VERROU, pas d’un défaut', () => {
    const scripts = { scripts: { test: 'vitest' } };
    const pm = (lock: string) =>
      discoverVerifyCommands({ packageJson: pkg(scripts), lockfiles: [lock] })[0]?.command;
    expect(pm('pnpm-lock.yaml')).toBe('pnpm run test');
    expect(pm('yarn.lock')).toBe('yarn run test');
    expect(pm('bun.lockb')).toBe('bun run test');
    expect(pm('package-lock.json')).toBe('npm run test');
    // Aucun verrou : `npm` en dernier ressort, la seule commande présente partout.
    expect(discoverVerifyCommands({ packageJson: pkg(scripts) })[0]?.command).toBe('npm run test');
  });

  it('`packageManager` de corepack l’emporte sur le verrou', () => {
    // Un verrou peut traîner d'un ancien gestionnaire ; le champ, lui, est une
    // déclaration explicite du projet.
    const out = discoverVerifyCommands({
      packageJson: pkg({ packageManager: 'pnpm@9.1.0', scripts: { test: 'vitest' } }),
      lockfiles: ['package-lock.json'],
    });
    expect(out[0]?.command).toBe('pnpm run test');
  });

  it('un script au nom PROCHE n’est pas pris pour un autre', () => {
    // `test:e2e` démarre un navigateur, `build:docs` publie un site : ni l'un
    // ni l'autre n'est une preuve. Le nom doit être EXACT.
    const out = discoverVerifyCommands({
      packageJson: pkg({
        scripts: { 'test:e2e': 'playwright test', 'build:docs': 'docusaurus', dev: 'next dev' },
      }),
    });
    expect(out).toEqual([]);
  });

  it('un script déclaré NON-texte est ignoré', () => {
    const out = discoverVerifyCommands({ packageJson: pkg({ scripts: { test: 42, lint: null } }) });
    expect(out).toEqual([]);
  });

  it('Rust et Go proposent leur outil, contrôle statique en premier', () => {
    expect(
      discoverVerifyCommands({ cargoToml: '[package]\nname = "x"\n' }).map((c) => c.command),
    ).toEqual(['cargo check', 'cargo test']);
    expect(discoverVerifyCommands({ hasGoMod: true }).map((c) => c.command)).toEqual([
      'go vet ./...',
      'go test ./...',
    ]);
  });

  it('Python ne propose `pytest` que si le projet le NOMME', () => {
    // Sinon la commande échouerait « command not found », et ce rouge
    // d'outillage se lirait comme un rouge de code.
    expect(discoverVerifyCommands({ pyprojectToml: '[project]\nname = "x"\n' })).toEqual([]);
    expect(
      discoverVerifyCommands({
        pyprojectToml: '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      }).map((c) => c.command),
    ).toEqual(['pytest']);
  });

  it('un `deno.jsonc` COMMENTÉ est lu quand même', () => {
    const out = discoverVerifyCommands({
      denoJson: `{
  // les tâches du projet
  "tasks": { "test": "deno test -A" } /* et rien d'autre */
}`,
    });
    expect(out.map((c) => c.command)).toEqual(['deno check .', 'deno task test']);
  });

  it('une accolade dans une CHAÎNE ne casse pas le retrait des commentaires', () => {
    const out = discoverVerifyCommands({
      denoJson: '{"tasks": {"test": "echo \\"// pas un commentaire\\""}}',
    });
    expect(out.map((c) => c.command)).toEqual(['deno check .', 'deno task test']);
  });

  it('un manifeste ILLISIBLE ne prive pas des autres', () => {
    // Un `package.json` à moitié écrit par un agent est un cas courant :
    // refuser toute la liste pour ça serait une panne déguisée.
    const out = discoverVerifyCommands({
      packageJson: '{ "scripts": { "test"',
      cargoToml: '[package]\n',
    });
    expect(out.map((c) => c.command)).toEqual(['cargo check', 'cargo test']);
  });

  it('aucun manifeste reconnu ⇒ liste VIDE, jamais une commande inventée', () => {
    expect(discoverVerifyCommands({})).toEqual([]);
    expect(discoverVerifyCommands({ lockfiles: ['pnpm-lock.yaml'] })).toEqual([]);
  });

  it('la liste est plafonnée au même maximum que la liste approuvable', () => {
    const out = discoverVerifyCommands({
      packageJson: pkg({
        scripts: {
          typecheck: 'x',
          'type-check': 'x',
          tsc: 'x',
          'check-types': 'x',
          lint: 'x',
          test: 'x',
          build: 'x',
        },
      }),
      cargoToml: '[package]\n',
      hasGoMod: true,
    });
    expect(out).toHaveLength(VERIFY_COMMANDS_MAX);
    // Ce qui survit au plafond est ce qui coûte le moins cher.
    expect(out.every((c) => c.rank === 0)).toBe(true);
  });

  it('le timeout proposé suit le coût', () => {
    const out = discoverVerifyCommands({
      packageJson: pkg({ scripts: { typecheck: 'x', test: 'x', build: 'x' } }),
      lockfiles: ['pnpm-lock.yaml'],
    });
    expect(out.map((c) => c.timeoutSeconds)).toEqual([180, 600, 900]);
  });

  it('chaque proposition porte un CODE de provenance, jamais une phrase', () => {
    const out = discoverVerifyCommands({
      packageJson: pkg({ scripts: { test: 'x' } }),
      cargoToml: '[package]\n',
      hasGoMod: true,
    });
    expect([...new Set(out.map((c) => c.source))].sort()).toEqual([
      'cargo',
      'go',
      'package_json_script',
    ]);
  });
});
