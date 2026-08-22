// code-task-live-events.test.ts — une session code_task doit être VISIBLE
// pendant qu'elle tourne, pas seulement une fois finie.
//
// Le défaut : `executeTool` écrit sa ligne d'audit APRÈS que l'outil a rendu la
// main, donc un code_task de quinze minutes laisse l'onglet Code vide pendant
// quinze minutes. Le chemin runtime, lui, écrit une ligne par événement au fil
// du flux (run-job.ts). Cette asymétrie est ce que ce fichier verrouille.

import { describe, it, expect } from 'vitest';
import { parseLiveToolEvent } from '../builtin/code-task/live-events';
import { buildProviderArgs } from '../builtin/code-task/providers';

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
