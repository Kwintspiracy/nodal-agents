import { describe, it, expect } from 'vitest';
import {
  parseVerificationSurfaces,
  surfaceForTool,
  DEFAULT_VERIFICATION_SURFACES,
  VERIFICATION_SURFACE_KEYS,
  VERIFICATION_SURFACE_TOOLS,
  PROOF_REPAIR_ATTEMPTS_CHOICES,
  PROOF_REPAIR_ATTEMPTS_DEFAULT,
  PROOF_REPAIR_ATTEMPTS_MAX,
  readProofRepairAttempts,
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
  it('table exhaustive et disjointe : les cinq outils mutants d’origine + les vingt outils Office écrivains + generate_speech, aucun dans deux clés', () => {
    const all = VERIFICATION_SURFACE_KEYS.flatMap((k) => [...VERIFICATION_SURFACE_TOOLS[k]]);
    const office = [
      'docx_create',
      'docx_append_paragraphs',
      'docx_replace_text',
      'pptx_create',
      'pptx_append_slides',
      'pptx_replace_text',
      'xlsx_set_cell',
      'xlsx_set_range',
      'xlsx_append_rows',
      'xlsx_add_sheet',
      'xlsx_create',
      'xlsx_delete_rows',
      'xlsx_format_range',
      'xlsx_insert_rows',
      'xlsx_insert_columns',
      'xlsx_delete_columns',
      'xlsx_merge_cells',
      'xlsx_unmerge_cells',
      'xlsx_set_column_widths',
      'xlsx_freeze_panes',
    ];
    expect([...all].sort()).toEqual(
      [
        'code_task',
        'file_edit',
        'file_write',
        'generate_speech',
        'run_command',
        'run_skill_script',
        ...office,
      ].sort(),
    );
    expect(new Set(all).size).toBe(all.length);
    // Les lecteurs Office ne mutent rien : jamais sur une surface (revue PR #46).
    for (const reader of ['docx_read', 'pptx_read', 'xlsx_read', 'xlsx_find_cells']) {
      expect(surfaceForTool(reader)).toBeNull();
    }
  });

  it('surfaceForTool retrouve la clé, et null pour un outil sans surface', () => {
    expect(surfaceForTool('file_write')).toBe('fileOps');
    expect(surfaceForTool('run_skill_script')).toBe('shell');
    expect(surfaceForTool('code_task')).toBe('codeTask');
    expect(surfaceForTool('file_read')).toBeNull();
  });
});

// ─── Les tours de réparation (#377) ─────────────────────────────────────────
//
// La borne vit en base, gardée par un CHECK. Cette fonction est la CEINTURE :
// elle ramène dans les bornes ce qu'une ligne pourrait porter si la contrainte
// tombait (restauration d'une sauvegarde plus ancienne). Elle ne décide de
// rien toute seule — `finalize` journalise un code quand elle a dû rabattre
// (Reviewer C, PR #392), plutôt que de tourner en silence sur un nombre que
// personne n'a choisi.

describe('readProofRepairAttempts @cap:verifier-un-livrable/moteur', () => {
  it('laisse passer les quatre valeurs offertes, telles quelles', () => {
    for (const n of PROOF_REPAIR_ATTEMPTS_CHOICES) {
      expect(readProofRepairAttempts(n)).toBe(n);
    }
  });

  it('rabat sur la borne la PLUS PROCHE, jamais sur le défaut', () => {
    // Un espace qui avait demandé beaucoup en obtient le maximum, pas un.
    expect(readProofRepairAttempts(9)).toBe(PROOF_REPAIR_ATTEMPTS_MAX);
    expect(readProofRepairAttempts(-4)).toBe(0);
  });

  it('ce qui n’est pas un entier vaut le défaut — une ligne d’avant la colonne', () => {
    expect(readProofRepairAttempts(null)).toBe(PROOF_REPAIR_ATTEMPTS_DEFAULT);
    expect(readProofRepairAttempts(undefined)).toBe(PROOF_REPAIR_ATTEMPTS_DEFAULT);
    expect(readProofRepairAttempts('2')).toBe(PROOF_REPAIR_ATTEMPTS_DEFAULT);
    expect(readProofRepairAttempts(1.5)).toBe(PROOF_REPAIR_ATTEMPTS_DEFAULT);
  });
});
