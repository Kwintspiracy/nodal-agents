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

  it('à la REPRISE, la persona n’est PAS renvoyée — la session la porte déjà', () => {
    // La repasser en ferait un message utilisateur dupliqué à chaque tour, payé
    // à chaque tour. Chez Claude c'est un prompt SYSTÈME, d'où la différence.
    const stdin = buildCodexStdin({
      message: 'et maintenant ?',
      personality: 'You are Reviewer C.',
      resumeSessionId: 'th_1',
    });
    expect(stdin).toBe('et maintenant ?');
    expect(stdin).not.toContain('Reviewer C');
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
