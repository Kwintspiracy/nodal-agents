// code-task-live-events.test.ts — une session code_task doit être VISIBLE
// pendant qu'elle tourne, pas seulement une fois finie.
//
// Le défaut : `executeTool` écrit sa ligne d'audit APRÈS que l'outil a rendu la
// main, donc un code_task de quinze minutes laisse l'onglet Code vide pendant
// quinze minutes. Le chemin runtime, lui, écrit une ligne par événement au fil
// du flux (run-job.ts). Cette asymétrie est ce que ce fichier verrouille.

import { describe, it, expect } from 'vitest';
import { parseLiveToolEvent, makeEssentialCapture } from '../builtin/code-task/live-events';
import {
  buildProviderArgs,
  parseClaudeOutput,
  parseCodexOutput,
} from '../builtin/code-task/providers';

describe('parseLiveToolEvent — claude', () => {
  it('reconnaît un tool_use dans le contenu du message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'je regarde' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    });
    const r = parseLiveToolEvent('claude', line);
    expect(r?.kind).toBe('use');
    expect(r?.event.id).toBe('tu_1');
    expect(r?.event.name).toBe('Read');
    expect(r?.event.input).toEqual({ file_path: 'a.ts' });
  });

  it('reconnaît un tool_result et le rattache par son id', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contenu du fichier' }],
      },
    });
    const r = parseLiveToolEvent('claude', line);
    expect(r?.kind).toBe('result');
    expect(r?.event.id).toBe('tu_1');
    expect(r?.event.output).toBe('contenu du fichier');
  });

  it("ne renvoie RIEN pour une ligne qui n'est pas un outil", () => {
    // Bannières d'init, texte de l'assistant, totaux d'usage : tout ça passe
    // dans le même flux. Les transformer en lignes d'audit remplirait l'onglet
    // Code de bruit qui n'est pas de l'exécution.
    const texte = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'voilà' }] },
    });
    expect(parseLiveToolEvent('claude', texte)).toBeNull();
    expect(
      parseLiveToolEvent('claude', JSON.stringify({ type: 'system', subtype: 'init' })),
    ).toBeNull();
  });
});

describe('parseLiveToolEvent — codex', () => {
  it('reconnaît le début et la fin d’une commande, avec le même id', () => {
    const debut = JSON.stringify({
      type: 'item.started',
      item: { id: 'it_9', type: 'command_execution', command: 'pnpm test' },
    });
    const fin = JSON.stringify({
      type: 'item.completed',
      item: { id: 'it_9', type: 'command_execution', command: 'pnpm test', exit_code: 0 },
    });
    const a = parseLiveToolEvent('codex', debut);
    const b = parseLiveToolEvent('codex', fin);
    expect(a?.kind).toBe('use');
    expect(b?.kind).toBe('result');
    expect(a?.event.id).toBe(b?.event.id);
  });

  it('ignore les types d’item qui ne sont pas de l’exécution', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'it_1', type: 'agent_message', text: 'fini' },
    });
    expect(parseLiveToolEvent('codex', line)).toBeNull();
  });
});

describe('robustesse', () => {
  it('une ligne non-JSON ne casse rien', () => {
    // Ce crochet est de l'observabilité au mieux : l'analyse qui fait autorité
    // reste celle de fin de flux. Lever ici tuerait la session qu'on observe.
    expect(parseLiveToolEvent('claude', 'pas du json')).toBeNull();
    expect(parseLiveToolEvent('codex', '{"incomplet":')).toBeNull();
  });
});

describe("l'argv demande bien le flux que le parseur attend", () => {
  // LE test qui manquait, et qui a coûté un constat bloquant : les tests
  // ci-dessus nourrissent `parseLiveToolEvent` avec une ligne `stream-json`
  // synthétique, sans jamais vérifier ce que le CLI produit RÉELLEMENT.
  //
  // code_task lançait claude avec `--output-format json` — UN objet agrégé à la
  // fin. Le parseur ne matchait donc jamais rien, et l'absence de ligne
  // ressemble exactement à une session sans outil. Cinquième fois dans ce lot
  // qu'un test valide la pièce sans valider le câblage.
  it('claude : stream-json ET --verbose, jamais le json agrégé', () => {
    const args = buildProviderArgs('claude', 'read');
    const i = args.indexOf('--output-format');
    expect(i, '--output-format absent').toBeGreaterThan(-1);
    expect(args[i + 1], 'le json agrégé ne peut PAS être observé en direct').toBe('stream-json');
    // stream-json n'émet le flux complet en mode print qu'avec --verbose.
    expect(args, '--verbose manque : le flux reste muet').toContain('--verbose');
  });

  it('codex : --json, le mode JSONL', () => {
    expect(buildProviderArgs('codex', 'read')).toContain('--json');
  });
});

describe('le résultat survit à un flux plus gros que le tampon', () => {
  // Constat bloquant de la passe 2, et une régression que J'AI introduite :
  // `--output-format json` produisait un objet compact ; `stream-json --verbose`
  // produit tout le flux d'événements, sorties d'outils comprises. Le tampon de
  // runCli est plafonné et coupe la FIN — précisément où vit `type:"result"`.
  // Une session longue aurait donc échoué sur « stream ended without a result
  // event » après avoir parfaitement tourné.
  it('capture le résultat même quand des milliers de lignes de bruit le précèdent', () => {
    const cap = makeEssentialCapture('claude');
    for (let i = 0; i < 5000; i++) {
      cap.onLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x'.repeat(200) }] },
        }),
      );
    }
    cap.onLine(JSON.stringify({ type: 'result', result: 'FINI', session_id: 's1' }));

    const parsed = parseClaudeOutput(cap.transcript());
    expect(parsed.resultText, 'le résultat a été noyé dans le bruit').toBe('FINI');
    expect(parsed.sessionId).toBe('s1');
  });

  it('garde la FIN, pas le début, quand le plafond de lignes essentielles tombe', () => {
    // Le résultat est le dernier événement : jeter le début est correct, jeter
    // la fin serait exactement le bug qu'on répare.
    const cap = makeEssentialCapture('claude');
    for (let i = 0; i < 5000; i++) {
      cap.onLine(JSON.stringify({ type: 'result', result: `tour-${i}` }));
    }
    expect(parseClaudeOutput(cap.transcript()).resultText).toBe('tour-4999');
  });

  it('codex : garde thread.started et turn.completed, jette les sorties d’outils', () => {
    const cap = makeEssentialCapture('codex');
    cap.onLine(JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }));
    cap.onLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'command_execution', output: 'y'.repeat(50_000) },
      }),
    );
    cap.onLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i2', type: 'agent_message', text: 'la réponse' },
      }),
    );
    cap.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }));

    const t = cap.transcript();
    expect(t, "la grosse sortie d'outil a été retenue").not.toContain('yyyy');
    const parsed = parseCodexOutput(t);
    expect(parsed.sessionId).toBe('th_1');
    expect(parsed.resultText).toBe('la réponse');
  });
});

describe('codex : le sessionId survit au plafond', () => {
  it('garde thread.started même noyé sous des milliers de lignes', () => {
    // Constat de la passe 3 : « jeter le début » est correct pour claude, dont
    // la ligne utile est terminale. C'est FAUX pour codex — `thread.started`
    // arrive en PREMIER et porte le sessionId. Sans épinglage, un tour bavard
    // rendait `sessionId: null`, l'analyse réussissait quand même, et la reprise
    // de session devenait impossible en silence.
    const cap = makeEssentialCapture('codex');
    cap.onLine(JSON.stringify({ type: 'thread.started', thread_id: 'th_survivant' }));
    for (let i = 0; i < 5000; i++) {
      cap.onLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: `i${i}`, type: 'agent_message', text: `m${i}` },
        }),
      );
    }
    cap.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }));

    const parsed = parseCodexOutput(cap.transcript());
    expect(parsed.sessionId, 'le sessionId a été évincé — plus de reprise possible').toBe(
      'th_survivant',
    );
  });
});

describe("l'épinglage ne devient pas une fuite", () => {
  it("ne garde que le PREMIER thread.started, même s'il en pleut", () => {
    // Constat de la passe 4 : épingler sans limite rouvrait la fuite que la
    // fenêtre glissante ferme. Un CLI défectueux — ou une sortie hostile —
    // répétant l'ouverture accumulait toutes ses lignes, chacune pouvant
    // approcher les 200 000 caractères du plafond amont.
    const cap = makeEssentialCapture('codex');
    for (let i = 0; i < 10_000; i++) {
      cap.onLine(JSON.stringify({ type: 'thread.started', thread_id: `th_${i}` }));
    }
    cap.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }));

    const t = cap.transcript();
    const occurrences = t.split('thread.started').length - 1;
    expect(occurrences, `${occurrences} ouvertures retenues au lieu d'une`).toBe(1);
    // Et c'est bien la PREMIÈRE — celle qui porte le vrai fil.
    expect(parseCodexOutput(t).sessionId).toBe('th_0');
  });
});
