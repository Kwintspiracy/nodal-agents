// cli-turn-no-mcp.test.ts — un tour d'agent en runtime CLI n'a AUCUN serveur MCP
// (#453, revue Codex passe 3).
//
// Codex supposait qu'un agent en runtime CLI du dashboard pouvait appeler
// `run_task` par MCP et contourner la garde de #453. Vérifié dans le code :
// le chat ET le job (`run-chat.ts`, `run-job.ts`) passent tous deux par
// `resolveRuntime`, qui ne connaît que `runClaudeTurn` et `runCodexTurn`, et
// ces deux-là construisent leur argv par `buildClaudeTurnArgs` /
// `buildCodexTurnArgs`, sans rien y ajouter d'autre que le lanceur.
//
//   - Claude : `--strict-mcp-config` SANS `--mcp-config` — seuls les serveurs
//     d'un `--mcp-config` sont chargés, et il n'y en a aucun. Le `nodal` que
//     `claude mcp add` pose dans la config de l'utilisateur (#485) est ignoré.
//   - Codex : `--ignore-user-config` — le ~/.codex/config.toml, où vivent ses
//     `mcp_servers`, n'est pas lu (`-c mcp_servers={}` ne suffisait pas : la
//     table vide FUSIONNE, mesuré le 21/08, providers.ts).
//
// Ce test FIGE cette forme sur tous les modes, avec et sans reprise, sous
// Windows et ailleurs. Un argv qui gagnerait un serveur MCP rougit ici.
//
// Mutations vérifiées : `--strict-mcp-config` retiré de claude-turn.ts, et
// `--ignore-user-config` retiré de providers.ts → rouge.

import { describe, it, expect } from 'vitest';
import { buildClaudeTurnArgs, runClaudeTurn } from '../../cli-runtime/claude-turn.ts';
import { buildCodexTurnArgs, runCodexTurn } from '../../cli-runtime/codex-turn.ts';
import { resolveRuntime } from '../../cli-runtime/provider.ts';

const modes = ['read', 'write'] as const;
const reprises = [undefined, 'sess-1'] as const;

describe('un tour CLI n’a aucun serveur MCP (#453, revue Codex passe 3) @cap:parler-a-un-agent/moteur', () => {
  it('les deux runtimes du chat et du job sont ces deux tours-là, et eux seuls', () => {
    expect(resolveRuntime('claude-code')?.run).toBe(runClaudeTurn);
    expect(resolveRuntime('codex')?.run).toBe(runCodexTurn);
  });

  it('Claude : --strict-mcp-config, et jamais de --mcp-config', () => {
    for (const mode of modes) {
      for (const resumeSessionId of reprises) {
        const args = buildClaudeTurnArgs(
          {
            message: 'lance le changelog',
            personality: 'Tu es Alfred.',
            cwd: 'D:\\ws',
            mode,
            shellTools: [],
            timeoutMs: 1000,
            ...(resumeSessionId ? { resumeSessionId } : {}),
          },
          'D:\\tmp\\persona.txt',
        );
        expect(args, `${mode} ${resumeSessionId ?? ''}`).toContain('--strict-mcp-config');
        expect(args.some((a) => a.startsWith('--mcp-config'))).toBe(false);
      }
    }
  });

  it('Codex : --ignore-user-config, et aucun mcp_servers passé en -c', () => {
    for (const mode of modes) {
      for (const resumeSessionId of reprises) {
        const args = buildCodexTurnArgs({
          message: 'lance le changelog',
          personality: 'You are Alfred.',
          cwd: 'C:/work',
          mode,
          shellTools: [],
          timeoutMs: 1000,
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
        expect(args, `${mode} ${resumeSessionId ?? ''}`).toContain('--ignore-user-config');
        expect(args.some((a) => /mcp/i.test(a))).toBe(false);
      }
    }
  });
});
