// audit.test.ts — ce qu'une session CLI écrit dans `tool_calls`.
//
// Constat P1 de la revue Codex (27/08) : les deux chemins runtime (job et chat)
// enregistraient la sortie de l'outil EN CLAIR. Ces lignes portent la sortie de
// CHAQUE commande interne de la CLI — donc le contenu de chaque fichier lu,
// jeton compris. Le chemin `code_task` masquait depuis toujours ; le runtime,
// jamais, pour Claude comme pour Codex.
//
// La construction a été sortie en fonction pure exprès : le masquage se prouve
// ici au lieu de se relire dans deux copies.

import { describe, it, expect } from 'vitest';
import { buildCliAuditRow, MAX_AUDIT_OUTPUT_CHARS } from '../../cli-runtime/audit.ts';

const BASE = {
  toolName: 'Read',
  toolInput: { file_path: '/srv/app/.env' },
  toolOutput: 'ok',
  toolCallId: 'item_0',
  startedAt: 1_000,
  now: 1_250,
};

describe('buildCliAuditRow', () => {
  it('masque un secret présent dans la SORTIE de l’outil', () => {
    // Le cas exact du constat : la CLI lit un fichier de configuration, et sa
    // sortie atterrit telle quelle dans l'audit. Le masquage par nom de champ
    // ne voit rien ici — c'est du texte libre.
    // Le faux jeton est assemblé plutôt qu'écrit d'un bloc : le garde-fou de
    // commit refuse la forme littérale, et il a raison de la refuser.
    const faux = `sk-ant-api03-${'A'.repeat(32)}`;
    const row = buildCliAuditRow({ ...BASE, toolOutput: `ANTHROPIC_API_KEY=${faux}` });
    expect(row.toolOutput, 'la clé part en clair dans tool_calls').not.toContain(faux);
  });

  it('un texte sans secret traverse INCHANGÉ', () => {
    // Un masquage trop zélé abîmerait l'audit qu'il protège : la sortie doit
    // rester lisible pour dire ce qui s'est passé.
    const row = buildCliAuditRow({ ...BASE, toolOutput: 'la reponse est 42' });
    expect(row.toolOutput).toBe('la reponse est 42');
  });

  it('masque aussi l’ENTRÉE, par nom de champ', () => {
    const row = buildCliAuditRow({
      ...BASE,
      toolInput: { command: 'deploy', api_key: `sk-live-${'1234567890'}` },
    });
    expect(JSON.stringify(row.toolInput)).not.toContain('sk-live-1234567890');
  });

  it('borne la sortie — l’audit dit ce qui s’est passé, il n’archive pas le dépôt', () => {
    const row = buildCliAuditRow({ ...BASE, toolOutput: 'x'.repeat(MAX_AUDIT_OUTPUT_CHARS * 3) });
    expect(row.toolOutput.length).toBeLessThanOrEqual(MAX_AUDIT_OUTPUT_CHARS);
  });

  it('préfixe le nom pour qu’un Read interne ne passe pas pour un builtin Nodal', () => {
    expect(buildCliAuditRow(BASE).toolName).toBe('cli:Read');
  });

  it('une sortie absente devient une chaîne vide, jamais « undefined »', () => {
    const row = buildCliAuditRow({ ...BASE, toolOutput: undefined });
    expect(row.toolOutput).toBe('');
  });

  it('la durée se mesure entre le début et la fin', () => {
    expect(buildCliAuditRow(BASE).durationMs).toBe(250);
  });
});
