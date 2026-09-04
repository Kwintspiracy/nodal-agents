import { describe, it, expect } from 'vitest';
import {
  parseVerificationSurfaces,
  surfaceForTool,
  DEFAULT_VERIFICATION_SURFACES,
  VERIFICATION_SURFACE_KEYS,
  VERIFICATION_SURFACE_TOOLS,
} from '../verification-surfaces';

const ALL_TRUE = { codeTask: true, cliRuntime: true, fileOps: true, shell: true };

describe('parseVerificationSurfaces', () => {
  it('défaut tout activé : {} (le défaut de la colonne) ⇒ les quatre à true', () => {
    expect(parseVerificationSurfaces({})).toEqual(ALL_TRUE);
    expect(DEFAULT_VERIFICATION_SURFACES).toEqual(ALL_TRUE);
  });

  it('ne lève jamais : null, chaîne, nombre, tableau ⇒ tout à true', () => {
    for (const raw of [null, undefined, 'oops', 42, [], [true]]) {
      expect(parseVerificationSurfaces(raw)).toEqual(ALL_TRUE);
    }
  });

  it('une clé décochée survit, les autres restent à true', () => {
    expect(parseVerificationSurfaces({ shell: false })).toEqual({ ...ALL_TRUE, shell: false });
    expect(parseVerificationSurfaces({ codeTask: false, fileOps: false })).toEqual({
      codeTask: false,
      cliRuntime: true,
      fileOps: false,
      shell: true,
    });
  });

  it('repli champ par champ : une valeur malformée vaut son défaut, pas tout l’objet', () => {
    expect(parseVerificationSurfaces({ shell: 'non', fileOps: false })).toEqual({
      ...ALL_TRUE,
      fileOps: false,
    });
  });

  it('un objet complet et valide passe tel quel', () => {
    const v = { codeTask: false, cliRuntime: false, fileOps: false, shell: false };
    expect(parseVerificationSurfaces(v)).toEqual(v);
  });
});

describe('VERIFICATION_SURFACE_TOOLS', () => {
  it('table exhaustive et disjointe : exactement les cinq outils mutants, aucun dans deux clés', () => {
    const all = VERIFICATION_SURFACE_KEYS.flatMap((k) => [...VERIFICATION_SURFACE_TOOLS[k]]);
    expect([...all].sort()).toEqual(
      ['code_task', 'file_edit', 'file_write', 'run_command', 'run_skill_script'].sort(),
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('surfaceForTool retrouve la clé, et null pour un outil sans surface', () => {
    expect(surfaceForTool('file_write')).toBe('fileOps');
    expect(surfaceForTool('run_skill_script')).toBe('shell');
    expect(surfaceForTool('code_task')).toBe('codeTask');
    expect(surfaceForTool('file_read')).toBeNull();
  });
});
