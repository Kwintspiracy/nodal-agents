// redact-presented.test.ts — le masquage d'une CARTE, forme par forme (#150).
//
// Ce que ce test prouve : le texte rendu est bien celui du masqueur partagé
// (pas une forme supposée), et la charge utile ressort avec la MÊME structure
// — une carte dont la forme casse ne se parse plus, et disparaît de l'écran.

import { describe, it, expect } from 'vitest';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { redactAuditRow, redactPresented } from '../redact-presented.ts';

// Jetons factices, de la forme que le masqueur reconnaît — aucun n'a jamais
// existé.
const CLE_ANTHROPIC = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // secrets:allow (fixture)
const JETON_GITHUB = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // secrets:allow (fixture)

describe('redactPresented @cap:suivre-execution/moteur', () => {
  it('masque une chaîne SECRÈTE à toute profondeur et rend la structure intacte', () => {
    const carte = {
      card: 'files',
      total: 2,
      truncated: false,
      files: [
        { path: `/srv/notes/${CLE_ANTHROPIC}.txt`, action: 'written', lines: 12 },
        { path: '/srv/notes/ordinaire.txt', action: 'listed', lines: null },
      ],
      meta: { note: `déployé avec ${JETON_GITHUB}`, essais: [1, 2, 3], vide: null },
    };

    const sortie = redactPresented(carte);

    expect(sortie).toEqual({
      card: 'files',
      total: 2,
      truncated: false,
      files: [
        { path: `/srv/notes/${REDACTED_TEXT} (sk-).txt`, action: 'written', lines: 12 },
        { path: '/srv/notes/ordinaire.txt', action: 'listed', lines: null },
      ],
      meta: {
        note: `déployé avec ${REDACTED_TEXT} (gh*_)`,
        essais: [1, 2, 3],
        vide: null,
      },
    });
    // Le secret n'est plus nulle part dans la charge.
    expect(JSON.stringify(sortie)).not.toContain(CLE_ANTHROPIC);
    expect(JSON.stringify(sortie)).not.toContain(JETON_GITHUB);
  });

  it('laisse passer ce qui n’est pas une chaîne, et une charge absente', () => {
    expect(redactPresented(null)).toBeNull();
    expect(redactPresented(undefined)).toBeUndefined();
    expect(redactPresented(42)).toBe(42);
    expect(redactPresented(true)).toBe(true);
    expect(redactPresented([])).toEqual([]);
    // Un texte sans rien de secret ressort à l'identique — la charge d'une
    // carte ordinaire n'est pas réécrite.
    const ordinaire = { card: 'text', text: 'Trois fichiers écrits dans /srv/notes.' };
    expect(redactPresented(ordinaire)).toEqual(ordinaire);
  });

  it('ne masque pas les NOMS de champs : un champ nommé comme un jeton reste lisible', () => {
    // Le nom d'un champ vient du schéma de la carte, jamais de la sortie d'un
    // outil : le réécrire casserait le parsage sans rien protéger.
    const sortie = redactPresented({ card: 'text', text: `clé: ${CLE_ANTHROPIC}` });
    expect(Object.keys(sortie as Record<string, unknown>)).toEqual(['card', 'text']);
  });
});

// Une ligne d'audit se lit à TROIS endroits — la carte, la sortie brute,
// l'entrée — et le chargeur d'un run n'en masquait qu'un (Reviewer C, passe 2
// du 18/09). La porte est commune depuis ; ce qui la franchit est masqué
// partout, pas seulement là où on regarde aujourd'hui.
describe('redactAuditRow @cap:suivre-execution/moteur', () => {
  it('masque la sortie brute, l’entrée et la carte de la même ligne', () => {
    const ligne = redactAuditRow({
      toolName: 'cli:Bash',
      toolInput: { command: `curl -H "x: ${CLE_ANTHROPIC}" https://api` },
      toolOutput: `200 OK — jeton ${JETON_GITHUB}`,
      presented: { card: 'text', text: `posé avec ${CLE_ANTHROPIC}` },
    });
    const tout = JSON.stringify(ligne);
    expect(tout).not.toContain(CLE_ANTHROPIC);
    expect(tout).not.toContain(JETON_GITHUB);
    expect(ligne.toolOutput).toContain(REDACTED_TEXT);
    expect(JSON.stringify(ligne.toolInput)).toContain(REDACTED_TEXT);
    expect(JSON.stringify(ligne.presented)).toContain(REDACTED_TEXT);
    // Le nom de l'outil et la forme de la ligne traversent intacts.
    expect(ligne.toolName).toBe('cli:Bash');
  });

  it('une ligne sans sortie garde son absence de sortie', () => {
    const ligne = redactAuditRow({
      toolName: 'file_write',
      toolInput: { path: 'a.md' },
      toolOutput: null,
      presented: null,
    });
    expect(ligne.toolOutput).toBeNull();
    expect(ligne.presented).toBeNull();
    expect(ligne.toolInput).toEqual({ path: 'a.md' });
  });
});
