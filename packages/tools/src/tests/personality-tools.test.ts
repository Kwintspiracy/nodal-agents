// personality-tools.test.ts — issue #62 : une personnalité qui nomme un outil
// absent de la liste du job est détectée, sur des faits, sans interprétation.

import { describe, it, expect } from 'vitest';
import { toolsNamedButAbsent } from '../personality-tools';

const KNOWN = [
  'file_write',
  'file_read',
  'code_task',
  'run_command',
  'assign_dev-c',
  'save_memory',
];

describe('toolsNamedButAbsent — ce que la personnalité promet et que le job n’a pas', () => {
  it('le cas de Dev C : `code_task` nommé, non listé', () => {
    const personality =
      'Tu fais le travail de code demandé **via code_task** (provider "claude", mode "write").';
    expect(
      toolsNamedButAbsent({ personality, available: ['file_write', 'file_read'], known: KNOWN }),
    ).toEqual(['code_task']);
  });

  it('un outil nommé ET listé n’est pas un désaccord', () => {
    const personality = 'Écris avec `file_write`, relis avec file_read.';
    expect(
      toolsNamedButAbsent({ personality, available: ['file_write', 'file_read'], known: KNOWN }),
    ).toEqual([]);
  });

  it('un mot qui CONTIENT un nom d’outil ne compte pas', () => {
    // `file_write_all` n'est pas `file_write` ; « code » n'est pas `code_task`.
    const personality = 'Utilise file_write_all pour tout écrire. Tu écris du code.';
    expect(toolsNamedButAbsent({ personality, available: [], known: KNOWN })).toEqual([]);
  });

  it('un outil de délégation absent est détecté comme les autres (le paragraphe copié de Lead-Dev)', () => {
    const personality = 'Pour déléguer, appelle assign_dev-c avec le brief.';
    expect(toolsNamedButAbsent({ personality, available: ['file_write'], known: KNOWN })).toEqual([
      'assign_dev-c',
    ]);
  });

  it('trié, sans doublon, et rien pour une personnalité vide', () => {
    const personality = 'run_command puis code_task puis run_command encore.';
    expect(toolsNamedButAbsent({ personality, available: [], known: KNOWN })).toEqual([
      'code_task',
      'run_command',
    ]);
    expect(toolsNamedButAbsent({ personality: null, available: [], known: KNOWN })).toEqual([]);
    expect(toolsNamedButAbsent({ personality: '   ', available: [], known: KNOWN })).toEqual([]);
  });

  it('seuls les noms du REGISTRE sont cherchés — un mot inventé ne devient pas un outil', () => {
    const personality = 'Appelle magic_tool pour tout faire.';
    expect(toolsNamedButAbsent({ personality, available: [], known: KNOWN })).toEqual([]);
  });
});
