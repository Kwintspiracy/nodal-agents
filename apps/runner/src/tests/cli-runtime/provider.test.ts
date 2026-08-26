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
import { resolveRuntime, isCliSetupError } from '../../cli-runtime/provider.ts';
import { ClaudeCliNotFoundError } from '../../cli-runtime/claude-turn.ts';
import {
  CodexCliNotFoundError,
  CodexRestrictionsUnsupportedError,
} from '../../cli-runtime/codex-turn.ts';

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
    expect(isCliSetupError(new ClaudeCliNotFoundError())).toBe(true);
    expect(isCliSetupError(new CodexCliNotFoundError())).toBe(true);
    expect(isCliSetupError(new Error('boom'))).toBe(false);
  });

  it('une restriction inapplicable est une erreur de CONFIGURATION, pas un plantage', () => {
    // Elle doit devenir un job échoué avec un message actionnable — sinon elle
    // remonterait en exception non rattrapée, et le tour se lirait comme une
    // panne du runner plutôt que comme un réglage impossible.
    expect(isCliSetupError(new CodexRestrictionsUnsupportedError(['Bash']))).toBe(true);
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

  it('la session est cherchée PAR FOURNISSEUR — sinon une bascule tend la session de l’autre CLI', () => {
    // Constat P2 de la revue Codex (27/08). L'index unique de `cli_sessions` ne
    // porte que (agent, conversation) : basculer un agent de Claude Code à Codex
    // sur la même conversation lui tendait l'identifiant de session de l'AUTRE
    // CLI, que sa commande de reprise refuse. Chaque tour repartait en erreur.
    //
    // Lu sur le texte : la requête vit dans une fonction qui a besoin d'une base
    // et d'un job entier ; ce qu'on veut prouver ici tient en une clause.
    for (const rel of [
      'apps/runner/src/cli-runtime/run-job.ts',
      'apps/runner/src/cli-runtime/run-chat.ts',
    ]) {
      const src = read(rel);
      const lookup =
        /select\(\{ sessionId: cliSessions.sessionId \}\)[\s\S]{0,900}?\.limit\(1\)/.exec(
          src,
        )?.[0] ?? '';
      expect(lookup, `${rel} : la lecture de session ignore le fournisseur`).toContain(
        'eq(cliSessions.provider',
      );
      // Et l'écriture repose le fournisseur, sans quoi la ligne garderait le nom
      // de l'ancien CLI tout en portant la session du nouveau.
      const upsert = /onConflictDoUpdate\(\{[\s\S]{0,700}?\}\)/.exec(src)?.[0] ?? '';
      expect(upsert, `${rel} : l'upsert laisse l'ancien fournisseur en place`).toContain(
        'provider: binding.provider',
      );
    }
  });

  it('TOUS les dossiers écrivables sont verrouillés, pas seulement le premier', () => {
    // Constat P1 de la revue Codex (27/08). Depuis que les dossiers secondaires
    // passent en `--add-dir`, deux agents aux `cwd` différents mais partageant
    // un dossier — typiquement le workspace PARTAGÉ, ajouté à tout le monde —
    // n'en verrouillaient chacun qu'un et pouvaient écrire dans le même arbre
    // en même temps. Le contrat d'un seul créneau d'écriture ne tenait plus là
    // où il compte le plus.
    const src = read('apps/runner/src/cli-runtime/run-job.ts');
    expect(src, 'le verrou ne porte que sur cwd').toContain('const writeDirs =');
    expect(src).toMatch(/for \(const dir of writeDirs\)/);
    // Ordre STABLE : deux jobs demandant les mêmes dossiers les prennent dans
    // le même ordre, donc l'un attend au lieu que les deux se bloquent.
    expect(src, 'sans tri, deux jobs peuvent se bloquer mutuellement').toMatch(
      /new Set\(args\.workspaces\.map\(\(w\) => w\.path\)\)\]\.sort\(\)/,
    );
    // Et ceux déjà pris sont rendus si l'un échoue.
    expect(src).toContain('await releaseHeld();');
  });

  it('la liste des dossiers passe au prompt — le partagé n’a pas de ligne en base', () => {
    // Constat P2 de la revue Codex (27/08). Sans elle, `buildSystemPrompt`
    // retombe sur `agent_workspaces`, où le workspace PARTAGÉ n'existe pas : il
    // est créé et injecté à l'exécution. L'agent recevait l'accès au dossier de
    // transmission sans qu'on lui dise qu'il existe.
    const src = read('apps/runner/src/cli-runtime/run-job.ts');
    const call = /buildCliRuntimeJobContext\(\{[\s\S]{0,400}?\}\)/.exec(src)?.[0] ?? '';
    expect(call, 'le prompt et les outils ne voient pas les mêmes dossiers').toContain(
      'workspaces: args.workspaces',
    );
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

  it('un harnais SANS coût rapporté ne se voit pas proposer de plafond en dollars', () => {
    // Constat P1 de la revue Codex (27/08). Le plafond quotidien se calcule en
    // sommant `cli_runs.cost_usd` ; Codex n'en écrit aucun, donc la somme reste
    // à zéro et le plafond n'est jamais atteint. Le champ était affiché quand
    // même, sous une carte affirmant que Nodal fait respecter le budget.
    const web = read('apps/web/src/lib/cli-runtimes.ts');
    const table = /CLI_RUNTIME_REPORTS_COST[\s\S]{0,200}?\};/.exec(web)?.[0] ?? '';
    expect(table, 'Codex est annoncé comme rapportant un coût').toMatch(/codex:\s*false/);
    expect(table).toMatch(/'claude-code':\s*true/);

    // Et la carte lit cette table plutôt que d'afficher le champ sans condition.
    const card = read('apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx');
    expect(card, 'le plafond en dollars est affiché sans condition').toContain('reportsCost ? (');
  });
});
