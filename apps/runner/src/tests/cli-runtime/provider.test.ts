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
    // Le chemin job a été corrigé d'abord, et le chemin CHAT est resté en
    // arrière une revue de plus : deux copies, un seul correctif appliqué. La
    // prise de verrous vit donc dans son propre module, et les DEUX chemins
    // l'appellent — c'est ce que ce test vérifie.
    // Le COMPORTEMENT du module — ordre stable, déduplication par identité,
    // rien laissé derrière en cas de refus — est prouvé sur une vraie base dans
    // `workspace-locks.test.ts`. Ici on vérifie seulement ce qu'un test de
    // comportement ne peut pas voir : que les DEUX points d'entrée l'appellent
    // avec la liste complète de leurs dossiers.
    for (const rel of [
      'apps/runner/src/cli-runtime/run-job.ts',
      'apps/runner/src/cli-runtime/run-chat.ts',
    ]) {
      const src = read(rel);
      // L'ARGUMENT compte, pas la présence de l'appel : passer `[cwd]` à la
      // fonction partagée rendrait le correctif décoratif — le chemin chat a
      // vécu une revue entière dans cet état.
      // Jusqu'au `);` FINAL : un `)` intermédiaire ferme `(w)`, pas l'appel.
      const call = /acquireWorkspaceLocks\([\s\S]{0,240}?\n\s*\);/.exec(src)?.[0] ?? '';
      expect(call, `${rel} : les verrous ne sont pas pris`).not.toBe('');
      expect(call, `${rel} : le verrou ne porte que sur le premier dossier`).toMatch(
        /\.map\(\(w\) => w\.path\)/,
      );
      expect(call).not.toMatch(/\[\s*cwd\s*\]/);
    }
  });

  it('une panne pendant l’assemblage du prompt REND les verrous', () => {
    // Constat P1 de la revue Codex (27/08). La sonde git et `buildSystemPrompt`
    // touchent le disque et la base ; elles vivaient APRÈS la prise des verrous
    // et AVANT le `try`. Une panne passagère y laissait tous les dossiers —
    // le PARTAGÉ compris, donc ceux de tout le monde — bloqués une demi-heure,
    // jusqu'à la reprise du verrou périmé.
    for (const rel of [
      'apps/runner/src/cli-runtime/run-job.ts',
      'apps/runner/src/cli-runtime/run-chat.ts',
    ]) {
      const src = read(rel);
      // L'assemblage est DANS un try dont le catch rend les verrous.
      //
      // La borne de DISTANCE (2000) n'est pas la règle — la règle est « dans un
      // try qui relâche ». Elle a été portée de 900 à 2000 le 06/09 : le bloc
      // s'est allongé de deux gestes qui vivent légitimement là (le registre des
      // projets en P5, le chargement de la conversation en P6), et à 900 le
      // motif ne trouvait plus RIEN — le test passait donc sur la garde
      // `not.toBe('')` seule, sans jamais vérifier la relâche. Une borne trop
      // courte ne durcit pas ce test, elle l'éteint.
      const bloc =
        /try \{[\s\S]{0,2000}?buildSystemPrompt\([\s\S]{0,600}?\} catch[\s\S]{0,200}?\}/.exec(
          src,
        )?.[0] ?? '';
      expect(bloc, `${rel} : l'assemblage du prompt n'a pas de filet`).not.toBe('');
      expect(bloc, `${rel} : les verrous fuient si le prompt échoue`).toMatch(
        /(releaseHeld\(\)|locks\.release\(\))/,
      );
    }
  });

  it('le chat construit la MÊME liste de dossiers que le job — partagé compris', () => {
    // Constat de la revue Codex (27/08). Le partagé n'a AUCUNE ligne en base :
    // il est fabriqué à l'exécution, et seul `execute.ts` l'ajoutait. Depuis le
    // chat du tableau de bord, un agent en runtime CLI ne pouvait donc ni lire
    // ni écrire les fichiers de transmission de l'équipe — et un agent SANS
    // dossier attaché y échouait en `workspace_not_configured` alors que ses
    // jobs tournaient très bien. Deux points d'entrée, deux réalités.
    for (const rel of [
      'apps/runner/src/job/execute.ts',
      'apps/runner/src/cli-runtime/run-chat.ts',
    ]) {
      const src = read(rel);
      expect(src, `${rel} : le partagé n'est pas ajouté`).toContain('ensureSharedWorkspace(');
      expect(src, `${rel} : la liste n'est pas résolue`).toContain('resolveWorkspaceList(');
    }
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
