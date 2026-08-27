// codex-turn.test.ts — le lecteur de flux et le constructeur d'argv du runtime
// Codex, éprouvés sur un flux RÉEL enregistré.
//
// `codex-stream-fixture.jsonl` a été capturé le 27/08 en lançant vraiment
// `codex exec --json --sandbox read-only --skip-git-repo-check
// --ignore-user-config -` dans un dossier temporaire contenant un `note.txt`,
// avec pour consigne d'en lire le contenu. Le tour a exécuté une commande et
// répondu : la fixture porte donc une paire d'outil appariée ET un message.
// Même discipline que le jumeau Claude : on teste sur ce que la CLI a imprimé,
// jamais sur ce qu'une page d'aide promet.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexTurnArgs,
  buildCodexStdin,
  handleCodexLine,
  newCodexParseState,
  finishCodexTurn,
  CODEX_PERSONA_HEADER,
  normalizeCodexToolInput,
  type CodexTurnEvent,
  type CodexTurnOptions,
} from '../../cli-runtime/codex-turn.ts';

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'codex-stream-fixture.jsonl'),
  'utf8',
);

const BASE: CodexTurnOptions = {
  message: 'lis note.txt',
  personality: 'You are Reviewer C.',
  cwd: 'C:/work',
  mode: 'read',
  timeoutMs: 60_000,
};

function replay(): { state: ReturnType<typeof newCodexParseState>; events: CodexTurnEvent[] } {
  const state = newCodexParseState();
  const events: CodexTurnEvent[] = [];
  for (const line of FIXTURE.split('\n')) handleCodexLine(state, line, (e) => events.push(e));
  return { state, events };
}

describe('handleCodexLine sur le flux réel enregistré', () => {
  it('extrait la session, les événements d’outils appariés, et la réponse', () => {
    const { state, events } = replay();

    expect(state.sessionId, 'sans thread_id, aucune reprise n’est possible').toBe(
      '01a03f0e-36f0-7261-bdf5-b99dea835eb7',
    );
    expect(state.messages).toEqual(['la reponse est 42']);
    expect(state.sawTurnCompleted).toBe(true);
    expect(state.failure).toBeNull();

    // L'appariement est ce qui alimente les lignes tool_calls de la page Runs :
    // un `use` ouvre, un `result` ferme, par l'identifiant de la CLI.
    const use = events.find((e) => e.kind === 'tool_use');
    const result = events.find((e) => e.kind === 'tool_result');
    expect(use?.toolUseId).toBe('item_0');
    expect(use?.toolName).toBe('command_execution');
    expect(result?.toolUseId, 'un résultat non apparié laisserait la ligne ouverte').toBe('item_0');

    // Le texte de l'agent est aussi surfacé en direct.
    expect(events.some((e) => e.kind === 'assistant_text' && e.text === 'la reponse est 42')).toBe(
      true,
    );
  });

  it('l’usage est rendu ENTRÉE HORS CACHE — la sémantique OpenAI compte le cache dedans', () => {
    // 30744 déclarés dont 26112 en cache : l'entrée réelle est 4632. Rendre le
    // brut gonflerait le compteur de jetons de 5,6× sur ce tour, et la page
    // d'usage mentirait dans le sens le plus coûteux.
    const { state } = replay();
    const turn = finishCodexTurn(state, 0, false, 1234, '');
    expect(turn.usage?.inputTokens).toBe(30744 - 26112);
    expect(turn.usage?.cachedTokens).toBe(26112);
    expect(turn.usage?.outputTokens).toBe(90);
  });

  it('aucun coût inventé : Codex n’en rapporte pas, le champ reste null', () => {
    // Un 0 se lirait « ce tour était gratuit » ; c'est faux, il est simplement
    // non mesuré. Invariant #4.
    const { state } = replay();
    expect(finishCodexTurn(state, 0, false, 10, '').costUsd).toBeNull();
    expect(finishCodexTurn(state, 0, false, 10, '').modelUsage).toBeNull();
  });

  it('un flux coupé AVANT turn.completed est une panne, pas un tour vide', () => {
    // Le cas qui compte : la CLI est morte en route. Rendre le texte partiel
    // comme une réponse ferait passer une session interrompue pour un travail
    // fini — exactement ce qu'on refuse de faire croire à l'utilisateur.
    const state = newCodexParseState();
    for (const line of FIXTURE.split('\n').slice(0, 5)) handleCodexLine(state, line);
    const turn = finishCodexTurn(state, null, false, 10, 'boom');

    expect(turn.isError, 'un flux coupé passe pour un tour réussi').toBe(true);
    expect(turn.errorDetail).toContain('cli_stream_incomplete');
  });

  it('turn.failed est rapporté tel quel, jamais réécrit', () => {
    const state = newCodexParseState();
    handleCodexLine(state, '{"type":"thread.started","thread_id":"t1"}');
    handleCodexLine(state, '{"type":"turn.failed","error":{"message":"quota exceeded"}}');
    const turn = finishCodexTurn(state, 1, false, 10, '');
    expect(turn.isError).toBe(true);
    expect(turn.errorDetail).toContain('quota exceeded');
  });

  it('les types d’événements inconnus sont collectés, jamais devinés', () => {
    const state = newCodexParseState();
    handleCodexLine(state, '{"type":"quelque.chose.de.neuf"}');
    expect(state.unknownEventTypes.has('quelque.chose.de.neuf')).toBe(true);
  });

  it('un tour RÉUSSI ne signale AUCUNE dérive de protocole', () => {
    // Constat P2 de la revue Codex (27/08). `turn.started` est dans tous les
    // flux réels — la fixture comprise — et n'avait pas de branche : chaque tour
    // réussi journalisait « CLI drift? ». Un avertissement qui se déclenche
    // toujours ne signale plus rien, et c'est la VRAIE dérive qu'il noie.
    const { state } = replay();
    expect(
      [...state.unknownEventTypes],
      'un flux parfaitement normal est signalé comme une dérive',
    ).toEqual([]);
  });

  it('le garde anti-boucle est nourri par les DÉBUTS d’outils, pas par les fins', () => {
    // `handleCodexLine` rend `true` pour qu'un tour parti en boucle soit tué
    // (invariant #8). Compter aussi les fins doublerait le compte et tuerait un
    // tour honnête à la moitié du plafond.
    const state = newCodexParseState();
    const lines = FIXTURE.split('\n').filter((l) => l.trim() !== '');
    const flags = lines.map((l) => handleCodexLine(state, l));
    expect(flags.filter(Boolean)).toHaveLength(1);
  });

  it('TOUT appel d’outil compte pour le garde anti-boucle, pas seulement ceux qu’on audite', () => {
    // Constat P1 de la revue Codex (27/08). Le compteur suivait
    // `parseLiveToolEvent`, qui ne reconnaît que `command_execution` et
    // `file_change` — alors que les symboles du binaire (codex-cli 0.148.0) en
    // listent sept de plus. Une session bouclant sur `web_search` ou
    // `mcp_tool_call` n'incrémentait RIEN et dépassait le plafond de
    // l'invariant #8 en silence.
    const state = newCodexParseState();
    for (const type of ['web_search', 'mcp_tool_call', 'todo_list', 'dynamic_tool_call']) {
      const line = `{"type":"item.started","item":{"id":"i_${type}","type":"${type}"}}`;
      expect(handleCodexLine(state, line), `${type} ne compte pas comme un appel d'outil`).toBe(
        true,
      );
    }
    // Un type INÉDIT compte aussi : la liste des outils grandit à chaque
    // version, celle de ce qui n'en est pas est stable. Un garde-fou doit
    // serrer un peu trop, jamais pas assez.
    expect(
      handleCodexLine(state, '{"type":"item.started","item":{"id":"i_x","type":"outil_de_2027"}}'),
    ).toBe(true);
    // Et ce qui n'est PAS un outil ne gonfle pas le compteur.
    expect(
      handleCodexLine(state, '{"type":"item.started","item":{"id":"i_m","type":"agent_message"}}'),
    ).toBe(false);
  });

  it('un file_change devient lisible par les surfaces Code — sinon l’écriture est invisible', () => {
    // Constat P1 de la revue Codex (27/08). Codex porte ses fichiers dans un
    // tableau `changes` ; l'onglet Code et le contexte des projets cherchent un
    // `file_path` direct. Sans traduction, les écritures d'un agent Codex en
    // mode écriture n'apparaissaient NULLE PART.
    const item = {
      id: 'item_1',
      type: 'file_change',
      changes: [
        { path: 'C:/Dev/app/index.html', kind: 'update' },
        { path: 'C:/Dev/app/style.css', kind: 'add' },
      ],
    };
    const out = normalizeCodexToolInput('file_change', item) as Record<string, unknown>;
    expect(out['file_path']).toBe('C:/Dev/app/index.html');
    // L'item d'origine est conservé : la traduction ajoute, elle n'efface pas.
    expect(out['changes']).toBe(item.changes);

    // Et surtout : elle est BRANCHÉE sur le flux. Prouver la fonction seule
    // laisserait passer un câblage oublié — c'est-à-dire toute la panne, la
    // fonction restant parfaite dans son coin.
    const state = newCodexParseState();
    const events: CodexTurnEvent[] = [];
    handleCodexLine(state, JSON.stringify({ type: 'item.started', item }), (e) => events.push(e));
    const use = events.find((e) => e.kind === 'tool_use');
    expect(
      (use?.input as Record<string, unknown> | undefined)?.['file_path'],
      'la normalisation n’est pas appliquée au flux',
    ).toBe('C:/Dev/app/index.html');
  });

  it('un file_change SANS chemin reconnaissable n’en invente aucun', () => {
    // La forme vient des symboles du binaire, pas d'un flux réel — le mode
    // écriture n'a pas pu être observé sur cette machine. Donc : on lit ce qui
    // est là, et rien de plus. Un mauvais chemin fabriquerait un projet fantôme
    // dans l'onglet, ce qui est pire qu'une ligne sans chemin.
    const item = { id: 'item_1', type: 'file_change', changes: [{ kind: 'update' }] };
    expect(normalizeCodexToolInput('file_change', item)).toBe(item);
    // Et les autres outils traversent intacts.
    const cmd = { id: 'i', type: 'command_execution', command: 'ls' };
    expect(normalizeCodexToolInput('command_execution', cmd)).toBe(cmd);
  });

  it('un file_change qui n’arrive QU’EN FIN produit quand même une ligne complète', () => {
    // Constat P1 de la revue Codex (27/08). Codex rapporte normalement un
    // `file_change` en `item.completed` SEUL. Le recorder apparie par
    // identifiant : sans `tool_use` ouvert, il jetait l'événement, et
    // l'écriture disparaissait de l'onglet Code comme du contexte des projets.
    const state = newCodexParseState();
    const events: CodexTurnEvent[] = [];
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_9',
        type: 'file_change',
        changes: [{ path: 'C:/Dev/app/index.html', kind: 'update' }],
      },
    });

    // Il compte AUSSI pour le garde anti-boucle : une session qui n'écrit que
    // des fichiers ne consommait aucun budget.
    expect(handleCodexLine(state, line, (e) => events.push(e))).toBe(true);

    const use = events.find((e) => e.kind === 'tool_use');
    const result = events.find((e) => e.kind === 'tool_result');
    expect(use, 'aucune ouverture : la ligne d’audit ne sera jamais écrite').toBeTruthy();
    expect(result?.toolUseId).toBe(use?.toolUseId);
    expect((use?.input as Record<string, unknown>)['file_path']).toBe('C:/Dev/app/index.html');
  });

  it('un changement MULTI-FICHIERS produit une ligne PAR fichier', () => {
    // Constat P2 de la revue Codex (27/08). Les extracteurs de l'onglet Code et
    // du contexte des projets lisent `file_path`, au singulier. Ranger les
    // autres chemins dans un champ que personne ne lit revenait à ne compter que
    // le premier fichier — et à perdre entièrement les éditions appartenant à un
    // autre projet.
    const state = newCodexParseState();
    const events: CodexTurnEvent[] = [];
    handleCodexLine(
      state,
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_9',
          type: 'file_change',
          changes: [
            { path: 'C:/Dev/app/index.html', kind: 'update' },
            { path: 'C:/Dev/autre/main.py', kind: 'add' },
          ],
        },
      }),
      (e) => events.push(e),
    );

    const uses = events.filter((e) => e.kind === 'tool_use');
    expect(uses, 'un seul fichier compté sur les deux').toHaveLength(2);
    expect(uses.map((u) => (u.input as Record<string, unknown>)['file_path'])).toEqual([
      'C:/Dev/app/index.html',
      'C:/Dev/autre/main.py',
    ]);
    // Chaque ligne s'apparie avec SA fin : un identifiant partagé ferait
    // s'écraser les deux dans la table d'appariement.
    expect(new Set(uses.map((u) => u.toolUseId)).size).toBe(2);
    expect(events.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
  });

  it('un multi-fichiers ouvert PUIS fermé s’apparie ligne à ligne', () => {
    // Constat P2 de la revue Codex (27/08). Quand Codex émet les DEUX
    // événements, le début ouvrait `id#0`, `id#1`… et la fin ne fermait que
    // `id` : le recorder n'appariait AUCUNE ligne, et toutes les éditions
    // disparaissaient de l'audit. Le correctif du tour précédent avait déplacé
    // la panne au lieu de la fermer.
    const item = {
      id: 'item_3',
      type: 'file_change',
      changes: [
        { path: 'C:/Dev/app/a.ts', kind: 'update' },
        { path: 'C:/Dev/app/b.ts', kind: 'update' },
      ],
    };
    const state = newCodexParseState();
    const events: CodexTurnEvent[] = [];
    handleCodexLine(state, JSON.stringify({ type: 'item.started', item }), (e) => events.push(e));
    handleCodexLine(state, JSON.stringify({ type: 'item.completed', item }), (e) => events.push(e));

    const uses = events.filter((e) => e.kind === 'tool_use');
    const results = events.filter((e) => e.kind === 'tool_result');
    expect(uses).toHaveLength(2);
    // Chaque ouverture a SA fermeture, sur le même identifiant.
    expect(results.map((r) => r.toolUseId).sort()).toEqual(uses.map((u) => u.toolUseId).sort());
    // Et le début ne se rouvre pas une seconde fois à la fermeture.
    expect(uses.filter((u) => u.toolUseId === results[0]!.toolUseId)).toHaveLength(1);
  });

  it('un file_change en ÉCHEC ne compte pas comme un fichier changé', () => {
    // Constat de la revue Codex (27/08). Codex dit son échec dans un champ
    // `status` que personne ne lit : les surfaces Code ne reconnaissent que
    // `<tool_use_error>` et `{"ok":false}`. Un changement échoué était donc
    // compté comme un fichier CHANGÉ, affiché dans le panneau Changes, et
    // pouvait faire naître un projet dans le contexte des agents — un travail
    // qui n'a jamais eu lieu, annoncé comme fait.
    const state = newCodexParseState();
    const events: CodexTurnEvent[] = [];
    handleCodexLine(
      state,
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_5',
          type: 'file_change',
          status: 'failed',
          changes: [{ path: 'C:/Dev/app/a.ts', kind: 'update' }],
        },
      }),
      (e) => events.push(e),
    );

    const result = events.find((e) => e.kind === 'tool_result');
    expect(result?.output, 'un échec passe pour une écriture réussie').toContain(
      '<tool_use_error>',
    );
    // La sortie d'origine reste derrière l'enveloppe : l'audit doit rester
    // lisible, pas se réduire à un marqueur.
    expect(result?.output).toContain('file_change');
  });

  it('un file_change RÉUSSI n’est pas marqué comme refusé', () => {
    // Le pendant : marquer trop large ferait disparaître du vrai travail de
    // l'onglet Code — l'inverse exact du défaut qu'on répare.
    const state = newCodexParseState();
    const events: CodexTurnEvent[] = [];
    handleCodexLine(
      state,
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_6',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: 'C:/Dev/app/a.ts', kind: 'update' }],
        },
      }),
      (e) => events.push(e),
    );
    expect(events.find((e) => e.kind === 'tool_result')?.output).not.toContain('<tool_use_error>');
  });

  it('un tour TUÉ par le délai est un échec, même s’il avait dit turn.completed', () => {
    // Constat P2 de la revue Codex (27/08). Le flux était complet, le code de
    // sortie null : le job se terminait « réussi » alors qu'on venait de tuer le
    // processus. Ce qui est livré porterait le travail d'un tour interrompu.
    const { state } = replay();
    const turn = finishCodexTurn(state, null, true, 900_000, '');
    expect(turn.isError, 'un tour tué passe pour un tour réussi').toBe(true);
    expect(turn.errorDetail).toContain('cli_timeout');
  });

  it('les dossiers SECONDAIRES sont ouverts en écriture, et `-` reste en dernier', () => {
    // Constat P1 de la revue Codex (27/08). `cwd` n'est que le premier dossier :
    // sans `--add-dir`, un agent multi-dossiers voit les autres annoncés dans
    // son prompt et se les voit refuser à l'écriture. Le prompt promettait ce
    // que le bac à sable interdisait.
    const args = buildCodexTurnArgs({
      ...BASE,
      mode: 'write',
      extraWriteDirs: ['C:/Dev/autre', 'C:/Notes'],
    });
    expect(args[args.indexOf('--add-dir') + 1]).toBe('C:/Dev/autre');
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    // `-` EN DERNIER, sans quoi les instructions ne sont plus lues sur stdin.
    expect(args[args.length - 1]).toBe('-');

    // En lecture seule il n'y a rien à ouvrir : le mode interdit déjà d'écrire.
    expect(buildCodexTurnArgs({ ...BASE, extraWriteDirs: ['C:/Dev/autre'] })).not.toContain(
      '--add-dir',
    );
  });

  it('le plafond d’outils atteint force l’erreur, même si le tour s’est terminé', () => {
    const { state } = replay();
    const turn = finishCodexTurn(state, 0, false, 10, '', 50);
    expect(turn.isError).toBe(true);
    expect(turn.errorDetail).toContain('tool_call_limit_exceeded');
  });
});

describe('buildCodexStdin', () => {
  it('au PREMIER tour, la persona précède la demande — Codex n’a pas de drapeau pour ça', () => {
    // Mesuré sur le binaire installé (`codex exec --help`, 27/08) : ni drapeau
    // de prompt système, ni fichier d'instructions. Sans cet en-tête, les deux
    // textes se touchent et la personnalité se lit comme le début de la tâche.
    const stdin = buildCodexStdin({ message: 'lis note.txt', personality: 'You are Reviewer C.' });
    expect(stdin).toContain(CODEX_PERSONA_HEADER);
    expect(stdin.indexOf('You are Reviewer C.')).toBeLessThan(stdin.indexOf('lis note.txt'));
  });

  it('le prompt est renvoyé à CHAQUE tour — il porte ce qui BOUGE entre deux tours', () => {
    // Ce test disait l'inverse : la persona était omise à la reprise, « la
    // session la porte déjà ». La revue Codex (27/08) a montré l'erreur — ce
    // texte n'est pas qu'une personnalité, il porte la mémoire, l'équipe, les
    // dossiers et l'instantané git. L'omettre gelait l'agent sur l'état du
    // PREMIER message : un fichier ajouté, un coéquipier attaché, une branche
    // changée restaient invisibles jusqu'à la fin du fil.
    const stdin = buildCodexStdin({
      message: 'et maintenant ?',
      personality: 'You are Reviewer C. Current branch: feat/x',
    });
    expect(stdin, 'un tour de reprise travaille sur un contexte périmé').toContain(
      'Current branch: feat/x',
    );
    expect(stdin).toContain('et maintenant ?');
  });
});

describe('buildCodexTurnArgs', () => {
  it('lecture seule : bac à sable read-only, config de l’utilisateur ignorée, prompt par STDIN', () => {
    const args = buildCodexTurnArgs(BASE);
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toContain('--ignore-user-config');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    // `-` EN DERNIER : c'est ce qui fait lire les instructions sur stdin.
    expect(args[args.length - 1]).toBe('-');
  });

  it('mode écriture : le bac à sable devient workspace-write', () => {
    const args = buildCodexTurnArgs({ ...BASE, mode: 'write' });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });

  it('la reprise change la FORME de l’argv : `resume` est une sous-commande', () => {
    // Et elle refuse `--sandbox`, d'où le passage par `-c`. C'est la
    // différence structurelle avec `--resume` de Claude, qui n'est qu'un
    // drapeau.
    const args = buildCodexTurnArgs({ ...BASE, resumeSessionId: 'th_42' });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'th_42']);
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('sandbox_mode="read-only"');
  });

  it('une restriction d’outils fait ÉCHOUER le tour — jamais un lancement sans elle', () => {
    // Constat P1 de la revue Codex (27/08). La première version se contentait
    // de journaliser et lançait la CLI sans restriction : basculer un agent
    // restreint de Claude Code vers Codex lui RENDAIT les outils qu'on lui
    // avait explicitement retirés. En mode écriture, une élévation de
    // permissions obtenue par un menu déroulant.
    expect(() => buildCodexTurnArgs({ ...BASE, extraDisallowed: ['Bash'] })).toThrow(
      /codex_cannot_restrict_tools/,
    );
    // Le message doit nommer ce qui est interdit et dire quoi faire.
    expect(() => buildCodexTurnArgs({ ...BASE, extraDisallowed: ['Bash', 'WebSearch'] })).toThrow(
      /Bash, WebSearch/,
    );
    // Une liste VIDE n'est pas une restriction : elle ne bloque rien.
    expect(() => buildCodexTurnArgs({ ...BASE, extraDisallowed: [] })).not.toThrow();
  });

  it('modèle et effort n’apparaissent que s’ils sont demandés', () => {
    expect(buildCodexTurnArgs(BASE)).not.toContain('-m');
    const args = buildCodexTurnArgs({ ...BASE, model: 'gpt-5', effort: 'high' });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5');
    expect(args).toContain('model_reasoning_effort="high"');
  });
});
