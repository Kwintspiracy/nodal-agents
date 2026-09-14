// hygiene-file-scope.test.mjs — l'exemption de taille du portail n'emporte pas
// les contrôles de contenu avec elle.
//
// Le commentaire de la PR #77 affirmait : exemptés de la règle de taille « et
// d'elle seule : NUL et UTF-16 restent contrôlés ». C'était faux pour
// `apps/qa/data/tests.ndjson`, le fichier qui a motivé l'exemption :
// `.ndjson` n'était pas une extension texte, donc la boucle sortait avant les
// contrôles de contenu. Ces cas fixent la phrase dans du code.
//
// Depuis la racine : npx vitest run scripts/tests/hygiene-file-scope.test.mjs

import { describe, it, expect } from 'vitest';
import { fileScope } from '../lib/hygiene-file-scope.mjs';

describe('fileScope — la mémoire du portail', () => {
  it('tests.ndjson échappe à la TAILLE, et à elle seule', () => {
    expect(fileScope('apps/qa/data/tests.ndjson')).toEqual({
      binary: false,
      sizeChecked: false,
      contentChecked: true,
    });
  });

  it('les autres données du portail suivent la même règle', () => {
    expect(fileScope('apps/qa/data/runs.json').sizeChecked).toBe(false);
    expect(fileScope('apps/qa/data/runs.json').contentChecked).toBe(true);
  });
});

describe('fileScope — l’exemption ne déborde pas', () => {
  it('un .ndjson AILLEURS reste soumis à la taille', () => {
    expect(fileScope('packages/db/data/dump.ndjson')).toEqual({
      binary: false,
      sizeChecked: true,
      contentChecked: true,
    });
  });

  it('un .json ailleurs aussi', () => {
    expect(fileScope('package.json').sizeChecked).toBe(true);
  });

  it('un binaire n’est ni pesé comme source ni lu comme texte', () => {
    expect(fileScope('apps/web/public/logo.png')).toEqual({
      binary: true,
      sizeChecked: false,
      contentChecked: false,
    });
  });

  it('une extension inconnue n’est pas inspectée pour son contenu', () => {
    expect(fileScope('docs/schema.graphql').contentChecked).toBe(false);
  });
});
