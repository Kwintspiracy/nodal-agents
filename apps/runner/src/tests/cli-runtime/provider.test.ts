// provider.test.ts — LE tableau des runtimes servis, et son accord avec ce que
// l'interface propose.
//
// Le 27/08, ouvrir Codex a demandé de toucher quatre endroits : la contrainte
// SQL (déjà prête), le Zod de la server action, la liste du menu, et le runner.
// Un seul oublié, et l'utilisateur obtient un agent qu'il peut choisir et qui
// échoue à chaque tour — ou l'inverse, un runtime servi que personne ne peut
// sélectionner. C'est précisément l'état dans lequel Codex a passé huit jours.
//
// Ces tests tiennent les quatre listes ensemble.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime, isCliNotFound } from '../../cli-runtime/provider.ts';
import { ClaudeCliNotFoundError } from '../../cli-runtime/claude-turn.ts';
import { CodexCliNotFoundError } from '../../cli-runtime/codex-turn.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

describe('resolveRuntime', () => {
  it('sert Claude Code ET Codex, chacun avec SON fournisseur', () => {
    // Le fournisseur n'est pas décoratif : c'est sous ce nom que `cli_runs` et
    // `cli_sessions` enregistrent le tour, et c'est la clé lue dans
    // `cli_defaults`. Le donner faux ferait tourner un agent Codex avec le
    // modèle de l'autre CLI, qui le refuserait au lancement.
    expect(resolveRuntime('claude-code')?.provider).toBe('claude');
    expect(resolveRuntime('codex')?.provider).toBe('codex');
  });

  it('chaque runtime porte SA propre étiquette dans tools_used', () => {
    // Sans ça, un tour Codex se serait rangé sous `cli:claude-code` dans
    // l'historique : le registre des actions aurait nommé le mauvais harnais.
    expect(resolveRuntime('claude-code')?.toolLabel).toBe('cli:claude-code');
    expect(resolveRuntime('codex')?.toolLabel).toBe('cli:codex');
  });

  it('« nodal » et l’inconnu ne sont PAS servis ici — l’appelant échoue fort', () => {
    expect(resolveRuntime('nodal')).toBeNull();
    expect(resolveRuntime('gemini-cli')).toBeNull();
    expect(resolveRuntime('')).toBeNull();
  });

  it('reconnaît le binaire manquant des DEUX CLI', () => {
    // Une seule des deux reconnue, et l'autre remonterait en exception non
    // rattrapée au lieu d'un job échoué avec la consigne d'installation.
    expect(isCliNotFound(new ClaudeCliNotFoundError())).toBe(true);
    expect(isCliNotFound(new CodexCliNotFoundError())).toBe(true);
    expect(isCliNotFound(new Error('boom'))).toBe(false);
  });
});

// ─── L'accord entre les quatre listes ────────────────────────────────────────
//
// Lues sur le TEXTE des fichiers : ce ne sont pas des modules importables
// depuis le runner (l'un est du SQL, l'autre du JSX côté web), et les importer
// créerait une dépendance que dependency-cruiser refuse à juste titre.

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8');
}

describe('les quatre listes de runtimes disent la même chose', () => {
  const RUNTIMES = ['claude-code', 'codex'] as const;

  it('la contrainte SQL accepte tout ce que le runner sert', () => {
    const schema = read('packages/db/src/schema/agents.ts');
    const check = /agents_runtime_check[\s\S]{0,240}/.exec(schema)?.[0] ?? '';
    for (const r of RUNTIMES) {
      expect(check, `la base refuserait un agent en runtime "${r}"`).toContain(`'${r}'`);
      expect(resolveRuntime(r)).not.toBeNull();
    }
  });

  it('la server action accepte tout ce que le runner sert', () => {
    // L'inverse était vrai jusqu'au 27/08 : la base acceptait `codex`, le Zod
    // le refusait. Le siège était réservé, personne ne pouvait s'asseoir.
    const actions = read('apps/web/src/lib/actions.ts');
    const zod = /SetAgentRuntimeSchema[\s\S]{0,200}/.exec(actions)?.[0] ?? '';
    for (const r of RUNTIMES) {
      expect(zod, `l'action refuserait de sauver le runtime "${r}"`).toContain(`'${r}'`);
    }
  });

  it('le menu de l’interface propose tout ce que le runner sert, et rien de plus', () => {
    const web = read('apps/web/src/lib/cli-runtimes.ts');
    const list = /CLI_RUNTIMES = \[[^\]]*\]/.exec(web)?.[0] ?? '';
    for (const r of RUNTIMES) {
      expect(list, `l'interface ne proposerait pas "${r}"`).toContain(`'${r}'`);
    }
    // Et rien que le runner ne sache servir : une option en trop donne un agent
    // qui plante à chaque tour, ce qui est pire que pas d'option du tout.
    for (const quoted of list.match(/'[^']+'/g) ?? []) {
      const value = quoted.slice(1, -1);
      expect(
        resolveRuntime(value),
        `l'interface propose "${value}", que le runner ne sert pas`,
      ).not.toBeNull();
    }
  });
});
